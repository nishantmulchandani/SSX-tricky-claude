import * as THREE from 'three';
import {
  ATMOSPHERE, TRANSMITTANCE_RES, MULTISCATTER_RES, SKYVIEW_RES,
} from '../shaders/skyAtmosphere.glsl.js';
import {
  FULLSCREEN_VERT, TRANSMITTANCE_FRAG, MULTISCATTER_FRAG, SKYVIEW_FRAG,
  AMBIENT_FRAG, SKYDOME_VERT, SKYDOME_FRAG,
} from '../shaders/sky.glsl.js';
import { SKY_AERIAL_GLSL } from '../shaders/skyAerial.glsl.js';
import { createLightRig } from './lighting.js';
import { COURSE_START_Y } from './terrain.js';

/**
 * Atmosphere, sun and image-based lighting. OWNER: agent "atmosphere".
 *
 *   createSky(scene, renderer) -> { sun, sunDir, envMap, fogParams, update }
 *
 * ---------------------------------------------------------------------------
 * The whole module is one physical model used four ways, which is the only
 * reason the frame holds together:
 *
 *   1. SKY        A Hillaire-style participating-medium atmosphere is baked
 *                 into three LUTs (transmittance, multiple scattering,
 *                 sky-view) and read by a dome shader that adds the sun disc
 *                 with limb darkening, the Mie aureole and two cloud decks.
 *   2. IBL        The same dome — minus the sun disc, which the directional
 *                 light already accounts for — is rendered into a cubemap and
 *                 pushed through PMREM, so every material in the scene is lit
 *                 by the actual sky above it rather than by a guessed colour.
 *   3. SUN RIG    A 4-cascade shadow-mapped directional light whose colour is
 *                 the atmosphere's own transmittance towards the sun, plus a
 *                 snow-bounce fill derived from the sky irradiance the probe
 *                 pass measures. Nothing here is hand-picked.
 *   4. AERIAL     The same coefficients integrated along the view ray, folded
 *                 into every lit material in the scene. A ridge at 6 km and
 *                 the sky right above it converge on the same colour, so the
 *                 ridge dissolves into the air instead of being pasted on it.
 *                 See docs/REQUESTS-atmosphere.md.
 *
 * Radiance is authored in scene-linear render units where a fully sunlit
 * snowfield sits just under 1.0 — which is where the post stack's bloom
 * threshold expects it, and where AgX still has roll-off left above.
 *
 * Cost: the LUT chain, the cubemap and the PMREM are rebuilt only when the sun
 * moves or the rider has descended far enough for the air above them to have
 * measurably changed. Per frame this module runs one dome draw, the cascade
 * update, and a handful of uniform writes.
 */

const DEG = Math.PI / 180;

const DEFAULTS = {
  // Late morning, high alpine. 23 degrees is low enough for long shadows and
  // real modelling on the snow, high enough that the sun is not orange.
  sunElevation: 23.0,
  // Measured from the fall line (-Z) towards +X: the sun sits ahead and to the
  // right, so the run is cross-lit and back-lit and the shadows rake across it.
  sunAzimuth: 36.0,

  /** Top-of-atmosphere solar irradiance expressed in render units. */
  exposure: 4.6,
  /** Aerosol load. 1 = molecular only (unphysically clean), 3-4 = hazy valley.
   *  High alpine air really is close to pristine, and the deep blue that comes
   *  with it is most of what says "3000 m" before any geometry does. */
  haze: 1.45,
  mieG: 0.76,
  /** Snowfield albedo seen by the atmosphere — a big part of the horizon lift. */
  groundAlbedo: 0.62,

  /** Sun disc / aureole peak radiance, render units. */
  sunDisc: 2600.0,
  sunGlow: 60.0,
  /** 0.267 deg. The real thing; anything larger reads as a cartoon. */
  sunAngularRadius: 0.00466,

  // Cloud decks. Altitudes are absolute, in kilometres.
  cumulus: 0.95,
  cumulusCoverage: 0.60,
  cumulusAltitude: 3.4,
  cumulusScale: 0.115,
  cumulusDensity: 7.5,
  cirrus: 0.45,
  cirrusCoverage: 0.575,
  cirrusAltitude: 7.2,
  cirrusScale: 0.055,
  windSpeed: 0.0026,
  /** How much sun the cumulus deck takes away where its shadow lands, 0..1. */
  cloudShadow: 0.5,

  /** Artistic gain on aerial perspective. 1 = physical. */
  aerialStrength: 2.15,
  aerialSunGlow: 0.55,
  /** Snow bounce reaching up-facing surfaces (inter-reflection in the bowl). */
  bounceUp: 0.42,

  shadowMapSize: 2048,
  envSize: 128,
};

export function createSky(scene, renderer, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };

  // -------------------------------------------------------------------------
  // Shared atmosphere uniforms. Every pass points at these same objects, so
  // the sky, the aerial perspective and the light rig can never disagree.
  // -------------------------------------------------------------------------
  const transmittanceRT = makeLutTarget(...TRANSMITTANCE_RES);
  const multiScatterRT = makeLutTarget(...MULTISCATTER_RES);
  const skyViewRT = makeLutTarget(...SKYVIEW_RES);

  const sunDir = new THREE.Vector3();
  const shared = {
    uTransmittanceLut: { value: transmittanceRT.texture },
    uMultiScatterLut: { value: multiScatterRT.texture },
    uHaze: { value: cfg.haze },
    uMieG: { value: cfg.mieG },
    uGroundAlbedo: { value: cfg.groundAlbedo },
  };
  const sunUniform = { value: sunDir };
  const altUniform = { value: 1.4 };

  const cloudNoise = makeCloudNoise(256);

  // -------------------------------------------------------------------------
  // Offline passes
  // -------------------------------------------------------------------------
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
  quad.frustumCulled = false;
  const lutScene = new THREE.Scene().add(quad);
  const lutCamera = new THREE.Camera();

  const transmittanceMat = new THREE.RawShaderMaterial({
    vertexShader: glsl3(FULLSCREEN_VERT), fragmentShader: glsl3f(TRANSMITTANCE_FRAG),
    uniforms: { ...shared }, glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false,
  });
  const multiScatterMat = new THREE.RawShaderMaterial({
    vertexShader: glsl3(FULLSCREEN_VERT), fragmentShader: glsl3f(MULTISCATTER_FRAG),
    uniforms: { ...shared }, glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false,
  });
  const skyViewMat = new THREE.RawShaderMaterial({
    vertexShader: glsl3(FULLSCREEN_VERT), fragmentShader: glsl3f(SKYVIEW_FRAG),
    uniforms: { ...shared, uSunDir: sunUniform, uCameraAltitude: altUniform },
    glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false,
  });

  const ambientRT = new THREE.WebGLRenderTarget(4, 1, {
    type: THREE.UnsignedByteType, format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
  });
  const ambientMat = new THREE.RawShaderMaterial({
    vertexShader: glsl3(FULLSCREEN_VERT), fragmentShader: glsl3f(AMBIENT_FRAG),
    uniforms: {
      ...shared,
      uSkyViewLut: { value: skyViewRT.texture },
      uSunDir: sunUniform,
      uCameraAltitude: altUniform,
    },
    glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false,
  });
  const ambientPixels = new Uint8Array(16);

  // -------------------------------------------------------------------------
  // Sky dome
  // -------------------------------------------------------------------------
  const domeUniforms = {
    ...shared,
    uSkyViewLut: { value: skyViewRT.texture },
    uCloudNoise: { value: cloudNoise },
    uSunDir: sunUniform,
    uCameraAltitude: altUniform,
    uSkyExposure: { value: cfg.exposure },
    uSunDiscIntensity: { value: cfg.sunDisc / cfg.exposure },
    uSunGlow: { value: cfg.sunGlow / cfg.exposure },
    uSunAngularRadius: { value: cfg.sunAngularRadius },

    uCloudAmount: { value: cfg.cumulus },
    uCloudCoverage: { value: cfg.cumulusCoverage },
    uCloudAltitude: { value: cfg.cumulusAltitude },
    uCloudScale: { value: cfg.cumulusScale },
    uCloudWind: { value: new THREE.Vector2() },
    uCloudDensity: { value: cfg.cumulusDensity },
    uCirrusAmount: { value: cfg.cirrus },
    uCirrusCoverage: { value: cfg.cirrusCoverage },
    uCirrusAltitude: { value: cfg.cirrusAltitude },
    uCirrusScale: { value: cfg.cirrusScale },
    uCirrusWind: { value: new THREE.Vector2() },
    uGroundTint: { value: new THREE.Vector3(1.06, 1.10, 1.16) },
  };

  const domeMaterial = new THREE.ShaderMaterial({
    vertexShader: SKYDOME_VERT,
    fragmentShader: SKYDOME_FRAG,
    uniforms: domeUniforms,
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
    fog: false,
  });
  domeMaterial.userData.skyNoCSM = true;

  // 128x80 segments: the sun disc is 0.27 deg across and is evaluated from the
  // interpolated direction, so the tessellation has to be fine enough that the
  // chord-vs-arc error stays far below that.
  const dome = new THREE.Mesh(new THREE.SphereGeometry(5000, 128, 80), domeMaterial);
  dome.frustumCulled = false;
  dome.renderOrder = -1000;
  dome.matrixAutoUpdate = false;
  dome.name = 'sky-dome';
  scene.add(dome);

  // The half-res depth prepass treats "nothing written" as sky; if the dome
  // wrote depth the god rays would think the sky occludes the sun.
  import('../vfx/sceneDepth.js')
    .then((m) => m.excludeFromDepth?.(dome))
    .catch(() => {});

  // -------------------------------------------------------------------------
  // Environment cubemap -> PMREM
  // -------------------------------------------------------------------------
  const cubeRT = new THREE.WebGLCubeRenderTarget(cfg.envSize, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
  });
  const cubeCamera = new THREE.CubeCamera(0.5, 100, cubeRT);
  const envScene = new THREE.Scene();
  const envBox = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10), domeMaterial);
  envBox.frustumCulled = false;
  envScene.add(envBox);

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileCubemapShader();
  let envRT = null;

  // -------------------------------------------------------------------------
  // Aerial perspective — the public GLSL chunk's uniform block
  // -------------------------------------------------------------------------
  const A = ATMOSPHERE;
  const aerialUniforms = {
    uAerialCameraPos: { value: new THREE.Vector3() },
    uAerialSunDir: sunUniform,
    uAerialBetaR: { value: new THREE.Vector3(...A.rayleighScattering).multiplyScalar(1e-3) },
    uAerialBetaMS: { value: new THREE.Vector3(1, 1, 1).multiplyScalar(A.mieScattering * 1e-3 * cfg.haze) },
    uAerialBetaMA: { value: new THREE.Vector3(1, 1, 1).multiplyScalar(A.mieAbsorption * 1e-3 * cfg.haze) },
    uAerialHR: { value: A.rayleighScaleHeight * 1000 },
    uAerialHM: { value: A.mieScaleHeight * 1000 },
    uAerialRefY: { value: 0 },
    uAerialStrength: { value: cfg.aerialStrength },
    uAerialSunGlow: { value: cfg.aerialSunGlow },
    uAerialSkyLut: { value: skyViewRT.texture },
    uAerialCamAltKm: altUniform,
    uAerialExposure: { value: cfg.exposure },
    uAerialNoise: { value: cloudNoise },
    // Wind phase ONLY. The dome folds the camera offset into its own copy of
    // this because it integrates in a camera-centred frame; the aerial chunk
    // samples absolute world positions, so adding it again would double it and
    // the cloud shadows would slide out from under the clouds.
    uAerialCloudWind: { value: new THREE.Vector2() },
    uAerialCloudScale: { value: cfg.cumulusScale * 1e-3 },
    uAerialCloudCoverage: { value: cfg.cumulusCoverage },
    uAerialCloudAltitude: { value: cfg.cumulusAltitude * 1000 },
    uAerialCloudShadow: { value: cfg.cloudShadow },
  };

  /**
   * Splice aerial perspective into every lit material the light rig adopts.
   * Runs after the owning module's own onBeforeCompile, so it also gets to
   * shim the one place the snow shader assumes a single directional light.
   */
  function patchMaterial(shader) {
    if (shader.__skyAerial) return;
    shader.__skyAerial = true;
    Object.assign(shader.uniforms, aerialUniforms);

    if (shader.vertexShader.includes('#include <fog_vertex>')) {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vSkyWorldPos;')
        .replace('#include <fog_vertex>',
          '#include <fog_vertex>\nvSkyWorldPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
    } else {
      return;
    }

    if (!shader.fragmentShader.includes('#include <opaque_fragment>')) return;

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        `#include <common>\nvarying vec3 vSkyWorldPos;\n${SKY_AERIAL_GLSL}`)
      .replace('#include <opaque_fragment>',
        '#include <opaque_fragment>\ngl_FragColor.rgb = skyAerialPerspective( gl_FragColor.rgb, vSkyWorldPos );');

    // --- cloud shadows -------------------------------------------------------
    // Applied to the direct term after the light loop closes, so it costs one
    // noise lookup regardless of how many cascades the rig is running. The snow
    // shader recovers sun visibility from the direct radiance it accumulated, so
    // its own running total is scaled with it — otherwise snow under a cloud
    // would keep its sparkle and its subsurface glow while going flat.
    if (shader.fragmentShader.includes('#include <lights_fragment_end>')) {
      const snow = shader.fragmentShader.includes('snowDirectSum')
        ? '\n  snowDirectSum *= skySunVis;' : '';
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
{
  float skySunVis = skyCloudShadow( vSkyWorldPos );
  reflectedLight.directDiffuse *= skySunVis;
  reflectedLight.directSpecular *= skySunVis;${snow}
}`);
    }

    // --- compatibility shim, see docs/REQUESTS-atmosphere.md -----------------
    // The snow shader recovers per-pixel sun visibility by comparing the direct
    // radiance it received against the sum of every directionalLights[] colour.
    // A cascade rig is N lights that are all the *same* light — only one of
    // them ever runs RE_Direct — so that sum has to be normalised or sunlit
    // snow reads as 1/N lit and turns blue.
    shader.fragmentShader = shader.fragmentShader.replace(
      /snSunTotal\s*\+=\s*directionalLights\[\s*i\s*\]\.color\s*;/,
      'snSunTotal += directionalLights[ i ].color * ( 1.0 / float( CSM_CASCADES ) );',
    );
  }

  // -------------------------------------------------------------------------
  // Light rig
  // -------------------------------------------------------------------------
  const rig = createLightRig(scene, renderer, {
    shadowMapSize: cfg.shadowMapSize,
    materialPatch: patchMaterial,
  });

  const fogParams = {
    color: new THREE.Color(0.5, 0.62, 0.8),
    sunColor: new THREE.Color(1, 1, 1),
    skyColor: new THREE.Color(0.5, 0.62, 0.8),
    density: 0,          // aerial perspective is analytic; see aerial below
    near: 400,
    far: 9000,
    aerial: aerialUniforms,
    glsl: SKY_AERIAL_GLSL,
  };

  // -------------------------------------------------------------------------
  // Baking
  // -------------------------------------------------------------------------
  function blit(material, target) {
    const prevTarget = renderer.getRenderTarget();
    const prevTone = renderer.toneMapping;
    const prevShadow = renderer.shadowMap.autoUpdate;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.shadowMap.autoUpdate = false;
    quad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(lutScene, lutCamera);
    renderer.setRenderTarget(prevTarget);
    renderer.toneMapping = prevTone;
    renderer.shadowMap.autoUpdate = prevShadow;
  }

  function setSunAngles(elevationDeg, azimuthDeg) {
    const el = elevationDeg * DEG;
    const az = azimuthDeg * DEG;
    sunDir.set(
      Math.sin(az) * Math.cos(el),
      Math.sin(el),
      -Math.cos(az) * Math.cos(el),
    ).normalize();
    rig.setSunDirection(sunDir);
  }

  const _c = new THREE.Color();
  const _skyAvg = new THREE.Color();
  const _sunT = new THREE.Color();
  const _horizon = new THREE.Color();

  function readAmbientProbe() {
    blit(ambientMat, ambientRT);
    renderer.readRenderTargetPixels(ambientRT, 0, 0, 4, 1, ambientPixels);
    const p = ambientPixels;
    const sq = (i) => {
      const r = p[i * 4] / 255, g = p[i * 4 + 1] / 255, b = p[i * 4 + 2] / 255;
      return [r * r, g * g, b * b];
    };
    _skyAvg.setRGB(...sq(0));
    _sunT.setRGB(p[4] / 255, p[5] / 255, p[6] / 255);
    _horizon.setRGB(...sq(2));

    const S = cfg.exposure;

    // Sun. three multiplies colour by intensity to get irradiance on a surface
    // facing the light, which is exactly S * transmittance.
    rig.setSunLight(_sunT, S);

    // Snow bounce. The PMREM environment already carries the sky; what it
    // cannot carry is the light the snowfield throws back up at everything,
    // which on a 0.9-albedo surface is the single brightest fill in the scene
    // and the reason alpine shadows are luminous rather than dead.
    const sinEl = Math.max(sunDir.y, 0.0);
    const skyIrradiance = Math.PI * lum(_skyAvg);
    const bounce = new THREE.Color(
      _sunT.r * S * sinEl + skyIrradiance * S * 0.9,
      _sunT.g * S * sinEl + skyIrradiance * S * 0.95,
      _sunT.b * S * sinEl + skyIrradiance * S * 1.05,
    ).multiplyScalar(0.86 * 0.5);   // snow albedo x view factor of the ground
    _c.copy(bounce).multiplyScalar(cfg.bounceUp);
    rig.setBounce(_c, bounce, 1.0);

    fogParams.color.copy(_horizon).multiplyScalar(S);
    fogParams.skyColor.copy(_skyAvg).multiplyScalar(S);
    fogParams.sunColor.copy(_sunT).multiplyScalar(S);
  }

  function bakeEnvironment() {
    const prevTone = renderer.toneMapping;
    const prevShadow = renderer.shadowMap.autoUpdate;
    const prevDisc = domeUniforms.uSunDiscIntensity.value;
    const prevGlow = domeUniforms.uSunGlow.value;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.shadowMap.autoUpdate = false;
    // The directional light already is the sun. Baking the disc into the IBL
    // as well would count it twice and blow out the diffuse irradiance.
    domeUniforms.uSunDiscIntensity.value = 0;
    domeUniforms.uSunGlow.value = prevGlow * 0.35;

    cubeCamera.update(renderer, envScene);

    domeUniforms.uSunDiscIntensity.value = prevDisc;
    domeUniforms.uSunGlow.value = prevGlow;
    renderer.toneMapping = prevTone;
    renderer.shadowMap.autoUpdate = prevShadow;

    envRT = pmrem.fromCubemap(cubeRT.texture, envRT);
    scene.environment = envRT.texture;
    // The first bake runs during construction, before `api` exists; the
    // envMap is assigned again once it does, so skipping here is harmless.
    if (api) api.envMap = envRT.texture;
  }

  let bakedAltitude = -1e9;
  let sunDirty = true;
  // Declared up here so the environment bake above can safely test for it.
  let api = null;

  function rebuild(altitudeKm, full) {
    altUniform.value = altitudeKm;
    if (full) {
      blit(transmittanceMat, transmittanceRT);
      blit(multiScatterMat, multiScatterRT);
    }
    blit(skyViewMat, skyViewRT);
    readAmbientProbe();
    bakeEnvironment();
    bakedAltitude = altitudeKm;
    sunDirty = false;
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------
  setSunAngles(cfg.sunElevation, cfg.sunAzimuth);
  rebuild(COURSE_START_Y * 0.001, true);

  // -------------------------------------------------------------------------
  // Per frame
  // -------------------------------------------------------------------------
  const windOffset = new THREE.Vector2();
  let elapsedTime = 0;

  function update(dt, elapsed, camera) {
    const cam = camera || scene.__camera;
    elapsedTime = elapsed ?? (elapsedTime + (dt || 0));

    if (cam) {
      dome.position.copy(cam.position);
      dome.updateMatrix();
      dome.matrixWorld.copy(dome.matrix);

      aerialUniforms.uAerialCameraPos.value.copy(cam.position);

      const altKm = Math.max(cam.position.y, 0) * 0.001;
      altUniform.value = altKm;

      // Clouds are anchored in world space, not to the camera, or the parallax
      // that sells their distance disappears. The dome integrates in a frame
      // centred on the viewer, so the camera offset is folded into the phase.
      const s = domeUniforms.uCloudScale.value;
      windOffset.set(elapsedTime * cfg.windSpeed, elapsedTime * cfg.windSpeed * 0.35);
      aerialUniforms.uAerialCloudWind.value.copy(windOffset);
      domeUniforms.uCloudWind.value.set(
        cam.position.x * 0.001 * s + windOffset.x,
        cam.position.z * 0.001 * s + windOffset.y,
      );
      const cs = domeUniforms.uCirrusScale.value;
      domeUniforms.uCirrusWind.value.set(
        cam.position.x * 0.001 * cs + windOffset.x * 2.4,
        cam.position.z * 0.001 * cs + windOffset.y * 2.4,
      );

      // The air above the rider only changes slowly; a 300 m descent is about
      // the point at which the sky-view LUT is measurably stale.
      if (sunDirty || Math.abs(altKm - bakedAltitude) > 0.30) rebuild(altKm, sunDirty);

      rig.update(cam);
    }
  }

  api = {
    sun: rig.sun,
    sunDir,
    envMap: null,
    fogParams,
    update,

    /** Live handles for tools/probe.mjs and the in-page console. */
    lights: rig.lights,
    csm: rig.csm,
    uniforms: domeUniforms,
    aerial: aerialUniforms,
    config: cfg,

    setSun(elevationDeg, azimuthDeg) {
      cfg.sunElevation = elevationDeg;
      cfg.sunAzimuth = azimuthDeg;
      setSunAngles(elevationDeg, azimuthDeg);
      sunDirty = true;
    },

    setExposure(value) {
      cfg.exposure = value;
      domeUniforms.uSkyExposure.value = value;
      domeUniforms.uSunDiscIntensity.value = cfg.sunDisc / value;
      domeUniforms.uSunGlow.value = cfg.sunGlow / value;
      aerialUniforms.uAerialExposure.value = value;
      sunDirty = true;
    },

    dispose() {
      scene.remove(dome);
      dome.geometry.dispose();
      domeMaterial.dispose();
      envBox.geometry.dispose();
      transmittanceRT.dispose(); multiScatterRT.dispose(); skyViewRT.dispose();
      ambientRT.dispose(); cubeRT.dispose(); envRT?.dispose();
      pmrem.dispose();
      cloudNoise.dispose();
      rig.dispose();
    },
  };

  api.envMap = envRT ? envRT.texture : null;
  return api;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function lum(c) { return c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722; }

function makeLutTarget(w, h) {
  const rt = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  rt.texture.colorSpace = THREE.NoColorSpace;
  return rt;
}

/** RawShaderMaterial gets no boilerplate, so GLSL3 needs its own preamble. */
function glsl3(src) {
  return `precision highp float;\nprecision highp int;\nin vec3 position;\nin vec2 uv;\n${
    src.replace(/\bvarying\b/g, 'out')}`;
}
function glsl3f(src) {
  // precision MUST come first: GLSL ES 3.0 rejects `out vec4 pc_FragColor;`
  // if no float precision has been declared yet, and RawShaderMaterial adds
  // no boilerplate of its own.
  return `precision highp float;\nprecision highp int;\n#define texture2D texture\nout vec4 pc_FragColor;\n#define gl_FragColor pc_FragColor\n${
    src.replace(/\bvarying\b/g, 'in')}`;
}

/**
 * Tiling four-octave value noise, one octave per channel, so a full cloud
 * sample costs one texture fetch. Periods are chosen so every channel wraps
 * exactly at the texture edge — a visible seam in a cloud deck is unforgivable.
 */
function makeCloudNoise(size = 256) {
  const periods = [4, 8, 16, 32];
  const data = new Uint8Array(size * size * 4);

  // Every product here has to go through Math.imul. The classic integer hash
  // squares a 31-bit value, which in a JS double silently loses every bit below
  // 2^-53 and collapses the hash into a handful of quantised outputs; the
  // texture then comes out flat and the cloud decks render as a featureless
  // grey veil over the whole sky.
  const ihash = (x, y, seed) => {
    let n = (Math.imul(x, 1619) + Math.imul(y, 31337) + Math.imul(seed, 6971)) | 0;
    n = (n << 13) ^ n;
    n = (Math.imul(n, Math.imul(Math.imul(n, n), 15731) + 789221) + 1376312589) & 0x7fffffff;
    return n / 2147483647.0;
  };

  const vnoise = (u, v, p, seed) => {
    const x = u * p, y = v * p;
    const ix = Math.floor(x), iy = Math.floor(y);
    let fx = x - ix, fy = y - iy;
    const wx = fx * fx * (3 - 2 * fx);
    const wy = fy * fy * (3 - 2 * fy);
    const m = (i, n) => ((i % n) + n) % n;
    const x0 = m(ix, p), x1 = m(ix + 1, p), y0 = m(iy, p), y1 = m(iy + 1, p);
    const a = ihash(x0, y0, seed), b = ihash(x1, y0, seed);
    const c = ihash(x0, y1, seed), d = ihash(x1, y1, seed);
    return (a + (b - a) * wx) + ((c + (d - c) * wx) - (a + (b - a) * wx)) * wy;
  };

  for (let j = 0; j < size; j++) {
    const v = j / size;
    for (let i = 0; i < size; i++) {
      const u = i / size;
      const o = (j * size + i) * 4;
      for (let c = 0; c < 4; c++) {
        const p = periods[c];
        // Two octaves per channel keeps each band broad-spectrum without
        // needing eight textures' worth of fetches in the dome shader.
        let n = vnoise(u, v, p, c * 7 + 1) * 0.66 + vnoise(u, v, p * 2, c * 7 + 3) * 0.34;
        n = Math.min(1, Math.max(0, (n - 0.5) * 1.35 + 0.5));
        data[o + c] = Math.round(n * 255);
      }
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}
