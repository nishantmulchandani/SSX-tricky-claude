import * as THREE from 'three';
import { heightAt, normalInto } from '../world/terrain.js';

const GRAVITY = 22.0;          // exaggerated — SSX gravity, not Earth gravity
const RIDE_HEIGHT = 0.09;
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

      if (!wasGrounded) this.lastLandImpact = Math.max(0, -this.vel.y);

      // Snap to the surface and remove the into-surface velocity component.
      this.pos.y = ground + RIDE_HEIGHT;
      const into = this.vel.dot(n);
      if (into < 0) {
        // Landing absorption: soft snow eats vertical impact, hard landings scrub speed.
        const absorb = THREE.MathUtils.clamp(1 - (-into) / 34, 0.25, 1);
        this.vel.addScaledVector(n, -into);
        this.vel.multiplyScalar(THREE.MathUtils.lerp(0.82, 1.0, absorb));
      }

      // ---- steering / carving ----------------------------------------------
      const speedFactor = THREE.MathUtils.clamp(this.speed / 26, 0.15, 1.6);
      // Turn rate falls off at high speed — you commit to a line, you don't pivot.
      const turnRate = THREE.MathUtils.lerp(3.2, 1.15, THREE.MathUtils.clamp(this.speed / 55, 0, 1));
      this.yaw -= input.steer * turnRate * dt * speedFactor;

      // Edge angle follows steering with lag; that lag *is* the carve feel.
      const targetRoll = -input.steer * 0.72 * THREE.MathUtils.clamp(this.speed / 30, 0, 1);
      this.roll += (targetRoll - this.roll) * (1 - Math.exp(-9 * dt));
      this.edge = THREE.MathUtils.clamp(this.roll / 0.72, -1, 1);

      // Board basis projected onto the surface.
      this.forward.set(Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      this.forward.addScaledVector(this.up, -this.forward.dot(this.up)).normalize();
      const right = this._tmp.crossVectors(this.forward, this.up).normalize();

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

      // Snow drag — quadratic, plus a base friction that tuck reduces.
      const drag = (0.0055 + 0.010 * (1 - tuck) + 0.020 * Math.abs(this.edge)) * newAlong * Math.abs(newAlong);
      newAlong -= drag * dt;
      newAlong = Math.max(newAlong, 0);

      this.vel.copy(this.forward).multiplyScalar(newAlong)
        .addScaledVector(right, newAcross + lateralG);

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

    // Never fall through the world.
    const g2 = heightAt(this.pos.x, this.pos.z);
    if (this.pos.y < g2 + RIDE_HEIGHT) {
      this.pos.y = g2 + RIDE_HEIGHT;
      if (this.vel.y < 0) this.vel.y = 0;
    }

    this.speed = this.vel.length();
  }

  crash(duration = 1.6) {
    if (this.crashed) return;
    this.crashed = true;
    this.crashTimer = duration;
    this.vel.multiplyScalar(0.35);
  }
}
