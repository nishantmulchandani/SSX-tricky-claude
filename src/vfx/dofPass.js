import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { DofGatherShader, DofCompositeShader } from '../shaders/postDof.js';
import { SceneDepth } from './sceneDepth.js';

/**
 * OWNER: agent "vfx".
 * Half-resolution bokeh gather + full-resolution composite.
 * Focus distance is driven externally (distance camera -> rider) and damped,
 * so the focal plane never snaps.
 */
export class DofPass extends Pass {
  constructor(width, height, { maxCoC = 2.6, strength = 0.85 } = {}) {
    super();
    this.needsSwap = true;
    this.focus = 10;
    this.targetFocus = 10;
    this.strength = strength;

    const mk = (s) => new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(s.uniforms),
      vertexShader: s.vertexShader,
      fragmentShader: s.fragmentShader,
      depthTest: false, depthWrite: false,
    });

    this.gather = mk(DofGatherShader);
    this.gather.uniforms.tDepth = SceneDepth.texture;
    this.gather.uniforms.uDepthParams = SceneDepth.params;
    this.gather.uniforms.uTexel.value = new THREE.Vector2();
    this.gather.uniforms.uMaxCoC.value = maxCoC;

    this.comp = mk(DofCompositeShader);
    this.comp.uniforms.tDepth = SceneDepth.texture;
    this.comp.uniforms.uDepthParams = SceneDepth.params;
    this.comp.uniforms.uMaxCoC.value = maxCoC;
    this.comp.uniforms.uStrength.value = strength;

    this._quad = new FullScreenQuad(this.gather);
    this.rt = null;
    this.setSize(width, height);
  }

  setSize(width, height) {
    const w = Math.max(2, Math.floor(width * 0.5));
    const h = Math.max(2, Math.floor(height * 0.5));
    this.rt?.dispose();
    this.rt = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });
    this.rt.texture.wrapS = this.rt.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.gather.uniforms.uTexel.value.set(1 / w, 1 / h);
  }

  /** Damped focus pull. */
  update(dt, focusDistance) {
    if (focusDistance > 0) this.targetFocus = focusDistance;
    const k = 1 - Math.exp(-6 * Math.min(dt, 0.1));
    this.focus += (this.targetFocus - this.focus) * k;
    this.gather.uniforms.uFocus.value = this.focus;
    this.comp.uniforms.uFocus.value = this.focus;
  }

  render(renderer, writeBuffer, readBuffer) {
    if (!SceneDepth.enabled.value || this.strength <= 0.001) {
      // Nothing to do — let the chain carry on with the read buffer.
      this.comp.uniforms.uStrength.value = 0;
    } else {
      this.comp.uniforms.uStrength.value = this.strength;
    }

    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = true;

    this.gather.uniforms.tDiffuse.value = readBuffer.texture;
    this._quad.material = this.gather;
    renderer.setRenderTarget(this.rt);
    this._quad.render(renderer);

    this.comp.uniforms.tDiffuse.value = readBuffer.texture;
    this.comp.uniforms.tBlur.value = this.rt.texture;
    this._quad.material = this.comp;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (!this.renderToScreen && this.clear) renderer.clear();
    this._quad.render(renderer);

    renderer.autoClear = prevAutoClear;
  }

  dispose() {
    this.rt?.dispose();
    this.gather.dispose(); this.comp.dispose(); this._quad.dispose();
  }
}
