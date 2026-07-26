import * as THREE from 'three';
import { lateralOffset } from '../world/terrain.js';
import { excludeFromDepth } from './sceneDepth.js';
import { ParticlePool, createSharedUniforms } from './particlePool.js';
import { AmbientSnow } from './ambientParticles.js';

/**
 * OWNER: agent "vfx".
 *
 *   new SnowVFX(scene, { sky }) -> { update(dt, body, tricks, camera) }
 *
 * Every effect in here is a GPU pool (src/vfx/particlePool.js): particles are
 * written once at spawn and integrated entirely in the vertex shader, so
 * `update()` performs no allocation and no per-particle work. The whole system
 * is seven draw calls.
 *
 *   carve spray   fine sheet + billowing body off the engaged edge   (the hero)
 *   landing puff  impact ring scaled by body.lastLandImpact
 *   powder plume  deep-snow billow when off the groomed corridor
 *   vapour        contrail off the board while airborne
 *   spindrift     stretched ice needles blasting past at speed
 *   crash burst   one-shot explosion
 *   ambient       infinite wrapped crystals + snowfall (ambientParticles.js)
 *
 * Shading lives in shaders/vfxParticle.js — wrapped diffuse + a forward
 * scattering lobe, lit from the live sun, with soft-particle depth fade
 * against the shared prepass in sceneDepth.js.
 */

const TMP = {
  fwd: new THREE.Vector3(),
  right: new THREE.Vector3(),
  up: new THREE.Vector3(),
  out: new THREE.Vector3(),
  v: new THREE.Vector3(),
  camFwd: new THREE.Vector3(),
  camRight: new THREE.Vector3(),
  camUp: new THREE.Vector3(),
  prevCam: new THREE.Vector3(),
  camVel: new THREE.Vector3(),
  sun: new THREE.Vector3(),
};

const RIDE_HEIGHT = 0.09;

/** Fast deterministic PRNG — Math.random is fine but this keeps shots stable. */
let _seed = 0x2545f491;
function rnd() {
  _seed ^= _seed << 13; _seed >>>= 0;
  _seed ^= _seed >> 17;
  _seed ^= _seed << 5; _seed >>>= 0;
  return _seed / 4294967296;
}
const rr = (a, b) => a + (b - a) * rnd();
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

export class SnowVFX {
  constructor(scene, { sky } = {}) {
    this.scene = scene;
    this.sky = sky || null;
    this.time = 0;
    this.enabled = true;

    this.root = new THREE.Group();
    this.root.name = 'SnowVFX';
    this.root.matrixAutoUpdate = false;
    scene.add(this.root);
    // Transparent VFX must not write the depth they sample for soft particles.
    excludeFromDepth(this.root);

    this.shared = createSharedUniforms();

    // ---- pools ---------------------------------------------------------------
    // Counts are a budget, not a target: a few hundred well-shaded, correctly
    // lit clumps read as snow; ten thousand dots read as static.

    /** The fine sheet thrown straight off the edge. Sharp, fast, short-lived. */
    this.sprayFine = this._pool(2600, {
      turb: [0.55, 0.55, 0.9],
      sphericity: 0.62,
      erode: 0.88,
      wrap: 0.55,
      softFade: 0.75,
      nearFade: 0.7,
      fadeIn: 0.06, fadeOut: 0.42,
      light: { diffuse: 1.05, forward: 2.4, ambient: 0.6, density: 0.9 },
      renderOrder: 12,
    });

    /** The volume of the rooster tail — big, slow, translucent, backlit. */
    this.sprayBody = this._pool(1000, {
      turb: [0.85, 0.30, 0.55],
      sphericity: 1.0,
      erode: 0.55,
      wrap: 0.95,
      softFade: 2.2,
      nearFade: 1.1,
      fadeIn: 0.12, fadeOut: 0.30,
      light: { diffuse: 0.85, forward: 2.9, ambient: 0.72, density: 1.5 },
      renderOrder: 11,
    });

    /** Impact and deep-powder billows. Softest, slowest, most volumetric. */
    this.billow = this._pool(1200, {
      turb: [0.7, 0.22, 0.45],
      sphericity: 1.0,
      erode: 0.5,
      wrap: 1.05,
      softFade: 2.6,
      nearFade: 1.2,
      fadeIn: 0.1, fadeOut: 0.28,
      light: { diffuse: 0.8, forward: 2.6, ambient: 0.8, density: 1.7 },
      renderOrder: 11,
    });

    /** Grains: heavier, low drag, ballistic. Detail and sparkle. */
    this.grains = this._pool(900, {
      turb: [0.1, 0.5, 0.4],
      sphericity: 0.35,
      erode: 0.25,
      wrap: 0.35,
      softFade: 0.35,
      nearFade: 0.5,
      fadeIn: 0.04, fadeOut: 0.65,
      light: { diffuse: 1.25, forward: 2.0, ambient: 0.5, density: 0.4 },
      renderOrder: 13,
    });

    /** Vapour / contrail off the board in the air. Barely there, very soft. */
    this.vapour = this._pool(600, {
      turb: [0.5, 0.35, 0.3],
      sphericity: 1.0,
      erode: 0.3,
      wrap: 1.3,
      softFade: 2.8,
      nearFade: 1.0,
      fadeIn: 0.18, fadeOut: 0.22,
      light: { diffuse: 0.55, forward: 3.2, ambient: 1.0, density: 2.4 },
      renderOrder: 10,
    });

    /** Spindrift: stretched ice needles ripping past the lens at speed. */
    this.spindrift = this._pool(700, {
      stretch: true,
      stretchPerSpeed: 0.05,
      stretchMax: 16,
      turb: [0.2, 0.8, 1.4],
      sphericity: 0.25,
      erode: 0.15,
      wrap: 0.6,
      softFade: 0.5,
      nearFade: 0.25,
      fadeIn: 0.15, fadeOut: 0.35,
      light: { diffuse: 1.35, forward: 2.2, ambient: 0.55, density: 0.3 },
      renderOrder: 14,
    });

    this.ambient = new AmbientSnow(this.shared, { count: 2600, box: 78 });
    this.root.add(this.ambient.mesh);

    // ---- emission accumulators ------------------------------------------------
    this._acc = {
      fine: 0, body: 0, grain: 0, powder: 0, powderBig: 0, vapour: 0, drift: 0,
    };
    this._prevGrounded = true;
    this._prevCrashed = false;
    this._camInit = false;
    this._lateral = 0;
    this._lateralTimer = 0;
    this._spraySmooth = 0;
    this._boost = 0;

    // ---- lighting sources -----------------------------------------------------
    this._sun = sky?.sun || null;
    this._hemi = null;
    scene.traverse((o) => {
      if (!this._sun && o.isDirectionalLight) this._sun = o;
      if (!this._hemi && o.isHemisphereLight) this._hemi = o;
    });

    this._sunColor = new THREE.Color(1, 0.97, 0.92);
    this._skyColor = new THREE.Color(0.42, 0.55, 0.85);
    this._gndColor = new THREE.Color(0.62, 0.68, 0.8);
  }

  _pool(count, opts) {
    const p = new ParticlePool(count, this.shared, opts);
    this.root.add(p.mesh);
    return p;
  }

  // ─────────────────────────────────────────────────────────────────────────
  update(dt, body, tricks, camera) {
    if (!this.enabled || !body || !camera) return;
    const d = Math.min(Math.max(dt || 0, 0), 0.05);
    this.time += d;

    this._updateLighting(camera);
    this._updateCamera(d, camera);

    const speed = body.speed || 0;
    const grounded = !!body.grounded;
    const crashed = !!body.crashed;

    // Board basis. `body.up` is the smoothed surface normal — good enough for
    // VFX and free, where normalInto() would cost four more heightAt calls.
    const up = TMP.up.copy(body.up).normalize();
    const fwd = TMP.fwd.copy(body.forward);
    fwd.addScaledVector(up, -fwd.dot(up));
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    const right = TMP.right.crossVectors(fwd, up).normalize();

    // Ground plane through the board. Sampling heightAt per particle would
    // re-evaluate the course spline dozens of times a frame; the tangent plane
    // is exact to first order over the metre or two a spawn ever strays.
    this._gy = body.pos.y - (grounded ? RIDE_HEIGHT : 0);
    this._gn = up;

    // The course spline is expensive; off-piste state changes slowly.
    this._lateralTimer -= d;
    if (this._lateralTimer <= 0) {
      this._lateralTimer = 0.1;
      this._lateral = Math.abs(lateralOffset(body.pos.x, body.pos.z));
    }

    this._boost = tricks?.boost ? clamp01(tricks.boost) : 0;

    if (!crashed) {
      this._carve(d, body, tricks, speed, grounded, fwd, right, up);
      this._powder(d, body, speed, grounded, fwd, right, up);
      this._vapour(d, body, tricks, speed, grounded, fwd, up);
    }
    this._landing(d, body, tricks, grounded, fwd, right, up);
    this._crash(body, tricks, fwd, right, up);
    this._spindrift(d, camera, speed);
    this._ambientLevel(speed, grounded);

    this._prevGrounded = grounded;
    this._prevCrashed = crashed;

    this.sprayFine.flush();
    this.sprayBody.flush();
    this.billow.flush();
    this.grains.flush();
    this.vapour.flush();
    this.spindrift.flush();
  }

  /** Height of the local tangent plane at (x, z). */
  _planeY(x, z, bx, bz) {
    const n = this._gn;
    return this._gy - (n.x * (x - bx) + n.z * (z - bz)) / Math.max(n.y, 0.2);
  }

  // ── lighting ─────────────────────────────────────────────────────────────
  _updateLighting(camera) {
    const s = this.shared;
    s.uTime.value = this.time;

    // Sun direction in view space. The shader needs it there for the sphere
    // impostor normal, which is generated in view space.
    const dir = TMP.sun;
    if (this.sky?.sunDir) dir.copy(this.sky.sunDir);
    else if (this._sun) dir.copy(this._sun.position);
    else dir.set(-0.4, 0.8, 0.45);
    dir.normalize().transformDirection(camera.matrixWorldInverse);
    s.uSunView.value.copy(dir).normalize();

    // Author in scene-linear radiance: the post stack tone maps once, at the
    // end, and its bloom threshold sits at 1.05. Fully lit spray should land
    // just above that so only the brightest edges glare.
    const sun = this._sun;
    const gain = sun ? THREE.MathUtils.clamp(sun.intensity * 0.33, 0.35, 2.4) : 1.0;
    if (sun) this._sunColor.copy(sun.color).multiplyScalar(gain);
    else this._sunColor.setRGB(1.0, 0.97, 0.92);
    // Boost warms the spray very slightly — energy, not a colour cast.
    if (this._boost > 0.01) {
      this._sunColor.r *= 1 + this._boost * 0.10;
      this._sunColor.g *= 1 + this._boost * 0.04;
    }
    s.uSunColor.value.copy(this._sunColor);

    const hemi = this._hemi;
    if (hemi) {
      const hg = THREE.MathUtils.clamp(hemi.intensity * 0.30, 0.1, 1.2);
      this._skyColor.copy(hemi.color).multiplyScalar(hg);
      this._gndColor.copy(hemi.groundColor).multiplyScalar(hg * 0.85);
    }
    s.uSkyColor.value.copy(this._skyColor);
    s.uGroundColor.value.copy(this._gndColor);
    s.uCamPos.value.copy(camera.position);
  }

  _updateCamera(d, camera) {
    if (!this._camInit) { TMP.prevCam.copy(camera.position); this._camInit = true; }
    TMP.camVel.copy(camera.position).sub(TMP.prevCam).divideScalar(Math.max(d, 1e-4));
    if (TMP.camVel.lengthSq() > 40000) TMP.camVel.set(0, 0, 0); // teleport / reset
    TMP.prevCam.copy(camera.position);
    this.shared.uCamVel.value.lerp(TMP.camVel, 1 - Math.exp(-9 * d));

    camera.getWorldDirection(TMP.camFwd);
    TMP.camRight.crossVectors(TMP.camFwd, THREE.Object3D.DEFAULT_UP).normalize();
    TMP.camUp.crossVectors(TMP.camRight, TMP.camFwd).normalize();
  }

  // ── 1. carve spray ───────────────────────────────────────────────────────
  /**
   * The signature effect. Two coupled layers: a fast, sharp sheet that leaves
   * the edge tangentially, and a slow billowing body that hangs behind it and
   * catches the sun. Direction comes from the true board basis, so the tail
   * always leaves the OUTSIDE of the turn — the edge that is actually cutting.
   */
  _carve(d, body, tricks, speed, grounded, fwd, right, up) {
    const target = grounded && speed > 3 ? 1 : 0;
    this._spraySmooth += (target - this._spraySmooth) * (1 - Math.exp(-14 * d));
    if (this._spraySmooth < 0.01) return;

    const edge = body.edge || 0;
    const aEdge = Math.min(Math.abs(edge), 1);
    const sp = clamp01(speed / 26);
    const spOver = clamp01((speed - 26) / 34);
    // Bite: how much snow the edge is actually displacing.
    const bite = Math.pow(aEdge, 1.25) * sp;
    const scrape = sp * 0.28 + spOver * 0.2;
    const gate = this._spraySmooth;

    // Sign: increasing yaw turns towards +right and edge tracks -steer, so the
    // outside of the turn — where the snow goes — is -sign(edge) * right.
    const sgn = aEdge > 0.04 ? -Math.sign(edge) : (rnd() < 0.5 ? 1 : -1);
    const out = TMP.out.copy(right).multiplyScalar(sgn);

    const bx = body.pos.x, bz = body.pos.z;
    const powder = smooth(0.85, 1.6, this._lateral);
    const vol = 1 + powder * 0.75;

    // --- fine sheet -----------------------------------------------------------
    let n = this._count('fine', (150 * scrape + 1150 * bite) * gate * vol, d, 46);
    for (let i = 0; i < n; i++) {
      const s = this.sprayFine.spec;
      const u = rnd();
      const along = -0.85 + 1.25 * u * u;          // tail-biased along the board
      const lat = 0.03 + 0.18 * rnd();
      const px = bx + fwd.x * along + out.x * lat;
      const pz = bz + fwd.z * along + out.z * lat;
      s.px = px;
      s.pz = pz;
      s.py = this._planeY(px, pz, bx, bz) + 0.02 + rnd() * 0.1;

      const k = 0.30 + 0.70 * bite;
      const vo = speed * rr(0.14, 0.34) * k + rr(0.4, 1.6);
      const vu = speed * rr(0.11, 0.26) * k + rr(0.5, 1.8);
      const vf = speed * rr(0.0, 0.20);
      s.vx = out.x * vo + up.x * vu + fwd.x * vf + rr(-1.2, 1.2);
      s.vy = out.y * vo + up.y * vu + fwd.y * vf + rr(-0.4, 0.9);
      s.vz = out.z * vo + up.z * vu + fwd.z * vf + rr(-1.2, 1.2);

      s.life = rr(0.5, 1.05);
      s.size0 = rr(0.05, 0.13);
      s.size1 = rr(0.34, 0.78) * vol;
      s.drag = rr(2.4, 4.2);
      s.grav = rr(0.2, 0.45);
      s.alpha = rr(0.28, 0.55);
      s.r = 1; s.g = 1; s.b = rr(1.0, 1.05);
      s.spin = rr(-3, 3);
      this.sprayFine.emit(this.time);
    }

    // --- billowing body -------------------------------------------------------
    n = this._count('body', (10 * scrape + 165 * bite) * gate * vol, d, 14);
    for (let i = 0; i < n; i++) {
      const s = this.sprayBody.spec;
      const along = rr(-1.5, 0.1);
      const lat = rr(0.05, 0.55);
      const px = bx + fwd.x * along + out.x * lat;
      const pz = bz + fwd.z * along + out.z * lat;
      s.px = px;
      s.pz = pz;
      s.py = this._planeY(px, pz, bx, bz) + rr(0.05, 0.5);

      const k = 0.35 + 0.65 * bite;
      const vo = speed * rr(0.08, 0.22) * k;
      const vu = speed * rr(0.09, 0.20) * k + rr(0.6, 1.6);
      s.vx = out.x * vo + up.x * vu + fwd.x * speed * rr(0.0, 0.12) + rr(-0.7, 0.7);
      s.vy = out.y * vo + up.y * vu + rr(-0.2, 0.6);
      s.vz = out.z * vo + up.z * vu + fwd.z * speed * rr(0.0, 0.12) + rr(-0.7, 0.7);

      s.life = rr(1.0, 1.9);
      s.size0 = rr(0.3, 0.7);
      s.size1 = rr(1.7, 3.4) * vol;
      s.drag = rr(2.0, 3.2);
      s.grav = rr(0.05, 0.18);
      s.alpha = rr(0.14, 0.30);
      s.r = 1; s.g = 1; s.b = rr(1.0, 1.07);
      s.spin = rr(-0.7, 0.7);
      this.sprayBody.emit(this.time);
    }

    // --- heavy grains ---------------------------------------------------------
    n = this._count('grain', (18 * scrape + 190 * bite) * gate, d, 12);
    for (let i = 0; i < n; i++) {
      const s = this.grains.spec;
      const lat = 0.05 + 0.2 * rnd();
      const px = bx + fwd.x * rr(-0.7, 0.2) + out.x * lat;
      const pz = bz + fwd.z * rr(-0.7, 0.2) + out.z * lat;
      s.px = px;
      s.pz = pz;
      s.py = this._planeY(px, pz, bx, bz) + 0.05;

      const vo = speed * rr(0.2, 0.5) * (0.3 + 0.7 * bite);
      const vu = speed * rr(0.18, 0.4) * (0.3 + 0.7 * bite) + 1.5;
      s.vx = out.x * vo + up.x * vu + fwd.x * speed * rr(0.05, 0.3);
      s.vy = out.y * vo + up.y * vu;
      s.vz = out.z * vo + up.z * vu + fwd.z * speed * rr(0.05, 0.3);

      s.life = rr(0.7, 1.4);
      s.size0 = rr(0.02, 0.06);
      s.size1 = rr(0.03, 0.09);
      s.drag = rr(0.25, 0.8);
      s.grav = 1.0;
      s.alpha = rr(0.5, 0.95);
      s.r = 1; s.g = 1; s.b = 1.03;
      s.spin = 0;
      this.grains.emit(this.time);
    }
  }

  // ── 2. landing impact ────────────────────────────────────────────────────
  _landing(d, body, tricks, grounded, fwd, right, up) {
    if (!(grounded && !this._prevGrounded)) return;
    const impact = body.lastLandImpact || 0;
    if (impact < 1.5) return;

    const k = clamp01(impact / 26);
    const perfect = tricks?.lastLanding?.grade === 'perfect' ? 1.35 : 1;
    const scale = (0.35 + k * 1.15) * perfect;

    const bx = body.pos.x, bz = body.pos.z;
    const vx = body.vel.x * 0.22, vz = body.vel.z * 0.22;

    // Flat expanding ring: the shockwave of displaced snow.
    const nFine = Math.round(40 + 170 * k);
    for (let i = 0; i < nFine; i++) {
      const a = rnd() * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const dx = fwd.x * ca + right.x * sa;
      const dy = fwd.y * ca + right.y * sa;
      const dz = fwd.z * ca + right.z * sa;
      const rad = rr(0.1, 0.9) * (0.6 + scale);
      const px = bx + dx * rad, pz = bz + dz * rad;

      const s = this.sprayFine.spec;
      s.px = px; s.pz = pz;
      s.py = this._planeY(px, pz, bx, bz) + rr(0.02, 0.25);
      const vo = rr(2.5, 9) * scale;
      const vu = rr(0.6, 4.5) * scale;
      s.vx = dx * vo + up.x * vu + vx;
      s.vy = dy * vo + up.y * vu;
      s.vz = dz * vo + up.z * vu + vz;
      s.life = rr(0.6, 1.25);
      s.size0 = rr(0.07, 0.17);
      s.size1 = rr(0.5, 1.2) * (0.7 + scale * 0.5);
      s.drag = rr(2.6, 4.4);
      s.grav = rr(0.15, 0.4);
      s.alpha = rr(0.3, 0.6);
      s.r = 1; s.g = 1; s.b = 1.03;
      s.spin = rr(-3, 3);
      this.sprayFine.emit(this.time);
    }

    const nBig = Math.round(14 + 52 * k);
    for (let i = 0; i < nBig; i++) {
      const a = rnd() * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const dx = fwd.x * ca + right.x * sa;
      const dz = fwd.z * ca + right.z * sa;
      const rad = rr(0.2, 1.5) * (0.6 + scale);
      const px = bx + dx * rad, pz = bz + dz * rad;

      const s = this.billow.spec;
      s.px = px; s.pz = pz;
      s.py = this._planeY(px, pz, bx, bz) + rr(0.05, 0.6);
      const vo = rr(1.2, 5.0) * scale;
      const vu = rr(0.8, 3.6) * scale;
      s.vx = dx * vo + up.x * vu + vx * 0.7;
      s.vy = up.y * vu + rr(-0.2, 0.6);
      s.vz = dz * vo + up.z * vu + vz * 0.7;
      s.life = rr(1.2, 2.4);
      s.size0 = rr(0.35, 0.8);
      s.size1 = rr(1.9, 4.2) * (0.7 + scale * 0.6);
      s.drag = rr(1.8, 2.9);
      s.grav = rr(0.03, 0.14);
      s.alpha = rr(0.12, 0.28);
      s.r = 1; s.g = 1; s.b = rr(1.02, 1.09);
      s.spin = rr(-0.6, 0.6);
      this.billow.emit(this.time);
    }

    const nGrain = Math.round(10 + 60 * k);
    for (let i = 0; i < nGrain; i++) {
      const a = rnd() * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const dx = fwd.x * ca + right.x * sa;
      const dz = fwd.z * ca + right.z * sa;
      const s = this.grains.spec;
      s.px = bx + dx * 0.4; s.pz = bz + dz * 0.4;
      s.py = this._planeY(s.px, s.pz, bx, bz) + 0.08;
      const vo = rr(3, 12) * scale;
      s.vx = dx * vo + up.x * rr(2, 9) * scale + vx;
      s.vy = up.y * rr(2, 9) * scale;
      s.vz = dz * vo + up.z * rr(2, 9) * scale + vz;
      s.life = rr(0.8, 1.6);
      s.size0 = rr(0.02, 0.06);
      s.size1 = rr(0.03, 0.08);
      s.drag = rr(0.2, 0.7);
      s.grav = 1;
      s.alpha = rr(0.5, 1);
      s.r = 1; s.g = 1; s.b = 1.03;
      s.spin = 0;
      this.grains.emit(this.time);
    }
  }

  // ── 3. powder plume (off-piste / deep snow) ──────────────────────────────
  _powder(d, body, speed, grounded, fwd, right, up) {
    if (!grounded || speed < 5) return;
    const deep = smooth(0.9, 1.7, this._lateral);
    if (deep <= 0.01) return;

    const sp = clamp01(speed / 30);
    const bx = body.pos.x, bz = body.pos.z;

    // The trough the board ploughs: a wide, slow wall of snow rising behind.
    let n = this._count('powder', deep * (90 + 420 * sp), d, 30);
    for (let i = 0; i < n; i++) {
      const s = this.sprayFine.spec;
      const along = rr(-1.4, 0.35);
      const lat = rr(-0.75, 0.75);
      const px = bx + fwd.x * along + right.x * lat;
      const pz = bz + fwd.z * along + right.z * lat;
      s.px = px; s.pz = pz;
      s.py = this._planeY(px, pz, bx, bz) + rr(0.0, 0.35);
      const vu = speed * rr(0.10, 0.26) + rr(0.5, 2.0);
      s.vx = up.x * vu + right.x * lat * rr(2, 6) + fwd.x * speed * rr(0.0, 0.14) + rr(-0.8, 0.8);
      s.vy = up.y * vu + rr(-0.2, 0.5);
      s.vz = up.z * vu + right.z * lat * rr(2, 6) + fwd.z * speed * rr(0.0, 0.14) + rr(-0.8, 0.8);
      s.life = rr(0.8, 1.6);
      s.size0 = rr(0.1, 0.24);
      s.size1 = rr(0.8, 1.7);
      s.drag = rr(2.2, 3.6);
      s.grav = rr(0.1, 0.3);
      s.alpha = rr(0.22, 0.45);
      s.r = 1; s.g = 1; s.b = 1.04;
      s.spin = rr(-2, 2);
      this.sprayFine.emit(this.time);
    }

    n = this._count('powderBig', deep * (26 + 120 * sp), d, 10);
    for (let i = 0; i < n; i++) {
      const s = this.billow.spec;
      const along = rr(-2.6, 0.6);
      const lat = rr(-1.3, 1.3);
      const px = bx + fwd.x * along + right.x * lat;
      const pz = bz + fwd.z * along + right.z * lat;
      s.px = px; s.pz = pz;
      s.py = this._planeY(px, pz, bx, bz) + rr(0.1, 1.4);
      const vu = speed * rr(0.07, 0.18) + rr(0.6, 2.2);
      s.vx = up.x * vu + right.x * lat * rr(1, 3) + fwd.x * speed * rr(0.0, 0.1);
      s.vy = up.y * vu;
      s.vz = up.z * vu + right.z * lat * rr(1, 3) + fwd.z * speed * rr(0.0, 0.1);
      s.life = rr(1.4, 2.6);
      s.size0 = rr(0.5, 1.1);
      s.size1 = rr(2.4, 5.0);
      s.drag = rr(1.7, 2.6);
      s.grav = rr(0.02, 0.1);
      s.alpha = rr(0.1, 0.24);
      s.r = 1; s.g = 1; s.b = rr(1.02, 1.1);
      s.spin = rr(-0.5, 0.5);
      this.billow.emit(this.time);
    }
  }

  // ── 4. vapour / contrail ─────────────────────────────────────────────────
  _vapour(d, body, tricks, speed, grounded, fwd, up) {
    if (grounded || (body.airTime || 0) < 0.1 || speed < 7) return;
    const sp = clamp01(speed / 42);
    const uber = tricks?.uber ? 2.6 : 1;
    const n = this._count('vapour', (22 + 46 * sp) * uber, d, 8);
    const vx = body.vel.x, vy = body.vel.y, vz = body.vel.z;
    for (let i = 0; i < n; i++) {
      const s = this.vapour.spec;
      s.px = body.pos.x - fwd.x * rr(0.0, 0.9) + rr(-0.35, 0.35);
      s.py = body.pos.y + rr(-0.25, 0.35);
      s.pz = body.pos.z - fwd.z * rr(0.0, 0.9) + rr(-0.35, 0.35);
      s.vx = -vx * 0.04 + rr(-0.5, 0.5);
      s.vy = -vy * 0.03 + rr(-0.2, 0.5);
      s.vz = -vz * 0.04 + rr(-0.5, 0.5);
      s.life = rr(1.1, 2.1);
      s.size0 = rr(0.18, 0.4);
      s.size1 = rr(1.3, 2.8);
      s.drag = rr(1.0, 1.8);
      s.grav = rr(-0.04, 0.05);
      s.alpha = rr(0.05, 0.13) * (tricks?.uber ? 1.8 : 1);
      s.r = 1; s.g = 1; s.b = rr(1.05, 1.14);
      s.spin = rr(-0.4, 0.4);
      this.vapour.emit(this.time);
    }
  }

  // ── 5. spindrift / speed lines ───────────────────────────────────────────
  _spindrift(d, camera, speed) {
    const t = clamp01((speed - 24) / 34);
    if (t <= 0.01) return;
    const rush = t * t;
    const n = this._count('drift', 40 + 340 * rush, d, 26);
    const cam = camera.position;
    const f = TMP.camFwd, rt = TMP.camRight, u = TMP.camUp;
    const cv = this.shared.uCamVel.value;

    for (let i = 0; i < n; i++) {
      // Ring around the view axis: the centre of frame stays readable.
      const a = rnd() * Math.PI * 2;
      const rad = 1.6 + 7.5 * Math.sqrt(rnd());
      const ahead = rr(3, 20);
      const s = this.spindrift.spec;
      s.px = cam.x + f.x * ahead + rt.x * Math.cos(a) * rad + u.x * Math.sin(a) * rad;
      s.py = cam.y + f.y * ahead + rt.y * Math.cos(a) * rad + u.y * Math.sin(a) * rad;
      s.pz = cam.z + f.z * ahead + rt.z * Math.cos(a) * rad + u.z * Math.sin(a) * rad;
      // Driven against the camera so they both rip past AND stretch correctly.
      const k = rr(0.25, 0.6);
      s.vx = -cv.x * k + rr(-1.5, 1.5);
      s.vy = -cv.y * k + rr(-1, 1);
      s.vz = -cv.z * k + rr(-1.5, 1.5);
      s.life = rr(0.35, 0.75);
      s.size0 = rr(0.012, 0.03);
      s.size1 = rr(0.02, 0.05);
      s.drag = rr(0.1, 0.5);
      s.grav = rr(0.1, 0.4);
      s.alpha = rr(0.2, 0.7) * (0.35 + 0.65 * rush);
      s.r = 1; s.g = 1; s.b = 1.06;
      s.spin = 0;
      this.spindrift.emit(this.time);
    }
  }

  // ── 6. crash burst ───────────────────────────────────────────────────────
  _crash(body, tricks, fwd, right, up) {
    if (!body.crashed || this._prevCrashed) return;

    const speed = Math.min(body.speed || 0, 60);
    const k = clamp01(speed / 40);
    const bx = body.pos.x, bz = body.pos.z;
    const scale = 0.6 + k * 1.5;

    for (let i = 0; i < 240; i++) {
      const a = rnd() * Math.PI * 2;
      const e = rnd();
      const ca = Math.cos(a), sa = Math.sin(a);
      const dx = fwd.x * ca + right.x * sa;
      const dz = fwd.z * ca + right.z * sa;
      const s = this.sprayFine.spec;
      s.px = bx + dx * rr(0.1, 1.4);
      s.pz = bz + dz * rr(0.1, 1.4);
      s.py = this._planeY(s.px, s.pz, bx, bz) + rr(0.02, 1.0);
      const vo = rr(3, 14) * scale;
      const vu = rr(1, 9) * scale * (0.3 + e);
      s.vx = dx * vo + up.x * vu + body.vel.x * 0.35;
      s.vy = up.y * vu + rr(-1, 2);
      s.vz = dz * vo + up.z * vu + body.vel.z * 0.35;
      s.life = rr(0.7, 1.6);
      s.size0 = rr(0.07, 0.2);
      s.size1 = rr(0.6, 1.5);
      s.drag = rr(2.2, 4.0);
      s.grav = rr(0.2, 0.5);
      s.alpha = rr(0.35, 0.7);
      s.r = 1; s.g = 1; s.b = 1.03;
      s.spin = rr(-4, 4);
      this.sprayFine.emit(this.time);
    }

    for (let i = 0; i < 90; i++) {
      const a = rnd() * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const dx = fwd.x * ca + right.x * sa;
      const dz = fwd.z * ca + right.z * sa;
      const s = this.billow.spec;
      s.px = bx + dx * rr(0.2, 2.2);
      s.pz = bz + dz * rr(0.2, 2.2);
      s.py = this._planeY(s.px, s.pz, bx, bz) + rr(0.1, 1.6);
      const vo = rr(1.5, 7) * scale;
      const vu = rr(1, 5) * scale;
      s.vx = dx * vo + up.x * vu + body.vel.x * 0.2;
      s.vy = up.y * vu;
      s.vz = dz * vo + up.z * vu + body.vel.z * 0.2;
      s.life = rr(1.5, 3.0);
      s.size0 = rr(0.5, 1.2);
      s.size1 = rr(2.6, 5.5);
      s.drag = rr(1.5, 2.6);
      s.grav = rr(0.02, 0.12);
      s.alpha = rr(0.14, 0.32);
      s.r = 1; s.g = 1; s.b = rr(1.02, 1.1);
      s.spin = rr(-0.6, 0.6);
      this.billow.emit(this.time);
    }

    for (let i = 0; i < 140; i++) {
      const a = rnd() * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const dx = fwd.x * ca + right.x * sa;
      const dz = fwd.z * ca + right.z * sa;
      const s = this.grains.spec;
      s.px = bx + dx * 0.5;
      s.pz = bz + dz * 0.5;
      s.py = this._planeY(s.px, s.pz, bx, bz) + 0.15;
      const vo = rr(3, 16) * scale;
      s.vx = dx * vo + up.x * rr(3, 13) * scale + body.vel.x * 0.3;
      s.vy = up.y * rr(3, 13) * scale;
      s.vz = dz * vo + up.z * rr(3, 13) * scale + body.vel.z * 0.3;
      s.life = rr(0.9, 1.8);
      s.size0 = rr(0.02, 0.07);
      s.size1 = rr(0.03, 0.09);
      s.drag = rr(0.2, 0.7);
      s.grav = 1;
      s.alpha = rr(0.5, 1);
      s.r = 1; s.g = 1; s.b = 1.03;
      s.spin = 0;
      this.grains.emit(this.time);
    }
  }

  // ── 7. ambient air ───────────────────────────────────────────────────────
  _ambientLevel(speed, grounded) {
    // Thin the drifting crystals out at speed — at 200 km/h they would smear
    // the whole frame — and let the wind pick up with the rider.
    const t = clamp01(speed / 55);
    this.ambient.setAmount(0.95 - t * 0.35);
    const w = this.ambient.uniforms.uWind.value;
    w.set(1.5 + t * 3.0, -0.2, 0.7 + t * 1.2);
  }

  // ── emission accumulator ─────────────────────────────────────────────────
  _count(key, rate, dt, cap) {
    const acc = this._acc;
    acc[key] += rate * dt;
    let n = acc[key] | 0;
    if (n <= 0) return 0;
    acc[key] -= n;
    if (n > cap) { n = cap; acc[key] = 0; }
    return n;
  }

  // ── debug handles ────────────────────────────────────────────────────────
  get params() {
    return {
      shared: this.shared,
      pools: {
        sprayFine: this.sprayFine.uniforms,
        sprayBody: this.sprayBody.uniforms,
        billow: this.billow.uniforms,
        grains: this.grains.uniforms,
        vapour: this.vapour.uniforms,
        spindrift: this.spindrift.uniforms,
        ambient: this.ambient.uniforms,
      },
      setEnabled: (v) => { this.root.visible = !!v; },
    };
  }

  dispose() {
    for (const p of [this.sprayFine, this.sprayBody, this.billow, this.grains,
      this.vapour, this.spindrift]) p.dispose();
    this.ambient.dispose();
    this.scene.remove(this.root);
  }
}

export default SnowVFX;
