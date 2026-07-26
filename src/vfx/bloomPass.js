import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import {
  BloomPrefilterShader, BloomDownShader, BloomUpShader, BloomCompositeShader,
} from '../shaders/postBloom.js';

/**
 * OWNER: agent "vfx".
 * Progressive HDR bloom. Half-res pyramid, 5 levels, ~1.4 full-screen passes
 * of bandwidth in total. Threshold is in scene-linear radiance.
 */
export class BloomPass extends Pass {
  constructor(width, height, { levels = 5, intensity = 0.06, threshold = 1.15, knee = 0.6, radius = 1.15 } = {}) {
    super();
    this.needsSwap = true;
    this.levels = levels;

    const mk = (s) => new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(s.uniforms),
      vertexShader: s.vertexShader,
      fragmentShader: s.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });

    this.prefilter = mk(BloomPrefilterShader);
    this.prefilter.uniforms.uThreshold.value = threshold;
    this.prefilter.uniforms.uKnee.value = knee;

    this.down = mk(BloomDownShader);
    this.up = mk(BloomUpShader);
    this.up.uniforms.uRadius.value = radius;
    this.up.blending = THREE.AdditiveBlending;
    this.up.transparent = true;

    this.composite = mk(BloomCompositeShader);
    this.composite.uniforms.uIntensity.value = intensity;
    this.composite.uniforms.uTint.value = new THREE.Vector3(1.0, 0.98, 0.94);

    this.prefilter.uniforms.uTexel.value = new THREE.Vector2();
    this.down.uniforms.uTexel.value = new THREE.Vector2();
    this.up.uniforms.uTexel.value = new THREE.Vector2();

    this._quad = new FullScreenQuad(this.prefilter);
    this.mips = [];
    this.setSize(width, height);
  }

  get intensity() { return this.composite.uniforms.uIntensity.value; }
  set intensity(v) { this.composite.uniforms.uIntensity.value = v; }

  setSize(width, height) {
    for (const m of this.mips) m.dispose();
    this.mips.length = 0;
    let w = Math.max(2, Math.floor(width * 0.5));
    let h = Math.max(2, Math.floor(height * 0.5));
    for (let i = 0; i < this.levels; i++) {
      const rt = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
      });
      rt.texture.wrapS = rt.texture.wrapT = THREE.ClampToEdgeWrapping;
      this.mips.push(rt);
      w = Math.max(2, Math.floor(w * 0.5));
      h = Math.max(2, Math.floor(h * 0.5));
    }
  }

  _blit(renderer, material, target) {
    this._quad.material = material;
    renderer.setRenderTarget(target);
    this._quad.render(renderer);
  }

  render(renderer, writeBuffer, readBuffer) {
    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = true;

    // Prefilter into mip 0.
    this.prefilter.uniforms.tDiffuse.value = readBuffer.texture;
    this.prefilter.uniforms.uTexel.value.set(1 / readBuffer.width, 1 / readBuffer.height);
    this._blit(renderer, this.prefilter, this.mips[0]);

    // Downsample.
    for (let i = 1; i < this.mips.length; i++) {
      const src = this.mips[i - 1];
      this.down.uniforms.tDiffuse.value = src.texture;
      this.down.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      this._blit(renderer, this.down, this.mips[i]);
    }

    // Upsample additively back up the pyramid.
    renderer.autoClear = false;
    for (let i = this.mips.length - 1; i > 0; i--) {
      const src = this.mips[i];
      this.up.uniforms.tDiffuse.value = src.texture;
      this.up.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
      this._blit(renderer, this.up, this.mips[i - 1]);
    }
    renderer.autoClear = prevAutoClear;

    // Composite.
    this.composite.uniforms.tDiffuse.value = readBuffer.texture;
    this.composite.uniforms.tBloom.value = this.mips[0].texture;
    this._quad.material = this.composite;
    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
    } else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) renderer.clear();
    }
    this._quad.render(renderer);
  }

  dispose() {
    for (const m of this.mips) m.dispose();
    this.prefilter.dispose(); this.down.dispose(); this.up.dispose(); this.composite.dispose();
    this._quad.dispose();
  }
}
