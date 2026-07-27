/**
 * OWNER: agent "props".
 *
 * Three materials carry the entire prop set. They are stock MeshStandardMaterial
 * — so they inherit whatever the atmosphere owner does with lights, fog, tone
 * mapping and env map for free — patched through onBeforeCompile with:
 *
 *   - world normal / world position varyings
 *   - snow accumulation on upward-facing surfaces, broken up by world noise
 *   - a cloth wave driven by the per-vertex `aWave` mask, so banners and
 *     pennants flap while the poles holding them stay rigid
 *
 * NB: GLSL ES 3.0 reserved words (patch, sample, filter, active, ...) are
 * avoided throughout; every identifier here is prefixed `p`.
 */

import * as THREE from 'three';
import { propAtlas } from './propTextures.js';
import { barkNeedleAtlas, coniferAtlas } from './treeTextures.js';

export const propTime = { value: 0 };
export const propWind = { value: 1.0 };

// --------------------------------------------------------------------------
// aerial perspective
// --------------------------------------------------------------------------
/**
 * The atmosphere owner publishes its aerial-perspective chunk and uniform block
 * on `sky.fogParams`. Splicing it in is what makes a tree line at 900 m dissolve
 * into the same colour as the sky above it instead of sitting on top of it as a
 * dark cut-out. Entirely optional: if the handle is not there we just skip it.
 */
let AERIAL = null;
export function useAerial(fogParams) {
  if (fogParams && fogParams.glsl && fogParams.aerial) AERIAL = fogParams;
}

function spliceAerial(shader, worldVarying) {
  if (!AERIAL || shader.__skyAerial) return;
  if (!shader.fragmentShader.includes('#include <opaque_fragment>')) return;
  shader.__skyAerial = true;
  Object.assign(shader.uniforms, AERIAL.aerial);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', '#include <common>\n' + AERIAL.glsl)
    .replace('#include <opaque_fragment>',
      '#include <opaque_fragment>\ngl_FragColor.rgb = skyAerialPerspective( gl_FragColor.rgb, '
      + worldVarying + ' );');
}

const PROP_HEAD = /* glsl */`
  varying vec3 vPropN;
  varying vec3 vPropW;
`;

const PROP_NOISE = /* glsl */`
  float pHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
  float pNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(pHash(i), pHash(i + vec2(1.0, 0.0)), f.x),
               mix(pHash(i + vec2(0.0, 1.0)), pHash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
`;

/**
 * Patch a standard material. `opts`:
 *   snow    0..1 amount of accumulation on up-facing surfaces
 *   wave    metres of cloth travel at aWave = 1
 */
export function patchProp(mat, { snow = 0.0, wave = 0.0 } = {}) {
  mat.userData.propSnow = { value: snow };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uPropTime = propTime;
    shader.uniforms.uPropWind = propWind;
    shader.uniforms.uPropSnow = mat.userData.propSnow;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        ${PROP_HEAD}
        attribute float aWave;
        uniform float uPropTime;
        uniform float uPropWind;
      `)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          float pw = aWave * ${wave.toFixed(3)} * uPropWind;
          if (pw > 0.0001) {
            float ph = position.x * 0.31 + position.z * 0.19 + position.y * 0.11;
            float t = uPropTime;
            transformed.x += sin(t * 3.3 + ph) * 0.62 * pw + sin(t * 7.1 + ph * 2.3) * 0.18 * pw;
            transformed.z += sin(t * 2.6 + ph * 1.7) * 0.48 * pw;
            transformed.y += sin(t * 4.7 + ph * 2.9) * 0.22 * pw;
          }
          #ifdef USE_INSTANCING
            vPropN = mat3(modelMatrix) * (mat3(instanceMatrix) * objectNormal);
            vPropW = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
          #else
            vPropN = mat3(modelMatrix) * objectNormal;
            vPropW = (modelMatrix * vec4(transformed, 1.0)).xyz;
          #endif
        }
      `);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        ${PROP_HEAD}
        ${PROP_NOISE}
        uniform float uPropSnow;
      `)
      // map_fragment runs before color_fragment, so pSnowK is in scope for both.
      .replace('#include <map_fragment>', `#include <map_fragment>
        float pSnowK = 0.0;
        if (uPropSnow > 0.001) {
          vec3 pN = normalize(vPropN);
          float pBreak = pNoise(vPropW.xz * 0.34) * 0.5 + pNoise(vPropW.xz * 1.7) * 0.28;
          float pEdge = 0.30 + pBreak * 0.34;
          pSnowK = smoothstep(pEdge, pEdge + 0.34, pN.y) * uPropSnow;
          pSnowK *= 0.72 + 0.28 * smoothstep(0.0, 0.6, pN.y);
        }
      `)
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.90, 0.935, 0.99), pSnowK);
      `)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.74, pSnowK);
      `)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        metalnessFactor *= (1.0 - pSnowK * 0.95);
      `);

    spliceAerial(shader, 'vPropW');
  };
  mat.customProgramCacheKey = () => `prop-${snow}-${wave}`;
  return mat;
}

/** Painted / plastic / timber / snow — everything non-metallic. */
export function makeMatte({ snow = 0.35, wave = 0.0, name = 'propMatte' } = {}) {
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.86, metalness: 0.02, name,
  });
  return patchProp(m, { snow, wave });
}

/** Galvanised steel: rails, truss, lift towers, cable. */
export function makeMetal({ snow = 0.16, name = 'propMetal' } = {}) {
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.33, metalness: 0.88, name,
  });
  return patchProp(m, { snow, wave: 0 });
}

/** Banners, pennants, B-net, signage. Alpha tested, double sided, flaps. */
export function makeFabric({ wave = 0.55, name = 'propFabric' } = {}) {
  const m = new THREE.MeshStandardMaterial({
    map: propAtlas(),
    vertexColors: true,
    roughness: 0.92,
    metalness: 0.0,
    side: THREE.DoubleSide,
    alphaTest: 0.45,
    name,
  });
  return patchProp(m, { snow: 0.05, wave });
}

/** Faceted rock with heavy snow load on top. */
export function makeRock({ name = 'propRock' } = {}) {
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.93, metalness: 0.0, flatShading: true, name,
  });
  return patchProp(m, { snow: 1.0, wave: 0 });
}

// ==========================================================================
// conifers
// ==========================================================================
/**
 * One shader serves all three forest LOD tiers. What differs is only:
 *
 *   mode 0  full 3D tree      trunk cylinder + drooping needle cards
 *   mode 1  crossed billboard two quads at 90 deg, whole-tree silhouette
 *   mode 2  single billboard  one quad spun about Y to face the camera
 *
 * All three read their distance to the camera in the vertex shader and fade
 * with an ordered dither, so a tree hands over from one tier to the next by
 * dissolving across a 35 m band rather than popping. Because the fade is
 * evaluated live per frame, the CPU-side tier buckets only have to *overlap*
 * the band, not track it.
 *
 * Per instance: aTree = (windX, windZ, phase, atlasCell).
 * windXZ is the world wind direction rotated into the instance's own frame,
 * so every tree on the mountain leans the same way whatever its yaw.
 */
export const treeFade = {
  near: { value: new THREE.Vector4(-2, -1, 108, 146) },
  cross: { value: new THREE.Vector4(104, 142, 310, 390) },
  far: { value: new THREE.Vector4(300, 384, 900, 1010) },
};

const TREE_COMMON = /* glsl */`
  attribute vec4 aTree;
  uniform float uPropTime;
  uniform float uPropWind;
  uniform vec4 uTreeFade;
  varying float vTreeFade;
  varying vec3 vPropN;
  varying vec3 vPropW;
`;

// Ordered 4x4 dither. The nested form costs three fract calls and needs no
// lookup table, which matters because it runs on every forest fragment.
const TREE_DITHER = /* glsl */`
  float tBayer2(vec2 a) { a = floor(a); return fract(a.x * 0.5 + a.y * a.y * 0.75); }
  float tBayer4(vec2 a) { return tBayer2(0.5 * a) * 0.25 + tBayer2(a); }
`;

function patchTree(mat, { mode = 0, sway = 0.06 } = {}) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uPropTime = propTime;
    shader.uniforms.uPropWind = propWind;
    shader.uniforms.uTreeFade = mode === 0 ? treeFade.near : mode === 1 ? treeFade.cross : treeFade.far;

    // ---- vertex ------------------------------------------------------------
    // The instance origin and the camera distance are needed by both the normal
    // block and the position block, and beginnormal_vertex runs first, so they
    // are declared there at function scope rather than inside a nested block.
    let head = `#include <beginnormal_vertex>
      vec4 tOrigin = vec4(0.0, 0.0, 0.0, 1.0);
      #ifdef USE_INSTANCING
        tOrigin = instanceMatrix * tOrigin;
      #endif
      vec3 tWorld = (modelMatrix * tOrigin).xyz;
      vec3 tToCam = cameraPosition - tWorld;
      float tDist = length(tToCam);
      float tSin = 0.0, tCos = 1.0;
      vTreeFade = smoothstep(uTreeFade.x, uTreeFade.y, tDist)
                * (1.0 - smoothstep(uTreeFade.z, uTreeFade.w, tDist));
    `;
    if (mode === 2) {
      head += `
      {
        vec2 tFlat = tToCam.xz;
        float tLen = max(length(tFlat), 1e-4);
        tSin = tFlat.x / tLen;
        tCos = tFlat.y / tLen;
        objectNormal = normalize(vec3(tSin * 0.72, 0.70, tCos * 0.72));
      }
      `;
    }

    let body = `#include <begin_vertex>
    `;
    if (mode === 2) {
      body += `
      transformed.xz = vec2(tCos * transformed.x + tSin * transformed.z,
                            tSin * transformed.x * -1.0 + tCos * transformed.z);
      `;
    }
    body += `
      {
        float tAmp = pow(clamp(transformed.y, 0.0, 1.6), 1.7) * uPropWind * ${sway.toFixed(4)};
        float tPh = aTree.z + uPropTime;
        float tSw = sin(tPh * 1.31) * 0.58 + sin(tPh * 2.63 + aTree.z * 1.7) * 0.29
                  + sin(tPh * 5.17 + aTree.z) * 0.13;
        transformed.xz += aTree.xy * (tSw * tAmp);
      }
      #ifdef USE_INSTANCING
        vPropN = mat3(modelMatrix) * (mat3(instanceMatrix) * objectNormal);
        vPropW = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
      #else
        vPropN = mat3(modelMatrix) * objectNormal;
        vPropW = (modelMatrix * vec4(transformed, 1.0)).xyz;
      #endif
    `;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${TREE_COMMON}`)
      .replace('#include <beginnormal_vertex>', head)
      .replace('#include <begin_vertex>', body);

    if (mode !== 0) {
      // 2x2 silhouette atlas: pick this instance's cell. Row 0 of the canvas is
      // the TOP of the texture, hence 0.5 - row * 0.5 rather than row * 0.5.
      shader.vertexShader = shader.vertexShader.replace('#include <uv_vertex>', `#include <uv_vertex>
        #ifdef USE_MAP
          float tRow = floor(aTree.w * 0.5);
          float tCol = aTree.w - tRow * 2.0;
          vMapUv = vMapUv * 0.5 + vec2(tCol * 0.5, 0.5 - tRow * 0.5);
        #endif
      `);
    }

    // ---- fragment ----------------------------------------------------------
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        ${TREE_COMMON.replace('attribute vec4 aTree;', '')}
        ${TREE_DITHER}
        ${PROP_NOISE}
        uniform float uPropSnow;
      `)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
        if (vTreeFade < tBayer4(gl_FragCoord.xy)) discard;
      `)
      .replace('#include <map_fragment>', `#include <map_fragment>
        float pSnowK = 0.0;
        if (uPropSnow > 0.001) {
          vec3 pN = normalize(vPropN);
          float pBreak = pNoise(vPropW.xz * 0.9) * 0.5 + pNoise(vPropW.xz * 3.1) * 0.3;
          float pEdge = 0.24 + pBreak * 0.40;
          pSnowK = smoothstep(pEdge, pEdge + 0.30, pN.y) * uPropSnow;
        }
      `)
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.88, 0.925, 0.99), pSnowK);
      `)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.76, pSnowK);
      `);

    shader.uniforms.uPropSnow = mat.userData.propSnow;
    spliceAerial(shader, 'vPropW');
  };
  mat.customProgramCacheKey = () => `tree-${mode}`;
  return mat;
}

/*
 * Foliage edges: alphaTest alone gives a hard binary cutout, which aliases
 * badly and makes the mid-distance forest crawl and sparkle as mip levels
 * shift alpha coverage across the threshold. The scene pass is already
 * multisampled (vfx/post.js sets samples: 4), so alpha-to-coverage resolves
 * those edges properly for free.
 */
/** Near tier: real geometry — tapered trunk plus drooping needle cards. */
export function makeTreeNear() {
  const m = new THREE.MeshStandardMaterial({
    map: barkNeedleAtlas(),
    vertexColors: true,
    roughness: 0.94,
    metalness: 0.0,
    side: THREE.DoubleSide,
    alphaTest: 0.42,
    alphaToCoverage: true,
    name: 'treeNear',
  });
  m.userData.propSnow = { value: 0.62 };
  return patchTree(m, { mode: 0, sway: 0.055 });
}

/** Mid tier: two crossed quads carrying a whole-tree silhouette. */
export function makeTreeCross() {
  const m = new THREE.MeshStandardMaterial({
    map: coniferAtlas(),
    vertexColors: true,
    roughness: 0.95,
    metalness: 0.0,
    side: THREE.DoubleSide,
    alphaTest: 0.40,
    alphaToCoverage: true,
    name: 'treeCross',
  });
  m.userData.propSnow = { value: 0.0 };
  return patchTree(m, { mode: 1, sway: 0.030 });
}

/** Far tier: one quad, spun about Y to face the camera. */
export function makeTreeFar() {
  const m = new THREE.MeshStandardMaterial({
    map: coniferAtlas(),
    vertexColors: true,
    roughness: 0.96,
    metalness: 0.0,
    side: THREE.DoubleSide,
    alphaTest: 0.36,
    alphaToCoverage: true,
    name: 'treeFar',
  });
  m.userData.propSnow = { value: 0.0 };
  return patchTree(m, { mode: 2, sway: 0.016 });
}
