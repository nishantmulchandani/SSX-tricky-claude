import * as THREE from 'three';
import { heightAt } from '../world/terrain.js';

/**
 * Chase camera. Critical-damped spring on position, separate slower spring on
 * look-at, plus speed-driven FOV and a subtle roll into carves. The camera is
 * never allowed under the snow.
 */
export class ChaseCamera {
  constructor(camera) {
    this.camera = camera;
    this.pos = new THREE.Vector3(0, 6, 10);
    this.look = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.lookVel = new THREE.Vector3();
    this.fov = 58;
    this.roll = 0;
    this.shake = 0;
    this._desired = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  addShake(amount) { this.shake = Math.min(1.4, this.shake + amount); }

  /** Teleport the rig — used after a respawn so the camera does not fly across the map. */
  snap(body) {
    const fwd = body.forward;
    this.pos.copy(body.pos).addScaledVector(fwd, -8).add(new THREE.Vector3(0, 3.2, 0));
    this.look.copy(body.pos).addScaledVector(fwd, 10);
    this.vel.set(0, 0, 0);
    this.lookVel.set(0, 0, 0);
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
  }

  update(dt, body) {
    const speed01 = THREE.MathUtils.clamp(body.speed / 62, 0, 1);
    const back = THREE.MathUtils.lerp(7.4, 10.6, speed01);
    const height = THREE.MathUtils.lerp(2.9, 4.0, speed01) + (body.grounded ? 0 : Math.min(3.5, body.airTime * 2.4));

    const fwd = body.forward;
    this._desired.copy(body.pos)
      .addScaledVector(fwd, -back)
      .add(new THREE.Vector3(0, height, 0));

    // Keep the camera above the terrain behind the rider.
    const floor = heightAt(this._desired.x, this._desired.z) + 1.6;
    if (this._desired.y < floor) this._desired.y = floor;

    // Critically-damped spring — stiffer on the ground, floatier in the air.
    const stiff = body.grounded ? 46 : 26;
    spring(this.pos, this.vel, this._desired, stiff, dt);

    this._target.copy(body.pos)
      .addScaledVector(fwd, 9 + speed01 * 7)
      .add(new THREE.Vector3(0, 1.6, 0));
    spring(this.look, this.lookVel, this._target, 30, dt);

    // Speed FOV — the single biggest contributor to a sense of velocity.
    const targetFov = 58 + speed01 * 22 + (body.grounded ? 0 : -3);
    this.fov += (targetFov - this.fov) * (1 - Math.exp(-4 * dt));

    // Bank into carves.
    const targetRoll = -body.edge * 0.09 * speed01;
    this.roll += (targetRoll - this.roll) * (1 - Math.exp(-6 * dt));

    this.camera.position.copy(this.pos);
    if (this.shake > 0.001) {
      const s = this.shake * this.shake * 0.55;
      this.camera.position.x += (Math.random() - 0.5) * s;
      this.camera.position.y += (Math.random() - 0.5) * s;
      this.camera.position.z += (Math.random() - 0.5) * s;
      this.shake *= Math.exp(-6 * dt);
    }
    this._up.set(Math.sin(this.roll), Math.cos(this.roll), 0);
    this.camera.up.copy(this._up);
    this.camera.lookAt(this.look);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }
}

const _d = new THREE.Vector3();
/**
 * Exact solution of a critically-damped spring over `dt`.
 *
 * The obvious semi-implicit Euler version explodes once damping*dt > 1 — at a
 * 5fps frame that zeroes the velocity every step and the camera simply stops
 * following. The closed form is unconditionally stable at any timestep, which
 * matters because frame times are not ours to control.
 */
function spring(pos, vel, target, stiffness, dt) {
  const omega = Math.sqrt(stiffness);
  const e = Math.exp(-omega * dt);
  _d.copy(pos).sub(target); // displacement from target
  // c = v0 + omega * d0
  const cx = vel.x + omega * _d.x;
  const cy = vel.y + omega * _d.y;
  const cz = vel.z + omega * _d.z;

  pos.set(
    target.x + (_d.x + cx * dt) * e,
    target.y + (_d.y + cy * dt) * e,
    target.z + (_d.z + cz * dt) * e,
  );
  vel.set(
    (vel.x - cx * omega * dt) * e,
    (vel.y - cy * omega * dt) * e,
    (vel.z - cz * omega * dt) * e,
  );
}
