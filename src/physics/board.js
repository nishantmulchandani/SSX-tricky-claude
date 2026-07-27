import * as THREE from 'three';
import { heightAt, normalInto, courseXAt } from '../world/terrain.js';

const GRAVITY = 22.0;          // exaggerated — SSX gravity, not Earth gravity
const RIDE_HEIGHT = 0.09;
const SELF_CENTRE = 1.15;      // rad/s of yaw pull towards the direction of travel
// How far the board may point away from the course direction while carving.
// This is the difference between an arcade racer and an ice rink: without it,
// a sustained input keeps integrating yaw until the rider is travelling
// sideways at 40 m/s and oscillating +/-47m across the track.
const MAX_CARVE = 0.58;        // radians (~33 deg)
const SOFT_MAX_SPEED = 66;     // m/s (~240 km/h) — governed arcade top speed
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Arcade snowboard physics. The design targets are, in priority order:
 *   1. Carving must feel like it bites — lateral velocity is killed hard on edge.
 *   2. Speed must be *earned* (tuck, clean landings, pumping transitions).
 *   3. Air must be floaty enough to land 1080s but never feel weightless.
 *
 * State lives in world space; the visual transform is derived, never authored.
 */
export class BoardPhysics {
  constructor() {
    this.pos = new THREE.Vector3(0, 0, -20);
    this.vel = new THREE.Vector3(0, 0, -6);
    this.up = new THREE.Vector3(0, 1, 0);       // surface-aligned up
    this.forward = new THREE.Vector3(0, 0, -1); // board heading, on the surface plane
    this.yaw = 0;                                // heading around world Y
    this.roll = 0;                               // edge angle, radians
    this.pitch = 0;

    this.grounded = true;
    this.airTime = 0;
    this.groundTime = 0;
    this.crouch = 0;      // 0..1 — charged by holding jump
    this.edge = 0;        // -1..1 signed edge engagement
    this.speed = 0;
    this.lastLandImpact = 0;
    this.crashed = false;
    this.crashTimer = 0;

    this._n = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._flat = new THREE.Vector3();
  }

  reset(z = -20) {
    this.pos.set(0, heightAt(0, z) + 1, z);
    this.vel.set(0, 0, -8);
    this.yaw = 0; this.roll = 0; this.pitch = 0;
    this.crashed = false; this.crashTimer = 0; this.airTime = 0;
  }

  /**
   * @param dt fixed timestep
   * @param input { steer:-1..1, pitch:-1..1, jumpHeld:bool, jumpPressed:bool, brake:bool }
   * @param air   air-state controller (spin/flip) — see tricks/trickSystem.js
   */
  step(dt, input) {
    const n = normalInto(this._n, this.pos.x, this.pos.z, 1.0);
    const ground = heightAt(this.pos.x, this.pos.z);
    const gap = this.pos.y - ground;

    if (this.crashed) {
      this.crashTimer -= dt;
      this.vel.y -= GRAVITY * dt;
      this.vel.x *= 0.985; this.vel.z *= 0.985;
      this.pos.addScaledVector(this.vel, dt);
      if (this.pos.y < ground + 0.3) { this.pos.y = ground + 0.3; this.vel.y = 0; }
      if (this.crashTimer <= 0) { this.crashed = false; this.vel.setLength(Math.max(6, this.speed * 0.4)); }
      this.speed = this.vel.length();
      return;
    }

    // ---- ground contact -----------------------------------------------------
    const wasGrounded = this.grounded;
    this.grounded = gap <= RIDE_HEIGHT + 0.02 && this.vel.y <= 2.0;

    if (this.grounded) {
      this.airTime = 0;
      this.groundTime += dt;
      this.up.lerp(n, 1 - Math.exp(-18 * dt)).normalize();

      this.pos.y = ground + RIDE_HEIGHT;

      const into = this.vel.dot(n);
      if (!wasGrounded) {
        // Touchdown: absorb the impact once. Doing this every frame instead
        // would scrub a few percent of speed per step and the rider would
        // grind to a halt on an open slope.
        this.lastLandImpact = Math.max(0, -into);
        const scrub = THREE.MathUtils.clamp(1 - this.lastLandImpact / 46, 0.6, 1);
        this.vel.addScaledVector(n, -into);
        this.vel.multiplyScalar(scrub);
      } else if (into < 0) {
        // Stay glued to the surface: remove only the into-surface component.
        this.vel.addScaledVector(n, -into);
      }

      // ---- steering / carving ----------------------------------------------
      //
      // Turn authority falls MONOTONICALLY with speed. It used to be multiplied
      // by a speedFactor that climbed to 1.6, so authority peaked in the middle
      // of the range: 146 deg/s at full lock around 35 m/s, which is a spin-out,
      // not a carve. The faster you were going the more the board wanted to
      // throw itself sideways.
      //
      // Sign convention: POSITIVE steer turns right. `forward` is
      // (sin yaw, 0, -cos yaw), so heading right means increasing yaw.
      const fast = THREE.MathUtils.clamp(this.speed / 55, 0, 1);
      const turnRate = THREE.MathUtils.lerp(1.30, 0.55, fast);   // rad/s at full lock
      this.yaw += input.steer * turnRate * dt;

      // Clamp the heading to a carve angle either side of the course direction.
      // Steering past this simply has no further effect, so the board can never
      // be spun broadside at speed and the rider always ends up pointing down
      // the hill. It is what stops a clumsy input from turning into a spin-out.
      const courseYaw = Math.atan2(
        courseXAt(this.pos.z - 8) - courseXAt(this.pos.z + 8), 16);
      let rel = this.yaw - courseYaw;
      while (rel > Math.PI) rel -= Math.PI * 2;
      while (rel < -Math.PI) rel += Math.PI * 2;
      if (rel > MAX_CARVE) this.yaw = courseYaw + MAX_CARVE;
      else if (rel < -MAX_CARVE) this.yaw = courseYaw - MAX_CARVE;

      // Self-centring: with the stick released the board settles onto the
      // direction it is actually TRAVELLING, so it stops turning and tracks
      // straight. Gravity still pulls the line downhill over time, which is
      // what you want, but the board never rotates on its own.
      //
      // Aiming this at the fall line instead — the obvious-looking choice —
      // is badly wrong: on any traversing or banked section the fall line
      // points across the course, so the board steers itself up to 90 degrees
      // away from its direction of travel with no input at all.
      const steerMag = Math.abs(input.steer);
      if (steerMag < 0.35 && this.speed > 2) {
        const velYaw = Math.atan2(this.vel.x, -this.vel.z);
        let err = velYaw - this.yaw;
        while (err > Math.PI) err -= Math.PI * 2;
        while (err < -Math.PI) err += Math.PI * 2;
        const authority = (1 - steerMag / 0.35) * SELF_CENTRE;
        this.yaw += THREE.MathUtils.clamp(err, -1, 1) * authority * dt;
      }

      // Edge angle follows steering with lag; that lag *is* the carve feel.
      const targetRoll = input.steer * 0.72 * THREE.MathUtils.clamp(this.speed / 30, 0, 1);
      this.roll += (targetRoll - this.roll) * (1 - Math.exp(-9 * dt));
      this.edge = THREE.MathUtils.clamp(this.roll / 0.72, -1, 1);

      // Board basis, built from the TRUE surface normal rather than the lagged
      // visual `up`. Velocity has just been projected into the n-plane, so
      // (forward, right) spans it exactly and the decomposition below is
      // lossless. Using the smoothed `up` here would silently discard the
      // out-of-plane remainder every frame — another way to bleed all speed.
      this.forward.set(Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      this.forward.addScaledVector(n, -this.forward.dot(n)).normalize();
      const right = this._tmp.crossVectors(this.forward, n).normalize();

      // Decompose velocity into along-board and across-board.
      const vAlong = this.vel.dot(this.forward);
      const vAcross = this.vel.dot(right);

      // Edge grip: the harder you're on edge, the less you slide sideways.
      const grip = THREE.MathUtils.lerp(0.86, 0.995, Math.abs(this.edge));
      const newAcross = vAcross * Math.pow(1 - grip, dt * 60);

      // Carve conversion — scrubbed lateral speed partly becomes forward drive.
      const converted = (vAcross - newAcross) * 0.42 * Math.abs(this.edge);
      let newAlong = vAlong + Math.abs(converted);

      // Gravity along the slope: this is where speed actually comes from.
      const slopeAccel = this._flat.set(0, -GRAVITY, 0);
      slopeAccel.addScaledVector(n, -slopeAccel.dot(n));
      newAlong += slopeAccel.dot(this.forward) * dt;
      const lateralG = slopeAccel.dot(right) * dt;

      // Tuck / brake.
      const tuck = THREE.MathUtils.clamp(-input.pitch, 0, 1);
      const brake = THREE.MathUtils.clamp(input.pitch, 0, 1);
      newAlong += tuck * 9.0 * dt;
      newAlong -= brake * 16.0 * dt * THREE.MathUtils.clamp(this.speed / 12, 0, 1);

      // Snow drag: quadratic air/snow resistance plus a small constant friction.
      // Tuned so a tucked rider on the ~15deg mid-course reaches ~50 m/s and a
      // hard carve costs real speed.
      const cd = 0.0016 + 0.0042 * (1 - tuck) + 0.0115 * Math.abs(this.edge);
      newAlong -= (cd * newAlong * Math.abs(newAlong) + 1.1) * dt;
      newAlong = Math.max(newAlong, 0);

      this.vel.copy(this.forward).multiplyScalar(newAlong)
        .addScaledVector(right, newAcross + lateralG);

      // Stall recovery. Forward speed is clamped at zero so the rider can never
      // ride backwards, but that also means anywhere the ground tilts up — the
      // face of a kicker reached too slowly — is a permanent trap: no forward
      // drive, no way to slide back. Below walking pace, nudge the rider along
      // the true downhill direction regardless of which way the board points,
      // so gravity always eventually wins. Costs nothing at riding speed.
      if (this.speed < 4.5) {
        const fall = this._flat.set(0, -GRAVITY, 0);
        fall.addScaledVector(n, -fall.dot(n));          // project onto the slope
        const g = fall.length();
        if (g > 0.01) this.vel.addScaledVector(fall, (1 / g) * 5.5 * dt);
      }

      // ---- ollie charge ------------------------------------------------------
      if (input.jumpHeld) this.crouch = Math.min(1, this.crouch + dt * 2.6);
      if (input.jumpReleased && this.crouch > 0.05) {
        const pop = 7.5 + this.crouch * 9.5;
        this.vel.addScaledVector(this.up, pop);
        this.pos.addScaledVector(this.up, 0.05);
        this.grounded = false;
        this.groundTime = 0;
        this.crouch = 0;
      }
      if (!input.jumpHeld && !input.jumpReleased) this.crouch *= Math.exp(-8 * dt);

      // Launching off a convex lip: keep the momentum instead of gluing to ground.
      const ahead = heightAt(this.pos.x + this.vel.x * dt * 3, this.pos.z + this.vel.z * dt * 3);
      const predicted = this.pos.y + this.vel.y * dt * 3;
      if (predicted > ahead + RIDE_HEIGHT + 0.35) this.grounded = false;

    } else {
      // ---- airborne ----------------------------------------------------------
      this.airTime += dt;
      this.groundTime = 0;
      this.crouch = 0;
      this.vel.y -= GRAVITY * dt;
      this.vel.x *= Math.exp(-0.06 * dt);
      this.vel.z *= Math.exp(-0.06 * dt);
      // Level out towards world-up while flying, so landings read cleanly.
      this.up.lerp(UP, 1 - Math.exp(-2.2 * dt)).normalize();
      this.forward.set(Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    }

    this.pos.addScaledVector(this.vel, dt);

    if (this.grounded) {
      // The ground constraint is POSITIONAL only. Clamping vel.y here would
      // delete the downhill component of an otherwise perfectly tangential
      // velocity on every step, which reads as invisible, crushing brakes.
      this.pos.y = heightAt(this.pos.x, this.pos.z) + RIDE_HEIGHT;
    } else {
      // Airborne safety net: never let the rider tunnel through the surface.
      const g2 = heightAt(this.pos.x, this.pos.z);
      if (this.pos.y < g2 + RIDE_HEIGHT) {
        this.pos.y = g2 + RIDE_HEIGHT;
        if (this.vel.y < 0) this.vel.y = 0;
      }
    }

    this.speed = this.vel.length();

    // Governed top speed. The big drops in the lower course would otherwise
    // let the rider accelerate past 90 m/s, which outruns the camera, pins the
    // speed FOV and makes the run unsteerable. Excess above the soft cap decays
    // with a ~0.4s time constant rather than clamping hard, so it never reads
    // as hitting an invisible wall.
    if (this.speed > SOFT_MAX_SPEED) {
      const target = SOFT_MAX_SPEED + (this.speed - SOFT_MAX_SPEED) * Math.exp(-2.5 * dt);
      this.vel.multiplyScalar(target / this.speed);
      this.speed = target;
    }
  }

  crash(duration = 1.6) {
    if (this.crashed) return;
    this.crashed = true;
    this.crashTimer = duration;
    this.vel.multiplyScalar(0.35);
  }
}
