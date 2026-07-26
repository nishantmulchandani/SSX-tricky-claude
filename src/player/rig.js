/**
 * OWNER: agent "character".
 *
 * The skeleton, the solver and the procedural skin.
 *
 * ── Space ──────────────────────────────────────────────────────────────────
 * Everything in here lives in BOARD space, which is also the rider group's
 * local space:
 *      +X  toe side (the rider's chest faces this way in regular stance)
 *      -Z  nose / direction of travel
 *      +Y  up
 *      origin: the centre of the board's base
 *
 * ── Bones ──────────────────────────────────────────────────────────────────
 * Every bone's local +Y runs down its own length, so a chain is just "child
 * sits at (0, parentLength, 0)". Poses are applied by *aiming* bones: we build
 * the desired world quaternion and divide out the parent's. Positions are
 * never authored — they always fall out of the hierarchy, which is what keeps
 * the skinned mesh from tearing.
 *
 * The bind pose is the neutral riding stance (not a T-pose) and the skin is
 * generated from it, so the deformation away from bind is always small.
 */
import * as THREE from 'three';

export const D = {
  pelvisUp: 0.055,       // hips origin -> spine1 origin
  spine1: 0.145,
  spine2: 0.150,
  chest: 0.160,
  neck: 0.085,
  head: 0.200,
  clav: 0.190,
  upperArm: 0.285,
  foreArm: 0.255,
  hand: 0.095,
  thigh: 0.440,
  shin: 0.420,
  foot: 0.185,
  hipHalf: 0.095,
  clavUp: 0.075,
  ankleY: 0.185,         // ankle height above the board base plane
};

/** shoulder is at clav tip; total straight reach from shoulder to palm centre */
export const ARM_REACH = D.upperArm + D.foreArm;
export const LEG_REACH = D.thigh + D.shin;

// name, parent, rest offset in parent space, length along local +Y
const BONES = [
  ['hips', null, [0, 0, 0], 0],
  ['spine1', 'hips', [0, D.pelvisUp, 0], D.spine1],
  ['spine2', 'spine1', [0, D.spine1, 0], D.spine2],
  ['chest', 'spine2', [0, D.spine2, 0], D.chest],
  ['neck', 'chest', [0, D.chest, 0], D.neck],
  ['head', 'neck', [0, D.neck, 0], D.head],

  ['clavL', 'chest', [-0.030, D.clavUp, 0.005], D.clav],
  ['armL', 'clavL', [0, D.clav, 0], D.upperArm],
  ['foreL', 'armL', [0, D.upperArm, 0], D.foreArm],
  ['handL', 'foreL', [0, D.foreArm, 0], D.hand],

  ['clavR', 'chest', [0.030, D.clavUp, 0.005], D.clav],
  ['armR', 'clavR', [0, D.clav, 0], D.upperArm],
  ['foreR', 'armR', [0, D.upperArm, 0], D.foreArm],
  ['handR', 'foreR', [0, D.foreArm, 0], D.hand],

  ['thighL', 'hips', [-D.hipHalf, -0.045, 0], D.thigh],
  ['shinL', 'thighL', [0, D.thigh, 0], D.shin],
  ['footL', 'shinL', [0, D.shin, 0], D.foot],

  ['thighR', 'hips', [D.hipHalf, -0.045, 0], D.thigh],
  ['shinR', 'thighR', [0, D.thigh, 0], D.shin],
  ['footR', 'thighR' /* patched below */, [0, D.shin, 0], D.foot],
];
BONES[BONES.length - 1][1] = 'shinR';

// ── maths helpers ──────────────────────────────────────────────────────────
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _x = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

/**
 * World quaternion whose +Y is `dir` and whose +Z leans towards `ref`.
 * `ref` is the twist control: for a knee it is the direction the kneecap
 * faces, for a hand it is the palm normal.
 */
export function aimQuat(out, dir, ref) {
  _y.copy(dir);
  if (_y.lengthSq() < 1e-12) _y.set(0, 1, 0);
  _y.normalize();
  _z.copy(ref).addScaledVector(_y, -ref.dot(_y));
  if (_z.lengthSq() < 1e-9) {
    _z.set(0, 0, 1).addScaledVector(_y, -_y.z);
    if (_z.lengthSq() < 1e-9) _z.set(1, 0, 0).addScaledVector(_y, -_y.x);
  }
  _z.normalize();
  _x.crossVectors(_y, _z).normalize();
  _z.crossVectors(_x, _y).normalize();
  _m.makeBasis(_x, _y, _z);
  return out.setFromRotationMatrix(_m);
}

/**
 * Analytic two-bone IK. Returns the mid-joint position; the caller aims the
 * two bones at it. Out-of-reach targets straighten the limb and point at the
 * target, which is the behaviour a grab pose wants (the arm visibly strains).
 */
const _toT = new THREE.Vector3();
const _pole = new THREE.Vector3();
export function twoBoneIK(out, root, target, pole, l1, l2) {
  _toT.copy(target).sub(root);
  let d = _toT.length();
  const max = (l1 + l2) * 0.9995;
  const min = Math.abs(l1 - l2) * 1.02 + 1e-4;
  if (d < 1e-6) { _toT.set(0, -1, 0); d = 1e-6; }
  const dc = Math.min(Math.max(d, min), max);
  _toT.multiplyScalar(1 / d);
  const a = (l1 * l1 - l2 * l2 + dc * dc) / (2 * dc);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  _pole.copy(pole).sub(root);
  _pole.addScaledVector(_toT, -_pole.dot(_toT));
  if (_pole.lengthSq() < 1e-9) {
    _pole.set(0, 0, 1).addScaledVector(_toT, -_toT.z);
    if (_pole.lengthSq() < 1e-9) _pole.set(1, 0, 0).addScaledVector(_toT, -_toT.x);
  }
  _pole.normalize();
  out.copy(root).addScaledVector(_toT, a).addScaledVector(_pole, h);
  return out;
}

// ── geometry builder ───────────────────────────────────────────────────────
/** Superellipse cross-section: e<1 squares the section off (puffy jacket). */
function sectionPoint(out, angle, rx, rz, e) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const cx = Math.sign(c) * Math.pow(Math.abs(c), e);
  const sz = Math.sign(s) * Math.pow(Math.abs(s), e);
  return out.set(cx * rx, 0, sz * rz);
}

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a || 1e-6)));
  return t * t * (3 - 2 * t);
};

export class SkinBuilder {
  constructor() {
    this.pos = [];
    this.uv = [];
    this.si = [];
    this.sw = [];
    this.idx = [];
    this.groups = [];
    this._groupStart = 0;
    this._groupMat = -1;
  }

  beginGroup(materialIndex) {
    this._flush();
    this._groupStart = this.idx.length;
    this._groupMat = materialIndex;
  }

  _flush() {
    if (this._groupMat >= 0 && this.idx.length > this._groupStart) {
      this.groups.push({ start: this._groupStart, count: this.idx.length - this._groupStart, material: this._groupMat });
    }
  }

  vertex(p, u, v, bones) {
    this.pos.push(p.x, p.y, p.z);
    this.uv.push(u, v);
    let a = bones[0] || [0, 0], b = bones[1] || [0, 0], c = bones[2] || [0, 0], d = bones[3] || [0, 0];
    this.si.push(a[0], b[0], c[0], d[0]);
    const sum = (a[1] + b[1] + c[1] + d[1]) || 1;
    this.sw.push(a[1] / sum, b[1] / sum, c[1] / sum, d[1] / sum);
    return this.pos.length / 3 - 1;
  }

  /**
   * Loft a tube through `stations`.
   * station = { p, q, rx, rz, e, v, bones:[[boneIndex, weight], ...] }
   */
  tube(stations, radial, opts = {}) {
    const uRepeat = opts.uRepeat ?? 1;
    const rows = [];
    const tmp = new THREE.Vector3();
    for (const st of stations) {
      const row = [];
      for (let k = 0; k <= radial; k++) {
        const ang = (k / radial) * Math.PI * 2;
        sectionPoint(tmp, ang, st.rx, st.rz, st.e ?? 1);
        tmp.applyQuaternion(st.q).add(st.p);
        row.push(this.vertex(tmp, (k / radial) * uRepeat, st.v, st.bones));
      }
      rows.push(row);
    }
    for (let i = 0; i < rows.length - 1; i++) {
      const A = rows[i], B = rows[i + 1];
      for (let k = 0; k < radial; k++) {
        this.idx.push(A[k], B[k], B[k + 1]);
        this.idx.push(A[k], B[k + 1], A[k + 1]);
      }
    }
    if (opts.capStart) this._fan(stations[0], rows[0], radial, -1);
    if (opts.capEnd) this._fan(stations[stations.length - 1], rows[rows.length - 1], radial, 1);
    return rows;
  }

  _fan(st, row, radial, sign) {
    const c = new THREE.Vector3(0, sign * Math.min(st.rx, st.rz) * 0.55, 0)
      .applyQuaternion(st.q).add(st.p);
    const ci = this.vertex(c, 0.5, st.v, st.bones);
    for (let k = 0; k < radial; k++) {
      if (sign > 0) this.idx.push(row[k], ci, row[k + 1]);
      else this.idx.push(row[k], row[k + 1], ci);
    }
  }

  build() {
    this._flush();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    g.setIndex(this.idx);
    for (const gr of this.groups) g.addGroup(gr.start, gr.count, gr.material);
    g.computeVertexNormals();
    return g;
  }
}

/**
 * Turn a bone chain into loft stations, blending skin weights (and the
 * cross-section frame) across each joint so elbows and knees crease instead
 * of shearing.
 *
 * links: [{ bone, p, q, len }]  — world start position + world quaternion.
 * profile(s) -> [rx, rz, e]     — s is 0..1 along the whole chain.
 */
export function chainStations(links, profile, opts = {}) {
  const blend = opts.blend ?? 0.10;
  const ts = opts.ts ?? [0, 0.13, 0.32, 0.5, 0.68, 0.87, 1];
  const rootBone = opts.rootBone;
  const rootBlend = opts.rootBlend ?? 0.08;
  const total = links.reduce((a, l) => a + l.len, 0);
  const stations = [];
  let acc = 0;
  const q = new THREE.Quaternion();
  for (let i = 0; i < links.length; i++) {
    const L = links[i];
    const prev = links[i - 1];
    const next = links[i + 1];
    for (const t of ts) {
      if (t === 0 && i > 0) continue;       // shared joint already emitted
      const d0 = t * L.len;                 // distance from this link's start
      const d1 = (1 - t) * L.len;           // distance to this link's end
      const p = new THREE.Vector3(0, d0, 0).applyQuaternion(L.q).add(L.p);
      const bones = [[L.bone, 1]];
      q.copy(L.q);
      if (prev && d0 < blend) {
        const w = 0.5 * (1 - smoothstep(0, blend, d0));
        bones[0][1] = 1 - w;
        bones.push([prev.bone, w]);
        q.copy(prev.q).slerp(L.q, 1 - w);
      } else if (!prev && rootBone !== undefined && d0 < rootBlend) {
        const w = 0.5 * (1 - smoothstep(0, rootBlend, d0));
        bones[0][1] = 1 - w;
        bones.push([rootBone, w]);
      } else if (next && d1 < blend) {
        const w = 0.5 * (1 - smoothstep(0, blend, d1));
        bones[0][1] = 1 - w;
        bones.push([next.bone, w]);
        q.copy(L.q).slerp(next.q, w);
      }
      const s = (acc + d0) / total;
      const pr = profile(s);
      stations.push({ p, q: q.clone(), rx: pr[0], rz: pr[1], e: pr[2] ?? 1, v: s, bones });
    }
    acc += L.len;
  }
  return stations;
}

// ── the rig ────────────────────────────────────────────────────────────────
export class RiderRig {
  constructor() {
    this.bones = {};
    this.list = [];
    this.index = {};
    this.wq = {};   // world quaternion per bone (board space)
    this.wp = {};   // world position per bone origin (board space)

    for (const [name, parent, off, len] of BONES) {
      const b = new THREE.Bone();
      b.name = name;
      b.position.fromArray(off);
      b.userData.len = len;
      b.userData.parent = parent;
      this.bones[name] = b;
      this.index[name] = this.list.length;
      this.list.push(b);
      this.wq[name] = new THREE.Quaternion();
      this.wp[name] = new THREE.Vector3();
      if (parent) this.bones[parent].add(b);
    }
    this.root = this.bones.hips;

    this._q = new THREE.Quaternion();
    this._q2 = new THREE.Quaternion();
    this._mid = new THREE.Vector3();
    this._t = new THREE.Vector3();
    this._t2 = new THREE.Vector3();
    this._sh = new THREE.Vector3();
    this._e = new THREE.Euler();
  }

  bi(name) { return this.index[name]; }

  /** world position of a bone's tip (its child joint) */
  tip(name, out = new THREE.Vector3()) {
    return out.set(0, this.bones[name].userData.len, 0)
      .applyQuaternion(this.wq[name]).add(this.wp[name]);
  }

  _setWorld(name, quat) {
    const b = this.bones[name];
    const p = b.userData.parent;
    this.wq[name].copy(quat);
    if (p) {
      b.quaternion.copy(this.wq[p]).invert().multiply(quat);
      this.wp[name].copy(b.position).applyQuaternion(this.wq[p]).add(this.wp[p]);
    } else {
      b.quaternion.copy(quat);
    }
  }

  _local(name, euler) {
    const b = this.bones[name];
    const p = b.userData.parent;
    b.quaternion.setFromEuler(euler);
    this.wq[name].copy(this.wq[p]).multiply(b.quaternion);
    this.wp[name].copy(b.position).applyQuaternion(this.wq[p]).add(this.wp[p]);
  }

  _place(name) {
    const b = this.bones[name];
    const p = b.userData.parent;
    this.wp[name].copy(b.position).applyQuaternion(this.wq[p]).add(this.wp[p]);
  }

  /**
   * Apply a pose. See poses.js for the shape of `p`; everything is in board
   * space. The order is deliberate: spine before arms (the shoulder rides on
   * the chest), legs last (they only depend on the pelvis).
   */
  solve(p) {
    const B = this.bones;

    // ---- pelvis ------------------------------------------------------------
    B.hips.position.copy(p.pelvis);
    this.wp.hips.copy(p.pelvis);
    this.wq.hips.copy(p.pelvisQ);
    B.hips.quaternion.copy(p.pelvisQ);

    // ---- spine -------------------------------------------------------------
    const sp = p.spine;
    const share = [0.30, 0.34, 0.36];
    const tw = [0.24, 0.34, 0.42];
    const names = ['spine1', 'spine2', 'chest'];
    for (let i = 0; i < 3; i++) {
      this._e.set(-sp.bend * share[i], sp.twist * tw[i], -sp.side * share[i], 'YXZ');
      this._local(names[i], this._e);
    }
    this._e.set(-p.head.pitch * 0.35, p.head.yaw * 0.32, -p.head.roll * 0.35, 'YXZ');
    this._local('neck', this._e);
    this._e.set(-p.head.pitch * 0.65, p.head.yaw * 0.68, -p.head.roll * 0.65, 'YXZ');
    this._local('head', this._e);

    // ---- arms --------------------------------------------------------------
    for (const s of ['L', 'R']) {
      const arm = p.arm[s];
      const clav = 'clav' + s;
      // The clavicle points out of the chest and lifts a little towards the
      // target — that shrug is most of what makes a long reach look human.
      this._place(clav);
      this._t.copy(arm.target).sub(this.wp[clav]);
      const dist = this._t.length();
      const strain = Math.min(1, Math.max(0, (dist - ARM_REACH * 0.72) / (ARM_REACH * 0.5)));
      const side = s === 'L' ? -1 : 1;
      _v.set(side, 0.16 + arm.shrug * 0.5, 0).applyQuaternion(this.wq.chest);
      if (dist > 1e-4) _v.addScaledVector(this._t, strain * 0.85 / dist);
      this._t2.set(0, 0, 1).applyQuaternion(this.wq.chest);
      this._setWorld(clav, aimQuat(this._q, _v, this._t2));

      const shoulder = this.tip(clav, this._sh);
      twoBoneIK(this._mid, shoulder, arm.target, arm.pole, D.upperArm, D.foreArm);
      // The elbow "points" at the pole, exactly like the knee does. Using the
      // arm-plane normal instead would flip 180 degrees whenever the arm went
      // straight, and the sleeve would pop.
      const elbowRef = _v.copy(arm.pole).sub(this._mid);
      if (elbowRef.lengthSq() < 1e-8) elbowRef.set(0, 0, 1);
      this._setWorld('arm' + s, aimQuat(this._q, _v2.copy(this._mid).sub(shoulder), elbowRef));
      this._setWorld('fore' + s, aimQuat(this._q, _v2.copy(arm.target).sub(this._mid), elbowRef));
      this._setWorld('hand' + s, aimQuat(this._q, arm.handDir, arm.palm));
    }

    // ---- legs --------------------------------------------------------------
    for (const s of ['L', 'R']) {
      const leg = p.leg[s];
      this._place('thigh' + s);
      const hip = this.wp['thigh' + s];
      twoBoneIK(this._mid, hip, leg.ankle, leg.pole, D.thigh, D.shin);
      const kneeRef = _v.copy(leg.pole).sub(this._mid).normalize();
      if (kneeRef.lengthSq() < 1e-8) kneeRef.set(0, 0, 1);
      this._setWorld('thigh' + s, aimQuat(this._q, _v2.copy(this._mid).sub(hip), kneeRef));
      this._place('shin' + s);
      this._setWorld('shin' + s, aimQuat(this._q, _v2.copy(leg.ankle).sub(this._mid), kneeRef));
      this._place('foot' + s);
      this._setWorld('foot' + s, aimQuat(this._q, leg.toe, leg.up));
    }
  }
}
