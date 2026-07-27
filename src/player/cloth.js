/**
 * OWNER: agent "character".
 *
 * Verlet cloth for the parts of the outfit that should not be welded to a
 * bone: the jacket skirt, the tails of the binding straps, the goggle strap.
 *
 * Position-based Verlet rather than a spring-mass integrator because the
 * accelerations here are brutal — a 60 m/s slipstream plus 22 m/s^2 gravity
 * plus the whole reference frame spinning three times a second during a 1080 —
 * and PBD is unconditionally stable under all of it. Constraints are solved by
 * relaxation and the anchors are hard-set every step, so the cloth can never
 * drift off the body no matter what the rider does.
 *
 * Everything runs in the rider group's local (board) space, so the solver sees
 * the board as a stationary world and the gravity/wind vectors get rotated into
 * it by the caller. That is what gives free centrifugal flare during a spin:
 * the frame really is rotating, so the cloth really does get thrown outwards.
 */
import * as THREE from 'three';

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();

export class ClothStrip {
  /**
   * @param cols  particles across (wraps when `closed`)
   * @param rows  particles down; row 0 is the anchored row
   * @param drop  total length hanging below the anchors, metres
   */
  constructor({ cols = 10, rows = 3, drop = 0.16, closed = true, material, stretch = 1.0 }) {
    this.cols = cols;
    this.rows = rows;
    this.closed = closed;
    this.drop = drop;
    this.n = cols * rows;
    this.pos = new Float32Array(this.n * 3);
    this.prev = new Float32Array(this.n * 3);
    this.constraints = [];
    this.stretch = stretch;
    this._ready = false;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.n * 3), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.n * 2), 2));
    const uvA = geo.getAttribute('uv');
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) uvA.setXY(r * cols + c, c / (cols - (closed ? 0 : 1)), r / (rows - 1));
    }
    const idx = [];
    const wrap = closed ? cols : cols - 1;
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < wrap; c++) {
        const c2 = (c + 1) % cols;
        const a = r * cols + c, b = r * cols + c2;
        const d = (r + 1) * cols + c, e = (r + 1) * cols + c2;
        idx.push(a, d, e, a, e, b);
      }
    }
    geo.setIndex(idx);
    this.geometry = geo;
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
  }

  _buildConstraints() {
    const { cols, rows, closed } = this;
    const at = (r, c) => r * cols + ((c + cols) % cols);
    const add = (a, b, k) => {
      const d = Math.hypot(
        this.pos[a * 3] - this.pos[b * 3],
        this.pos[a * 3 + 1] - this.pos[b * 3 + 1],
        this.pos[a * 3 + 2] - this.pos[b * 3 + 2],
      );
      this.constraints.push({ a, b, d, k });
    };
    const wrap = closed ? cols : cols - 1;
    for (let r = 0; r < rows; r++) for (let c = 0; c < wrap; c++) add(at(r, c), at(r, c + 1), 1.0);
    for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols; c++) add(at(r, c), at(r + 1, c), 1.0);
    // shear
    for (let r = 0; r < rows - 1; r++) for (let c = 0; c < wrap; c++) {
      add(at(r, c), at(r + 1, c + 1), 0.45);
      add(at(r, c + 1), at(r + 1, c), 0.45);
    }
    // bend, vertical only — keeps the skirt from folding inside out
    for (let r = 0; r < rows - 2; r++) for (let c = 0; c < cols; c++) add(at(r, c), at(r + 2, c), 0.22);
    this._ready = true;
  }

  /** Seed the whole sheet from the anchor ring, hanging straight down. */
  _seed(anchors, down) {
    const { cols, rows } = this;
    for (let c = 0; c < cols; c++) {
      const a = anchors[c];
      for (let r = 0; r < rows; r++) {
        const i = (r * cols + c) * 3;
        const f = (r / (rows - 1)) * this.drop;
        this.pos[i] = a.x + down.x * f;
        this.pos[i + 1] = a.y + down.y * f;
        this.pos[i + 2] = a.z + down.z * f;
        this.prev[i] = this.pos[i];
        this.prev[i + 1] = this.pos[i + 1];
        this.prev[i + 2] = this.pos[i + 2];
      }
    }
    this._buildConstraints();
  }

  /**
   * @param anchors  `cols` Vector3s for row 0, in group space
   * @param accel    gravity + slipstream, in group space
   * @param collide  optional { p: Vector3, r: number, axis: Vector3 } capsule
   */
  update(dt, anchors, accel, collide) {
    const { cols, rows } = this;
    if (!this._ready) {
      _v.copy(accel).normalize();
      if (_v.lengthSq() < 0.5) _v.set(0, -1, 0);
      this._seed(anchors, _v);
      return this._write();
    }
    const h = Math.min(dt, 1 / 45);
    const drag = 0.972;
    const ah = h * h;

    for (let i = 0; i < this.n; i++) {
      const k = i * 3;
      for (let j = 0; j < 3; j++) {
        const cur = this.pos[k + j];
        const nx = cur + (cur - this.prev[k + j]) * drag + (j === 0 ? accel.x : j === 1 ? accel.y : accel.z) * ah;
        this.prev[k + j] = cur;
        this.pos[k + j] = nx;
      }
    }

    for (let iter = 0; iter < 3; iter++) {
      // anchors are absolute
      for (let c = 0; c < cols; c++) {
        const k = c * 3;
        this.pos[k] = anchors[c].x;
        this.pos[k + 1] = anchors[c].y;
        this.pos[k + 2] = anchors[c].z;
      }
      for (const cst of this.constraints) {
        const a = cst.a * 3, b = cst.b * 3;
        let dx = this.pos[b] - this.pos[a];
        let dy = this.pos[b + 1] - this.pos[a + 1];
        let dz = this.pos[b + 2] - this.pos[a + 2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
        const diff = ((len - cst.d * this.stretch) / len) * 0.5 * cst.k;
        dx *= diff; dy *= diff; dz *= diff;
        const wa = cst.a < cols ? 0 : 1;
        const wb = cst.b < cols ? 0 : 1;
        const s = wa + wb || 1;
        if (wa) { this.pos[a] += dx * 2 * wa / s; this.pos[a + 1] += dy * 2 * wa / s; this.pos[a + 2] += dz * 2 * wa / s; }
        if (wb) { this.pos[b] -= dx * 2 * wb / s; this.pos[b + 1] -= dy * 2 * wb / s; this.pos[b + 2] -= dz * 2 * wb / s; }
      }
      if (collide) this._collide(collide);
    }
    return this._write();
  }

  /** Push particles out of a vertical capsule around the torso/legs. */
  _collide(c) {
    for (let i = this.cols; i < this.n; i++) {
      const k = i * 3;
      _v.set(this.pos[k] - c.p.x, this.pos[k + 1] - c.p.y, this.pos[k + 2] - c.p.z);
      const along = _v.dot(c.axis);
      _w.copy(_v).addScaledVector(c.axis, -along);
      const d = _w.length();
      if (d < c.r && d > 1e-5) {
        _w.multiplyScalar((c.r - d) / d);
        this.pos[k] += _w.x; this.pos[k + 1] += _w.y; this.pos[k + 2] += _w.z;
      }
    }
  }

  _write() {
    const attr = this.geometry.getAttribute('position');
    attr.array.set(this.pos);
    attr.needsUpdate = true;
    this.geometry.computeVertexNormals();
    return this.mesh;
  }
}
