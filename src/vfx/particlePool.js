import * as THREE from 'three';
import { SceneDepth } from './sceneDepth.js';
import { VFX_PARTICLE_VERT, VFX_PARTICLE_FRAG } from '../shaders/vfxParticle.js';

/**
 * OWNER: agent "vfx".
 *
 * A fixed-size, zero-allocation GPU particle pool.
 *
 * One draw call, one InstancedBufferGeometry, one ring buffer. `emit()` writes
 * five vec3/vec4s into typed arrays and nothing else ever happens on the CPU —
 * position, velocity, size, rotation, fade and lighting are all evaluated in
 * the vertex/fragment shader from the spawn state (see shaders/vfxParticle.js).
 *
 * Spawning is done through the reusable `spec` object rather than an argument
 * list or an options literal, precisely so `update()` allocates nothing:
 *
 *     const s = pool.spec;
 *     s.px = x; s.py = y; s.pz = z;
 *     s.vx = ...; s.life = ...; s.size0 = ...;
 *     pool.emit();
 *
 * Dirty tracking uploads only the slots that were written this frame.
 */

const QUAD_POS = new Float32Array([
  -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
]);
const QUAD_UV = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
const QUAD_INDEX = new Uint16Array([0, 1, 2, 0, 2, 3]);

/** Shared per-frame lighting/depth uniforms. One object, bound by reference. */
export function createSharedUniforms() {
  return {
    uTime: { value: 0 },
    uSunView: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(1, 1, 1) },
    uSkyColor: { value: new THREE.Color(0.35, 0.5, 0.8) },
    uGroundColor: { value: new THREE.Color(0.5, 0.56, 0.66) },
    uCamPos: { value: new THREE.Vector3() },
    uCamVel: { value: new THREE.Vector3() },
    tDepth: SceneDepth.texture,
    uDepthParams: SceneDepth.params,
    uDepthEnabled: SceneDepth.enabled,
  };
}

export class ParticlePool {
  /**
   * @param {number} count      pool size (hard cap on live particles)
   * @param {object} shared     shared uniforms from createSharedUniforms()
   * @param {object} opts       look + motion defaults
   */
  constructor(count, shared, opts = {}) {
    this.count = count;
    this.head = 0;
    this._lo = Infinity;
    this._hi = -Infinity;
    this._full = false;

    this.aOrigin = new Float32Array(count * 3);
    this.aVel = new Float32Array(count * 3);
    this.aTime = new Float32Array(count * 4);
    this.aShape = new Float32Array(count * 4);
    this.aTint = new Float32Array(count * 4);

    // Every slot starts dead: life 0 means age >= 1 on the first frame.
    for (let i = 0; i < count; i++) this.aTime[i * 4 + 1] = 0.0001;

    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(QUAD_POS, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(QUAD_UV, 2));
    geo.setIndex(new THREE.BufferAttribute(QUAD_INDEX, 1));

    const mk = (arr, size) => {
      const a = new THREE.InstancedBufferAttribute(arr, size);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this._attrs = [
      geo.setAttribute('aOrigin', mk(this.aOrigin, 3)).getAttribute('aOrigin'),
      geo.setAttribute('aVel', mk(this.aVel, 3)).getAttribute('aVel'),
      geo.setAttribute('aTime', mk(this.aTime, 4)).getAttribute('aTime'),
      geo.setAttribute('aShape', mk(this.aShape, 4)).getAttribute('aShape'),
      geo.setAttribute('aTint', mk(this.aTint, 4)).getAttribute('aTint'),
    ];
    geo.instanceCount = count;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const L = opts.light || {};
    this.uniforms = {
      ...shared,
      uGravity: { value: new THREE.Vector3(0, -9.81, 0) },
      uWind: { value: (opts.wind || new THREE.Vector3()).clone() },
      uTurb: { value: new THREE.Vector3(...(opts.turb || [0, 0, 0])) },
      uFadeCurve: { value: new THREE.Vector2(opts.fadeIn ?? 0.12, opts.fadeOut ?? 0.55) },
      uStretch: { value: new THREE.Vector2(opts.stretchPerSpeed ?? 0.06, opts.stretchMax ?? 6) },
      uSoftFade: { value: opts.softFade ?? 1.4 },
      uNearFade: { value: opts.nearFade ?? 0.9 },
      uLight: {
        value: new THREE.Vector4(
          L.diffuse ?? 1.0, L.forward ?? 1.6, L.ambient ?? 0.55, L.density ?? 1.0,
        ),
      },
      uSphericity: { value: opts.sphericity ?? 0.85 },
      uErode: { value: opts.erode ?? 0.7 },
      uWrap: { value: opts.wrap ?? 0.7 },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VFX_PARTICLE_VERT,
      fragmentShader: VFX_PARTICLE_FRAG,
      defines: opts.stretch ? { VFX_STRETCH: '' } : {},
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,             // premultiplied: rgb may exceed a
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
    this.mesh.renderOrder = opts.renderOrder ?? 10;
    this.mesh.matrixAutoUpdate = false;
    this.geometry = geo;

    // Reusable spawn record — see the class doc.
    this.spec = {
      px: 0, py: 0, pz: 0,
      vx: 0, vy: 0, vz: 0,
      life: 1, size0: 0.2, size1: 0.8,
      drag: 2.0, grav: 0.3, alpha: 1,
      r: 1, g: 1, b: 1, spin: 0,
    };
  }

  /** Write the current `spec` into the next ring slot. */
  emit(time) {
    const i = this.head;
    this.head = (this.head + 1) % this.count;
    const s = this.spec;

    const i3 = i * 3;
    this.aOrigin[i3] = s.px; this.aOrigin[i3 + 1] = s.py; this.aOrigin[i3 + 2] = s.pz;
    this.aVel[i3] = s.vx; this.aVel[i3 + 1] = s.vy; this.aVel[i3 + 2] = s.vz;

    const i4 = i * 4;
    this.aTime[i4] = time;
    this.aTime[i4 + 1] = s.life;
    this.aTime[i4 + 2] = (i * 0.61803398875) % 1;
    this.aTime[i4 + 3] = s.size0;

    this.aShape[i4] = s.size1;
    this.aShape[i4 + 1] = s.drag;
    this.aShape[i4 + 2] = s.grav;
    this.aShape[i4 + 3] = s.alpha;

    this.aTint[i4] = s.r;
    this.aTint[i4 + 1] = s.g;
    this.aTint[i4 + 2] = s.b;
    this.aTint[i4 + 3] = s.spin;

    if (i < this._lo) this._lo = i;
    if (i > this._hi) this._hi = i;
    if (this.head === 0) this._full = true;   // wrapped this frame
  }

  /** Upload only what changed. Called once per frame by SnowVFX. */
  flush() {
    if (this._hi < 0) return;
    const lo = this._full ? 0 : this._lo;
    const hi = this._full ? this.count - 1 : this._hi;
    const n = hi - lo + 1;
    for (let a = 0; a < this._attrs.length; a++) {
      const attr = this._attrs[a];
      attr.clearUpdateRanges();
      attr.addUpdateRange(lo * attr.itemSize, n * attr.itemSize);
      attr.needsUpdate = true;
    }
    this._lo = Infinity;
    this._hi = -Infinity;
    this._full = false;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
