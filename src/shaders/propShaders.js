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

export const propTime = { value: 0 };
export const propWind = { value: 1.0 };

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
