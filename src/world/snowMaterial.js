import * as THREE from 'three';
import { courseAt, courseXAt, COURSE_LENGTH } from './terrain.js';
import {
  snowVertexPars, snowVertexMain,
  snowFragmentPars, snowReDirect, snowSurface, snowSheen, snowLighting,
} from '../shaders/snowShader.js';

/**
 * The snow surface. OWNER: agent "snow-shading".
 *
 *   createSnowMaterial(opts) -> THREE.Material
 *   updateSnowMaterial(dt, ctx)
 *
 * Snow is a dense, weakly absorbing scattering medium, and almost everything
 * that makes it read as snow rather than white plastic comes from that:
 *
 *  1. Albedo ~0.9 and an index of refraction of 1.31, so F0 is 0.018 — a much
 *     dimmer, broader specular than the 0.04 dielectric default.
 *  2. A retro-reflective sheen lobe on top of GGX. Fresh snow brightens
 *     steeply towards grazing angles in a way no single GGX lobe reproduces;
 *     three's Charlie sheen is that lobe and it is fed by both the sun and the
 *     environment map.
 *  3. Subsurface transport: a wrapped-diffuse term past the terminator, a
 *     forward-scattering lobe into the sun and the opposition surge away from
 *     it, all tinted with the cyan-blue of deep ice.
 *  4. Shadowed snow is *sky*-lit, so it must be blue and still bright. The
 *     shadow tint multiplies indirect diffuse rather than adding to it, which
 *     keeps it correct no matter what the atmosphere module hands us as
 *     scene.environment.
 *  5. Four bands of world-space detail normal (drift, sastrugi, granular,
 *     corduroy) plus rock relief, each gated against the pixel footprint so
 *     nothing aliases, with the filtered-away slope variance folded back into
 *     roughness.
 *  6. A world-locked ice-crystal sparkle field whose cell size is pinned to a
 *     constant number of pixels and crossfaded between octaves.
 *
 * The whole thing is spliced into MeshPhysicalMaterial with onBeforeCompile so
 * shadows, IBL, fog and tone mapping keep working untouched.
 */

const _materials = new Set();

/** Baked centre-line lookup: exact, because it is sampled from terrain.js. */
function buildCourseLUT(size = 512) {
  const data = new Uint16Array(size * 4);
  for (let i = 0; i < size; i++) {
    const t = i / (size - 1);
    const z = -t * COURSE_LENGTH;
    const cx = courseXAt(z);
    const halfWidth = courseAt(t).width * 0.5;
    data[i * 4 + 0] = THREE.DataUtils.toHalfFloat(cx);
    data[i * 4 + 1] = THREE.DataUtils.toHalfFloat(halfWidth);
    data[i * 4 + 2] = 0;
    data[i * 4 + 3] = THREE.DataUtils.toHalfFloat(1);
  }
  const tex = new THREE.DataTexture(data, size, 1, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

let _courseLUT = null;
function courseLUT() {
  if (!_courseLUT) _courseLUT = buildCourseLUT();
  return _courseLUT;
}

export function createSnowMaterial(opts = {}) {
  const o = {
    // Snow reflects ~0.9 broadband with a shallow rise towards blue. Anything
    // higher than this and the tone mapper has nothing left to roll off with.
    snowAlbedo: [0.90, 0.925, 0.965],
    iceAlbedo: [0.66, 0.755, 0.88],
    rockAlbedo: [0.085, 0.079, 0.074],

    // Relative tint applied to indirect light where the sun does not reach.
    // Red is cut hard, blue is lifted past 1 — that ratio *is* the blue shadow.
    shadowTint: [0.60, 0.80, 1.42],
    // Additive multiple-scattering glow so shadows stay translucent, not holes.
    shadowGlow: [0.030, 0.055, 0.105],

    sssColor: [0.42, 0.66, 1.00],
    sssStrength: 1.35,
    wrap: 0.60,
    forward: 0.55,
    hotspot: 0.22,

    detail: 1.55,
    wind: [0.78, -0.62],

    sparkle: 2.6,
    sparkleSharp: 900.0,
    sparklePixels: 2.6,
    sparkleFar: 420.0,
    facetSpread: 0.62,
    crystalDensity: 0.055,

    roughness: 0.6,
    envMapIntensity: 1.0,
    ...opts,
  };

  const material = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: o.roughness,
    metalness: 0.0,
    ior: 1.31,               // ice: F0 = 0.018, not the 0.04 dielectric default
    sheen: 1.0,
    sheenRoughness: 0.35,
    sheenColor: new THREE.Color(0.55, 0.66, 0.88),
    envMapIntensity: o.envMapIntensity,
    dithering: true,         // the sky-lit gradients are wide and very smooth
  });
  material.name = 'snow';

  const uniforms = {
    uSnowTime: { value: 0 },
    uCourseLUT: { value: courseLUT() },
    uCourseLength: { value: COURSE_LENGTH },

    uSnowAlbedo: { value: new THREE.Vector3(...o.snowAlbedo) },
    uIceAlbedo: { value: new THREE.Vector3(...o.iceAlbedo) },
    uRockAlbedo: { value: new THREE.Vector3(...o.rockAlbedo) },

    uShadowTint: { value: new THREE.Vector3(...o.shadowTint) },
    uShadowGlow: { value: new THREE.Vector3(...o.shadowGlow) },
    uSSSColor: { value: new THREE.Vector3(...o.sssColor) },
    uSSSStrength: { value: o.sssStrength },
    uWrap: { value: o.wrap },
    uForward: { value: o.forward },
    uHotspot: { value: o.hotspot },

    uDetail: { value: o.detail },
    uWind: { value: new THREE.Vector2(...o.wind).normalize() },

    uSparkle: { value: o.sparkle },
    uSparkleSharp: { value: o.sparkleSharp },
    uSparklePixels: { value: o.sparklePixels },
    uSparkleFar: { value: o.sparkleFar },
    uFacetSpread: { value: o.facetSpread },
    uCrystalDensity: { value: o.crystalDensity },
  };
  material.userData.uniforms = uniforms;

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${snowVertexPars}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${snowVertexMain}`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${snowFragmentPars}`)
      .replace('#include <lights_physical_pars_fragment>',
        `#include <lights_physical_pars_fragment>\n${snowReDirect}`)
      .replace('#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>\n${snowSurface}`)
      .replace('#include <lights_physical_fragment>',
        `#include <lights_physical_fragment>\n${snowSheen}`)
      .replace('#include <aomap_fragment>',
        `#include <aomap_fragment>\n${snowLighting}`);

    material.userData.shader = shader;
  };

  // Keep this material on its own program branch.
  material.customProgramCacheKey = () => 'snow-v1';

  _materials.add(material);
  const dispose = material.dispose.bind(material);
  material.dispose = () => { _materials.delete(material); dispose(); };

  return material;
}

/**
 * Optional per-frame hook. `ctx` may carry { sky, camera, body } — everything
 * is read defensively so this never depends on another agent's module landing.
 */
export function updateSnowMaterial(dt = 0, ctx = {}) {
  for (const m of _materials) {
    const u = m.userData.uniforms;
    if (!u) continue;
    u.uSnowTime.value += dt;
    if (ctx.detail !== undefined) u.uDetail.value = ctx.detail;
    if (ctx.sparkle !== undefined) u.uSparkle.value = ctx.sparkle;
  }
}
