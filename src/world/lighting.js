import * as THREE from 'three';
import { CSM } from 'three/examples/jsm/csm/CSM.js';
import { heightAt } from './terrain.js';
import { COURSE_LENGTH, courseXAt } from './terrain.js';

/**
 * Sun rig — OWNER: agent "atmosphere".
 *
 * Cascaded shadow maps over ~2 km of view distance. Three things matter here
 * and none of them are optional if snow shadows are going to look right:
 *
 *  1. Stability. three's CSM already snaps each cascade's centre to a shadow
 *     texel, so the shadow edge does not crawl as the rider moves. We must not
 *     defeat that by letting the projection wobble, which is why the cascades
 *     are only re-split when the chase camera's FOV actually changes.
 *  2. Bias. A flat depth bias on a 2 km cascade either floats shadows off their
 *     casters or lets acne through on the near one. We set `normalBias` per
 *     cascade from that cascade's own world-space texel size, which is the
 *     slope-scaled term, and keep the constant bias tiny.
 *  3. Every lit material in the scene must be CSM-aware. CSM adds one
 *     directional light per cascade; a material that has not been set up runs
 *     the stock loop and gets lit N times over. Materials arrive from other
 *     subsystems at arbitrary times, so we sweep the graph and adopt them.
 */

const CASCADES = 4;
const MAX_FAR = 2200;

// Optional coarse terrain proxy used purely as a shadow caster. The real
// terrain mesh is camera-centred and 9 km wide, which is not something you want
// to re-render into four cascades every frame.
const CASTER_STEP = 18;      // metres between proxy vertices
const CASTER_HALF_WIDTH = 1000;
const CASTER_SINK = 6;       // metres of drop, so the proxy never shadows itself

export function createLightRig(scene, renderer, opts = {}) {
  const { terrainShadows = true, shadowMapSize = 2048, materialPatch = null } = opts;

  renderer.shadowMap.enabled = true;
  // VSM's blur leaks badly across a 2 km cascade and fights the CSM cascade
  // select; PCF-soft gives a stable, believably wide penumbra on snow.
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = true;

  const lightDirection = new THREE.Vector3(0.6, -0.4, 0.7).normalize();

  // CSM needs a camera up front; the real one only arrives on the first update.
  const proxyCamera = new THREE.PerspectiveCamera(58, 16 / 9, 0.1, 12000);

  const csm = new CSM({
    camera: proxyCamera,
    parent: scene,
    cascades: CASCADES,
    maxFar: MAX_FAR,
    mode: 'practical',
    shadowMapSize,
    shadowBias: -0.00008,
    lightDirection,
    lightIntensity: 1,
    lightNear: 1,
    lightFar: 6000,
    lightMargin: 900,
  });
  csm.fade = true;

  for (const light of csm.lights) {
    light.shadow.camera.near = 1;
    light.shadow.camera.far = 6000;
    light.shadow.blurSamples = 8;
    light.shadow.radius = 2.5;
  }

  const sun = csm.lights[0];

  // Sky bounce. The PMREM environment carries the directional part of the
  // ambient; this adds the strong upward bounce off the snowfield, which is
  // what stops shadow interiors from going flat blue.
  const bounce = new THREE.HemisphereLight(0xffffff, 0xffffff, 0);
  scene.add(bounce);

  const caster = terrainShadows ? buildTerrainCaster(scene) : null;

  // --- material adoption ---------------------------------------------------
  const adopted = new WeakMap(); // material -> our wrapper fn
  const breaksFor = new WeakMap();

  function isLit(m) {
    if (!m || m.userData?.skyNoCSM) return false;
    return !!(m.isMeshStandardMaterial || m.isMeshPhysicalMaterial ||
      m.isMeshPhongMaterial || m.isMeshLambertMaterial || m.isMeshToonMaterial ||
      (m.isShaderMaterial && m.lights));
  }

  function adopt(material) {
    if (adopted.get(material) === material.onBeforeCompile) return;
    const previous = adopted.has(material) ? null : material.onBeforeCompile;

    material.defines = material.defines || {};
    material.defines.USE_CSM = 1;
    material.defines.CSM_CASCADES = CASCADES;
    if (csm.fade) material.defines.CSM_FADE = '';

    if (!breaksFor.has(material)) breaksFor.set(material, []);
    const breaks = breaksFor.get(material);

    const wrapper = function (shader, rendererRef) {
      const far = Math.min(csm.camera.far, csm.maxFar);
      csm._getExtendedBreaks(breaks);
      shader.uniforms.CSM_cascades = { value: breaks };
      shader.uniforms.cameraNear = { value: csm.camera.near };
      shader.uniforms.shadowFar = { value: far };
      csm.shaders.set(material, shader);
      if (previous) previous.call(this, shader, rendererRef);
      // Aerial perspective goes on last, so it sees the final fragment shader
      // the owning module produced and folds the atmosphere over the top of it.
      if (materialPatch) materialPatch(shader, material);
    };

    material.onBeforeCompile = wrapper;
    adopted.set(material, wrapper);
    csm.shaders.set(material, null);
    material.needsUpdate = true;
  }

  function sweep(root) {
    root.traverse((o) => {
      const m = o.material;
      if (!m) return;
      if (Array.isArray(m)) { for (const sub of m) if (isLit(sub)) adopt(sub); }
      else if (isLit(m)) adopt(m);
    });
  }

  // --- per-frame -----------------------------------------------------------
  let lastFov = -1, lastAspect = -1, bound = false;

  function setSunDirection(sunDir) {
    lightDirection.copy(sunDir).multiplyScalar(-1).normalize();
    csm.lightDirection.copy(lightDirection);
  }

  function setSunLight(colorLinear, intensity) {
    for (const light of csm.lights) {
      light.color.copy(colorLinear);
      light.intensity = intensity;
    }
  }

  function setBounce(skyColor, groundColor, intensity) {
    bounce.color.copy(skyColor);
    bounce.groundColor.copy(groundColor);
    bounce.intensity = intensity;
  }

  function refreshBias() {
    for (let i = 0; i < csm.lights.length; i++) {
      const cam = csm.lights[i].shadow.camera;
      const texel = (cam.right - cam.left) / shadowMapSize;
      // Slope-scaled offset: push the receiver along its normal by rather more
      // than one texel so grazing sun angles on snow cannot self-shadow. Capped,
      // because on the 2 km cascade one texel is metres wide and an uncapped
      // offset detaches every shadow from its caster (classic peter-panning).
      csm.lights[i].shadow.normalBias = THREE.MathUtils.clamp(texel * 1.35, 0.03, 1.1);
      csm.lights[i].shadow.bias = -0.00004 - texel * 1e-6;
    }
  }

  function update(camera) {
    if (!bound) { csm.camera = camera; bound = true; lastFov = -1; }

    if (Math.abs(camera.fov - lastFov) > 0.35 || Math.abs(camera.aspect - lastAspect) > 0.01) {
      lastFov = camera.fov; lastAspect = camera.aspect;
      csm.updateFrustums();
      refreshBias();
    }

    sweep(scene);
    csm.update();
    csm._updateUniforms();
  }

  return {
    sun, csm, lights: csm.lights, caster,
    setSunDirection, setSunLight, setBounce, update,
    dispose() { csm.remove(); csm.dispose?.(); caster?.geometry.dispose(); },
  };
}

/**
 * A 22 m proxy of the run and its flanks, used only as a shadow caster.
 * Dropped a few metres below the real surface so that it contributes ridge and
 * headwall shadows without acne-ing the fine snow surface against itself.
 */
function buildTerrainCaster(scene) {
  const nz = Math.floor(COURSE_LENGTH / CASTER_STEP) + 1;
  const nx = Math.floor((CASTER_HALF_WIDTH * 2) / CASTER_STEP) + 1;

  const positions = new Float32Array(nz * nx * 3);
  let p = 0;
  for (let iz = 0; iz < nz; iz++) {
    const z = -iz * CASTER_STEP;
    const cx = courseXAt(z);
    for (let ix = 0; ix < nx; ix++) {
      const x = cx - CASTER_HALF_WIDTH + ix * CASTER_STEP;
      positions[p++] = x;
      positions[p++] = heightAt(x, z) - CASTER_SINK;
      positions[p++] = z;
    }
  }

  const idx = [];
  for (let iz = 0; iz < nz - 1; iz++) {
    for (let ix = 0; ix < nx - 1; ix++) {
      const a = iz * nx + ix, b = a + 1, c = a + nx, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
  geo.computeBoundingSphere();

  // three's shadow map tests every candidate caster against the *main* camera's
  // layer mask (WebGLShadowMap.renderObject), so a mesh parked on a layer the
  // camera does not draw is silently dropped from the shadow map as well. The
  // proxy therefore has to sit on layer 0 and be made invisible the only other
  // way available: a material that writes neither colour nor depth. The shadow
  // pass substitutes its own depth material, so the proxy still casts.
  const mat = new THREE.MeshBasicMaterial({
    colorWrite: false, depthWrite: false, depthTest: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'terrain-shadow-caster';
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  mesh.visible = true;   // must stay "visible" to be rendered into the shadow map
  mesh.renderOrder = -2000;
  scene.add(mesh);

  // ...and skipped entirely by the half-res depth prepass, which does override
  // the material and would otherwise stamp the sunken proxy into scene depth.
  import('../vfx/sceneDepth.js')
    .then((m) => m.excludeFromDepth?.(mesh))
    .catch(() => {});

  return mesh;
}
