import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';

import { DepthPrepass, SceneDepth } from './sceneDepth.js';
import { BloomPass } from './bloomPass.js';
import { GodRaysPass } from './godRaysPass.js';
import { DofPass } from './dofPass.js';
import { MotionRushShader } from '../shaders/postMotion.js';
import { GradeShader } from '../shaders/postGrade.js';

/**
 * OWNER: agent "vfx".
 *
 * The frame. Everything the player ever sees goes through here.
 *
 *   half-res depth prepass  (shared with the particle system for soft particles)
 *   |- RenderPass            scene -> HDR half-float, 4x MSAA
 *   |- BloomPass             physically thresholded, 5-level pyramid
 *   |- GodRaysPass           quarter-res sun shafts, depth occluded
 *   |- DofPass               thin-lens, focused on the rider
 *   |- MotionRush            depth-reprojected camera blur + speed radial blur
 *   |- OutputPass            AgX tone map + sRGB  (applied exactly once)
 *   |- SMAAPass              edge AA on the display-referred image
 *   \- GradePass             lens, filmic grade, vignette, grain
 *
 * Tone mapping: the renderer is switched to NoToneMapping so the scene renders
 * into a genuinely HDR buffer (bloom thresholds and god-ray sources are only
 * meaningful on unclamped radiance). OutputPass then applies AgX once, at the
 * end of the HDR section. Other agents should keep authoring in scene-linear
 * radiance and must NOT re-enable renderer.toneMapping.
 */
export function createPostStack(engine, { sky } = {}) {
  const { renderer, scene, camera } = engine;

  // --- tone mapping ownership ----------------------------------------------
  const toneMapping = renderer.toneMapping === THREE.NoToneMapping
    ? THREE.AgXToneMapping
    : renderer.toneMapping;
  renderer.toneMapping = THREE.NoToneMapping; // applied once, in OutputPass

  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  let width = Math.max(2, size.x);
  let height = Math.max(2, size.y);

  // --- HDR pipeline ---------------------------------------------------------
  const hdrTarget = new THREE.WebGLRenderTarget(width, height, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: true,
    stencilBuffer: false,
    samples: 4,               // MSAA: the terrain silhouette is the worst offender
    generateMipmaps: false,
  });
  hdrTarget.texture.name = 'post.hdr';

  const composer = new EffectComposer(renderer, hdrTarget);
  composer.renderTarget2.samples = 0; // only the scene pass needs multisampling

  const depthPrepass = new DepthPrepass(renderer, scene, camera, 0.5);

  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  const bloom = new BloomPass(width, height, {
    levels: 5,
    intensity: 0.075,
    threshold: 1.05,   // scene-linear: sunlit snow sits just under this
    knee: 0.65,
    radius: 1.2,
  });
  composer.addPass(bloom);

  const godRays = new GodRaysPass(width, height, camera, { intensity: 0.9, scale: 0.25 });
  composer.addPass(godRays);

  // Kept deliberately subtle. The rider sits ~10m from the camera and the
  // mountain behind them is kilometres away, so an aggressive CoC blurs the
  // entire background into mush and throws away the scale the terrain works
  // hard to establish. This should read as a soft foreground/background
  // separation, not as a photographic macro shot.
  const dof = new DofPass(width, height, {
    maxCoC: 1.15,
    strength: 0.32,
    farRange: 1400,   // metres before the far blur reaches full strength
    farScale: 0.55,
    nearScale: 0.30,
  });
  composer.addPass(dof);

  // --- motion blur / speed rush --------------------------------------------
  const motion = new ShaderPass(MotionRushShader);
  motion.material.uniforms.tDepth = SceneDepth.texture;
  motion.material.uniforms.uDepthParams = SceneDepth.params;
  motion.material.uniforms.uInvViewProj.value = new THREE.Matrix4();
  motion.material.uniforms.uPrevViewProj.value = new THREE.Matrix4();
  motion.material.uniforms.uCenter.value = new THREE.Vector2(0.5, 0.5);
  composer.addPass(motion);

  // --- tone map + colour space (exactly once) -------------------------------
  class ToneMappedOutputPass extends OutputPass {
    render(r, writeBuffer, readBuffer, deltaTime, maskActive) {
      const prev = r.toneMapping;
      r.toneMapping = toneMapping;
      super.render(r, writeBuffer, readBuffer, deltaTime, maskActive);
      r.toneMapping = prev;
    }
  }
  composer.addPass(new ToneMappedOutputPass());

  // --- AA on the display-referred image ------------------------------------
  const smaa = new SMAAPass(width, height);
  composer.addPass(smaa);

  // --- grade ----------------------------------------------------------------
  const grade = new ShaderPass(GradeShader);
  const gu = grade.material.uniforms;
  gu.uResolution.value = new THREE.Vector2(width, height);
  // Punchy rather than filmic. Shadows go cool-blue (sky-lit snow really is
  // blue in shadow), highlights stay clean white rather than warming off into
  // cream, and the lift is nearly zero — lifting blacks is what was making
  // every frame look hazy and washed out.
  gu.uShadowTint.value = new THREE.Vector3(0.86, 0.94, 1.12);
  gu.uHighlightTint.value = new THREE.Vector3(1.02, 1.01, 0.99);
  gu.uLift.value = new THREE.Vector3(0.002, 0.004, 0.010);
  gu.uSaturation.value = 1.24;
  gu.uContrast.value = 1.14;
  gu.uVignette.value = 0.30;
  gu.uAberration.value = 0.0012;
  grade.renderToScreen = true;
  composer.addPass(grade);

  // --- per-frame state ------------------------------------------------------
  const prevViewProj = new THREE.Matrix4();
  const viewProj = new THREE.Matrix4();
  const prevCamPos = new THREE.Vector3().copy(camera.position);
  const camDelta = new THREE.Vector3();
  const focusPoint = new THREE.Vector3();
  const tmpDir = new THREE.Vector3();

  let elapsed = 0;
  let speed01 = 0;      // smoothed 0..1 rush amount
  let first = true;

  /** Optional external state — see docs/REQUESTS-vfx.md. */
  let body = null;
  let tricks = null;

  const RUSH_START = 24;   // m/s where the rush starts to be felt
  const RUSH_FULL = 62;

  function currentBody() {
    return body || globalThis.__game?.body || null;
  }

  function updateSun() {
    const dir = sky?.sunDir || sky?.sun?.position;
    if (dir) godRays.setSunDir(tmpDir.copy(dir).normalize());
  }

  function render(dt) {
    const d = Math.min(Math.max(dt || 0.016, 1 / 480), 0.1);
    elapsed += d;

    // 1. depth prepass — shared by DOF, god rays, motion blur, soft particles
    depthPrepass.render();

    // 2. speed / rush
    const b = currentBody();
    camDelta.copy(camera.position).sub(prevCamPos);
    const camSpeed = camDelta.length() / d;
    const rawSpeed = b ? b.speed : camSpeed;
    const boost = tricks?.boost ? THREE.MathUtils.clamp(tricks.boost, 0, 1) : 0;
    const target = THREE.MathUtils.clamp(
      (rawSpeed - RUSH_START) / (RUSH_FULL - RUSH_START), 0, 1,
    ) * (1 + boost * 0.35);
    speed01 += (target - speed01) * (1 - Math.exp(-3.5 * d));

    const rush = speed01 * speed01;
    motion.material.uniforms.uRush.value = rush * 0.028;
    motion.material.uniforms.uSeed.value = (elapsed * 61.7) % 1000;
    grade.material.uniforms.uRush.value = rush;
    grade.material.uniforms.uTime.value = elapsed;
    // Bloom blooms a touch harder at speed — glare from the rush of light.
    bloom.intensity = 0.075 + rush * 0.03;

    // 3. reprojection matrices for camera motion blur
    camera.updateMatrixWorld();
    viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    if (first) { prevViewProj.copy(viewProj); first = false; }
    motion.material.uniforms.uInvViewProj.value.copy(viewProj).invert();
    motion.material.uniforms.uPrevViewProj.value.copy(prevViewProj);
    // Keep the blur length a fixed fraction of a 60Hz frame at any frame rate.
    motion.material.uniforms.uVelScale.value = THREE.MathUtils.clamp(0.5 * (1 / 60) / d, 0.05, 1.2);

    // 4. focus: the rider, always
    if (b) {
      focusPoint.copy(b.pos);
      dof.update(d, camera.position.distanceTo(focusPoint));
    } else {
      dof.update(d, 11);
    }

    // 5. sun shafts
    updateSun();

    composer.render(d);

    prevViewProj.copy(viewProj);
    prevCamPos.copy(camera.position);
  }

  function resize(w, h) {
    const dpr = renderer.getPixelRatio();
    width = Math.max(2, Math.floor(w * dpr));
    height = Math.max(2, Math.floor(h * dpr));
    composer.setSize(w, h);
    depthPrepass.setSize(width, height);
    bloom.setSize(width, height);
    godRays.setSize(width, height);
    dof.setSize(width, height);
    smaa.setSize(w, h);
    grade.material.uniforms.uResolution.value.set(width, height);
  }

  resize(engine.width || Math.floor(width / renderer.getPixelRatio()),
    engine.height || Math.floor(height / renderer.getPixelRatio()));

  return {
    render,
    resize,

    /**
     * Optional: hand the post stack the live gameplay state. Without it the
     * stack falls back to globalThis.__game.body and to camera-derived speed,
     * which is close but one frame late. See docs/REQUESTS-vfx.md.
     */
    setState(nextBody, nextTricks) { body = nextBody || null; tricks = nextTricks || null; },

    /** Live tuning handles for tools/probe.mjs and the in-page console. */
    get params() {
      return {
        bloom: bloom.composite.uniforms,
        godRays: godRays.composite.uniforms,
        dof,
        motion: motion.material.uniforms,
        grade: grade.material.uniforms,
        speed01: () => speed01,
      };
    },

    composer,
    dispose() {
      depthPrepass.dispose();
      bloom.dispose(); godRays.dispose(); dof.dispose();
      composer.dispose();
      hdrTarget.dispose();
    },
  };
}
