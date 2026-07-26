import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { GodRaySourceShader, GodRayBlurShader, GodRayCompositeShader } from '../shaders/postGodrays.js';
import { SceneDepth } from './sceneDepth.js';

/**
 * OWNER: agent "vfx".
 * Sun shafts at quarter resolution: source + 3 radial blur iterations with
 * geometrically increasing reach (10 taps each = 1000 effective samples).
 */
export class GodRaysPass extends Pass {
  constructor(width, height, camera, { intensity = 0.85, scale = 0.25 } = {}) {
    super();
    this.needsSwap = true;
    this.camera = camera;
    this.scale = scale;
    this.sunDir = new THREE.Vector3(0, 1, 0);

    const mk = (s) => new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(s.uniforms),
      vertexShader: s.vertexShader,
      fragmentShader: s.fragmentShader,
      depthTest: false, depthWrite: false,
    });

    this.sunUv = new THREE.Vector2(0.5, 0.5);

    this.source = mk(GodRaySourceShader);
    this.source.uniforms.tDepth = SceneDepth.texture;
    this.source.uniforms.uDepthParams = SceneDepth.params;
    this.source.uniforms.uSunUv.value = this.sunUv;

    this.blur = mk(GodRayBlurShader);
    this.blur.uniforms.uSunUv.value = this.sunUv;

    this.composite = mk(GodRayCompositeShader);
    this.composite.uniforms.uSunUv.value = this.sunUv;
    this.composite.uniforms.uTint.value = new THREE.Vector3(1.0, 0.86, 0.66);
    this.composite.uniforms.uIntensity.value = intensity;

    this._quad = new FullScreenQuad(this.source);
    this._sunWorld = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
    this.rtA = null; this.rtB = null;
    this.setSize(width, height);
  }

  setSize(width, height) {
    const w = Math.max(4, Math.floor(width * this.scale));
    const h = Math.max(4, Math.floor(height * this.scale));
    this.rtA?.dispose(); this.rtB?.dispose();
    const opts = {
      type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    };
    this.rtA = new THREE.WebGLRenderTarget(w, h, opts);
    this.rtB = new THREE.WebGLRenderTarget(w, h, opts);
    this.rtA.texture.wrapS = this.rtA.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.rtB.texture.wrapS = this.rtB.texture.wrapT = THREE.ClampToEdgeWrapping;
    this._aspect = width / height;
    this.source.uniforms.uAspect.value = this._aspect;
    this.composite.uniforms.uAspect.value = this._aspect;
  }

  /** @param dir normalised world direction *towards* the sun. */
  setSunDir(dir) { this.sunDir.copy(dir); }

  _updateSun() {
    const cam = this.camera;
    cam.getWorldDirection(this._fwd);
    const facing = this._fwd.dot(this.sunDir);

    this._sunWorld.copy(cam.position).addScaledVector(this.sunDir, 40000);
    this._sunWorld.project(cam);
    this.sunUv.set(this._sunWorld.x * 0.5 + 0.5, this._sunWorld.y * 0.5 + 0.5);

    // Fade out as the sun leaves the frustum: no shafts from off-screen light.
    let vis = THREE.MathUtils.smoothstep(facing, 0.05, 0.45);
    const edge = Math.max(
      Math.abs(this.sunUv.x - 0.5) - 0.5,
      Math.abs(this.sunUv.y - 0.5) - 0.5,
    );
    vis *= 1.0 - THREE.MathUtils.smoothstep(edge, 0.0, 0.35);
    this.composite.uniforms.uVisibility.value = vis;
    return vis;
  }

  render(renderer, writeBuffer, readBuffer) {
    const vis = this._updateSun();
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = true;

    if (vis > 0.001 && SceneDepth.enabled.value) {
      this.source.uniforms.tDiffuse.value = readBuffer.texture;
      this._quad.material = this.source;
      renderer.setRenderTarget(this.rtA);
      this._quad.render(renderer);

      // Three iterations, each reaching 4x further than the last.
      let src = this.rtA, dst = this.rtB;
      const steps = [1.0, 0.25, 0.0625];
      for (let i = 0; i < steps.length; i++) {
        this.blur.uniforms.tDiffuse.value = src.texture;
        this.blur.uniforms.uStep.value = steps[i];
        this._quad.material = this.blur;
        renderer.setRenderTarget(dst);
        this._quad.render(renderer);
        const t = src; src = dst; dst = t;
      }
      this.composite.uniforms.tRays.value = src.texture;
    } else {
      this.composite.uniforms.uVisibility.value = 0;
      this.composite.uniforms.tRays.value = this.rtA.texture;
    }

    this.composite.uniforms.tDiffuse.value = readBuffer.texture;
    this._quad.material = this.composite;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (!this.renderToScreen && this.clear) renderer.clear();
    this._quad.render(renderer);
    renderer.autoClear = prevAutoClear;
  }

  dispose() {
    this.rtA?.dispose(); this.rtB?.dispose();
    this.source.dispose(); this.blur.dispose(); this.composite.dispose();
    this._quad.dispose();
  }
}
