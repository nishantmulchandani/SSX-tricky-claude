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
    this.pos.copy(body.pos).addScaledVector(fwd, -5).add(new THREE.Vector3(0, 2.0, 0));
    this.look.copy(body.pos).addScaledVector(fwd, 6).add(new THREE.Vector3(0, 1.75, 0));
    this.vel.set(0, 0, 0);
    this.lookVel.set(0, 0, 0);
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.look);
  }

  update(dt, body) {
    const speed01 = THREE.MathUtils.clamp(body.speed / 62, 0, 1);
    // Close and low, deliberately. The rider should read as a character you
    // are driving — board graphic legible, arms and lean visible, filling a
    // good third of the frame — not a distant speck on a hillside. Sitting
    // this far back was the single biggest thing making the POV feel weak.
    const back = THREE.MathUtils.lerp(3.7, 5.2, speed01);
    const height = THREE.MathUtils.lerp(1.7, 2.15, speed01)
      + (body.grounded ? 0 : Math.min(2.0, body.airTime * 1.5));

    const fwd = body.forward;
    this._desired.copy(body.pos)
      .addScaledVector(fwd, -back)
      .add(new THREE.Vector3(0, height, 0));

    // Keep the camera above the terrain behind the rider.
    const floor = heightAt(this._desired.x, this._desired.z) + 1.15;
    if (this._desired.y < floor) this._desired.y = floor;

    // Critically-damped spring — stiffer on the ground, floatier in the air.
    const stiff = body.grounded ? 46 : 26;
    spring(this.pos, this.vel, this._desired, stiff, dt);

    // Aim just over the rider's shoulder rather than far down the hill, which
    // is what keeps them low-centre in frame instead of shrinking to a dot.
    this._target.copy(body.pos)
      .addScaledVector(fwd, 3.4 + speed01 * 3.2)
      .add(new THREE.Vector3(0, 1.75, 0));
    spring(this.look, this.lookVel, this._target, 30, dt);

    // Speed FOV. A wide lens sells velocity but shrinks the rider, and at 80deg
    // the character became a dot — the whole point of pulling the camera in.
    // Kept narrower, with the rush effect carried by the post stack instead.
    const targetFov = 56 + speed01 * 15 + (body.grounded ? 0 : -2);
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
