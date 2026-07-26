import * as THREE from 'three';
import { VFX_AMBIENT_VERT, VFX_AMBIENT_FRAG } from '../shaders/vfxAmbient.js';

/**
 * OWNER: agent "vfx".
 *
 * Airborne snow crystals + light snowfall, in an infinite wrapped domain.
 * See shaders/vfxAmbient.js for the wrap trick. Nothing here is pooled or
 * respawned: the CPU cost per frame is a handful of uniform writes.
 *
 * Two populations share the buffer:
 *   kind 0 — tiny hard crystals that glint (the "air has weight" layer)
 *   kind 1 — larger soft flakes that fall and smear with camera motion
 */
export class AmbientSnow {
  constructor(shared, opts = {}) {
    const count = opts.count ?? 2600;
    const box = opts.box ?? 78;
    this.box = box;

    const origin = new Float32Array(count * 3);
    const param = new Float32Array(count * 4);

    // Deterministic stratified scatter — a plain Math.random cloud clumps
    // visibly once you fly through it.
    let seed = 0x9e3779b9;
    const rnd = () => {
      seed ^= seed << 13; seed >>>= 0;
      seed ^= seed >> 17;
      seed ^= seed << 5; seed >>>= 0;
      return seed / 4294967296;
    };

    for (let i = 0; i < count; i++) {
      origin[i * 3] = (rnd() - 0.5) * box;
      origin[i * 3 + 1] = (rnd() - 0.5) * box;
      origin[i * 3 + 2] = (rnd() - 0.5) * box;

      const flake = rnd() < (opts.flakeRatio ?? 0.42) ? 1 : 0;
      const s = rnd();
      param[i * 4] = i / count;                                   // seed / cull key
      param[i * 4 + 1] = flake
        ? 0.045 + s * 0.075                                        // soft flakes
        : 0.014 + s * 0.026;                                       // hard crystals
      param[i * 4 + 2] = flake ? 0.42 + s * 0.35 : 0.55 + s * 0.45;
      param[i * 4 + 3] = flake;
    }

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
    ]), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    geo.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
    geo.setAttribute('aOrigin', new THREE.InstancedBufferAttribute(origin, 3));
    geo.setAttribute('aParam', new THREE.InstancedBufferAttribute(param, 4));
    geo.instanceCount = count;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.uniforms = {
      ...shared,
      uWind: { value: new THREE.Vector3(1.6, 0, 0.7) },
      uBox: { value: box },
      uFall: { value: opts.fall ?? 1.35 },
      uStretch: { value: new THREE.Vector2(0.055, 9) },
      uAmount: { value: 1 },
      uSoftFade: { value: 0.55 },
      uTint: { value: new THREE.Color(1, 1, 1) },
      uLight: { value: new THREE.Vector2(0.9, 3.2) },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VFX_AMBIENT_VERT,
      fragmentShader: VFX_AMBIENT_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquation: THREE.AddEquation,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      side: THREE.DoubleSide,
      toneMapped: false,
      fog: false,
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;
    this.mesh.matrixAutoUpdate = false;
    this.geometry = geo;
  }

  /** `amount` 0..1 culls the population without touching a single buffer. */
  setAmount(amount) { this.uniforms.uAmount.value = amount; }

  dispose() { this.geometry.dispose(); this.material.dispose(); }
}
