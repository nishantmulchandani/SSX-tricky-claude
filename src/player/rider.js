/**
 * OWNER: agent "character".
 *
 * The rider: skeleton, procedural skinned body, board, cloth, and the frame
 * transform that puts all of it on the mountain.
 *
 *   new Rider() -> { group, update(dt, body, tricks) }
 *
 * ── How the body is made ───────────────────────────────────────────────────
 * There are no assets. The mesh is lofted at load time straight off the
 * skeleton *in its bind pose*: every limb is a chain of superelliptic sections
 * swept along its bones, with the skin weights blended across each joint by
 * `chainStations` so elbows and knees crease instead of collapsing. Hard parts
 * that only need to follow a joint — helmet shell, goggle lens, boot buckles —
 * are baked in rigidly with `SkinBuilder.addGeometry`. One SkinnedMesh, one
 * draw call per material.
 *
 * Because the bind pose IS the riding stance rather than a T-pose, the rig
 * spends its life a few degrees from bind and the deformation stays clean.
 *
 * ── The frame ──────────────────────────────────────────────────────────────
 * `group` is board space: -Z nose, +Y up, origin at the centre of the base.
 * Its world transform is rebuilt each frame from the physics body's forward/up
 * (so the board sits on the snow properly on a traverse) with the trick
 * system's pitch and roll applied on top. Everything else — pose, cloth, the
 * board mesh itself — is authored in that space and never has to know where on
 * the mountain it is.
 */
import * as THREE from 'three';
import { RiderRig, SkinBuilder, chainStations, D } from './rig.js';
import { createMaterials } from './materials.js';
import { PoseSolver, STANCE, clamp } from './poses.js';
import { buildBoard, BOARD, baseLine } from './boardMesh.js';
import { ClothStrip } from './cloth.js';

const TAU = Math.PI * 2;
const ONE = new THREE.Vector3(1, 1, 1);

// Material slot order for the skinned mesh. Indices are referenced by
// beginGroup() below and must match the array handed to the SkinnedMesh.
const SLOT = {
  jacket: 0, pants: 1, skin: 2, glove: 3, boot: 4, helmet: 5,
  lens: 6, gaiter: 7, accent: 8, plastic: 9, metal: 10, rubber: 11,
};
const SLOT_ORDER = ['jacket', 'pants', 'skin', 'glove', 'boot', 'helmet',
  'lens', 'gaiter', 'accent', 'plastic', 'metal', 'rubber'];

/** Smooth piecewise profile: keys are [s, rx, rz, exponent]. */
function profileFn(keys) {
  return (s) => {
    let i = 0;
    while (i < keys.length - 2 && s > keys[i + 1][0]) i++;
    const a = keys[i], b = keys[i + 1];
    const t = clamp((s - a[0]) / ((b[0] - a[0]) || 1), 0, 1);
    const u = t * t * (3 - 2 * t);
    const ea = a[3] ?? 1, eb = b[3] ?? 1;
    return [a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, ea + (eb - ea) * u];
  };
}

// ── profiles ───────────────────────────────────────────────────────────────
// rx runs across the body (the shoulder axis), rz front-to-back. Exponents
// below 1 square the section off, which is what makes a shell jacket read as
// padded panels rather than a sausage.
const P_TORSO = profileFn([
  [0.00, 0.112, 0.096, 0.74],
  [0.11, 0.152, 0.124, 0.70],
  [0.24, 0.146, 0.119, 0.72],
  [0.42, 0.136, 0.112, 0.76],
  [0.58, 0.150, 0.124, 0.78],
  [0.71, 0.174, 0.134, 0.78],
  [0.80, 0.194, 0.138, 0.80],
  [0.88, 0.168, 0.126, 0.86],
  [0.94, 0.088, 0.088, 0.94],
  [1.00, 0.068, 0.070, 1.00],
]);
const P_ARM = profileFn([
  [0.00, 0.083, 0.086, 0.82],
  [0.18, 0.071, 0.074, 0.82],
  [0.46, 0.059, 0.062, 0.86],
  [0.56, 0.058, 0.060, 0.88],
  [0.80, 0.053, 0.055, 0.92],
  [1.00, 0.044, 0.046, 0.95],
]);
const P_LEG = profileFn([
  [0.00, 0.120, 0.126, 0.72],
  [0.22, 0.109, 0.114, 0.74],
  [0.46, 0.088, 0.094, 0.80],
  [0.56, 0.087, 0.092, 0.82],
  [0.78, 0.086, 0.089, 0.78],
  [1.00, 0.079, 0.082, 0.76],
]);
const P_NECK = profileFn([
  [0.00, 0.086, 0.088, 0.9],
  [1.00, 0.078, 0.080, 0.9],
]);

const DETAIL = {
  hi: { radial: 14, ts: [0, 0.13, 0.32, 0.5, 0.68, 0.87, 1], props: true, arc: 20 },
  lo: { radial: 7, ts: [0, 0.5, 1], props: false, arc: 8 },
};

// ── skin construction ──────────────────────────────────────────────────────

function linkOf(rig, name) {
  return {
    bone: rig.bi(name),
    p: rig.wp[name].clone(),
    q: rig.wq[name].clone(),
    len: rig.bones[name].userData.len,
  };
}

/** Stations placed by hand along one bone — used where a profile needs to be
 * offset off the bone axis (a boot hangs below the ankle, a glove is flat). */
function manualStations(rig, name, list) {
  const wp = rig.wp[name], wq = rig.wq[name];
  const len = rig.bones[name].userData.len;
  const bone = rig.bi(name);
  const extra = list.extraBone;
  return list.map((e) => {
    const p = new THREE.Vector3(e.ox ?? 0, e.t * len + (e.oy ?? 0), e.oz ?? 0)
      .applyQuaternion(wq).add(wp);
    return {
      p, q: wq.clone(), rx: e.rx, rz: e.rz, e: e.e ?? 1, v: e.t,
      bones: e.bones ?? (extra ? [[bone, 0.75], [extra, 0.25]] : [[bone, 1]]),
    };
  });
}

function mat4(rig, name) {
  return new THREE.Matrix4().compose(rig.wp[name], rig.wq[name], ONE);
}

/**
 * Build the whole body as one indexed, grouped, skinned BufferGeometry.
 * `rig` must already be solved into the bind pose.
 */
function buildSkin(rig, det) {
  const sb = new SkinBuilder();
  const opt = { blend: 0.095, ts: det.ts };
  const R = det.radial;
  const bi = (n) => rig.bi(n);

  // ---- torso ---------------------------------------------------------------
  // A synthetic link below the pelvis so the loft covers the seat, otherwise
  // the jacket starts at the belt and the rider has no hips.
  const hipsQ = rig.wq.hips;
  const pelvisLink = {
    bone: bi('hips'),
    q: hipsQ.clone(),
    len: 0.168,
    p: rig.wp.hips.clone().add(new THREE.Vector3(0, D.pelvisUp - 0.168, 0).applyQuaternion(hipsQ)),
  };
  sb.beginGroup(SLOT.jacket);
  sb.tube(chainStations(
    [pelvisLink, linkOf(rig, 'spine1'), linkOf(rig, 'spine2'), linkOf(rig, 'chest'), linkOf(rig, 'neck')],
    P_TORSO, opt), R, { capStart: true });

  // ---- arms ----------------------------------------------------------------
  for (const s of ['L', 'R']) {
    sb.tube(chainStations([linkOf(rig, 'arm' + s), linkOf(rig, 'fore' + s)], P_ARM,
      { ...opt, rootBone: bi('clav' + s), rootBlend: 0.085 }), R, { capStart: true });
  }

  // ---- legs ----------------------------------------------------------------
  sb.beginGroup(SLOT.pants);
  for (const s of ['L', 'R']) {
    sb.tube(chainStations([linkOf(rig, 'thigh' + s), linkOf(rig, 'shin' + s)], P_LEG,
      { ...opt, rootBone: bi('hips'), rootBlend: 0.11 }), R, { capStart: true });
  }

  // ---- neck ----------------------------------------------------------------
  sb.beginGroup(SLOT.gaiter);
  sb.tube(chainStations([linkOf(rig, 'neck')], P_NECK, opt), R, {});

  // ---- gloves --------------------------------------------------------------
  // Hand bone: +Y towards the fingers, +Z is the back of the hand, so rx is
  // the width across the knuckles and rz the thickness.
  sb.beginGroup(SLOT.glove);
  for (const s of ['L', 'R']) {
    sb.tube(manualStations(rig, 'hand' + s, [
      { t: -0.28, rx: 0.046, rz: 0.041 },
      { t: 0.05, rx: 0.055, rz: 0.043 },
      { t: 0.45, rx: 0.060, rz: 0.040 },
      { t: 0.85, rx: 0.055, rz: 0.034 },
      { t: 1.08, rx: 0.034, rz: 0.023 },
    ]), R, { capStart: true, capEnd: true });
    if (det.props) {
      // thumb, laid across the palm side
      const th = new THREE.CapsuleGeometry(0.019, 0.040, 3, 6);
      th.rotateX(0.55); th.rotateZ(s === 'L' ? 0.75 : -0.75);
      th.translate((s === 'L' ? -1 : 1) * 0.040, 0.038, -0.014);
      sb.addGeometry(th, mat4(rig, 'hand' + s), [[bi('hand' + s), 1]]);
      // knuckle pad
      const kp = new THREE.BoxGeometry(0.070, 0.052, 0.014);
      kp.translate(0, 0.062, 0.034);
      sb.addGeometry(kp, mat4(rig, 'hand' + s), [[bi('hand' + s), 1]]);
    }
    // cuff
    sb.tube(manualStations(rig, 'fore' + s, [
      { t: 0.86, rx: 0.061, rz: 0.063 },
      { t: 1.02, rx: 0.058, rz: 0.060 },
    ]), R, {});
  }

  // ---- boots ---------------------------------------------------------------
  // The foot bone lies horizontally in the binding: +Y towards the toes,
  // +Z up. The sections are pushed down in local -Z so the sole lands on the
  // topsheet instead of floating at ankle height.
  sb.beginGroup(SLOT.boot);
  for (const s of ['L', 'R']) {
    sb.tube(manualStations(rig, 'foot' + s, [
      { t: -0.34, rx: 0.062, rz: 0.086, oz: -0.046, e: 0.8 },
      { t: -0.05, rx: 0.068, rz: 0.088, oz: -0.048, e: 0.75 },
      { t: 0.32, rx: 0.070, rz: 0.078, oz: -0.058, e: 0.7 },
      { t: 0.68, rx: 0.064, rz: 0.062, oz: -0.074, e: 0.7 },
      { t: 0.95, rx: 0.048, rz: 0.044, oz: -0.092, e: 0.75 },
    ]), R, { capStart: true, capEnd: true });
    // cuff climbing the shin
    sb.tube(manualStations(rig, 'shin' + s, [
      { t: 0.60, rx: 0.086, rz: 0.090, e: 0.8 },
      { t: 0.80, rx: 0.089, rz: 0.093, e: 0.78 },
      { t: 1.00, rx: 0.084, rz: 0.088, e: 0.78 },
    ]), R, {});
  }
  sb.beginGroup(SLOT.rubber);
  for (const s of ['L', 'R']) {
    sb.tube(manualStations(rig, 'foot' + s, [
      { t: -0.34, rx: 0.058, rz: 0.020, oz: -0.116 },
      { t: 0.35, rx: 0.066, rz: 0.020, oz: -0.126 },
      { t: 0.92, rx: 0.046, rz: 0.018, oz: -0.146 },
    ]), R, { capStart: true, capEnd: true });
  }
  if (det.props) {
    sb.beginGroup(SLOT.accent);
    for (const s of ['L', 'R']) {
      // boot lace panel + power strap
      const lace = new THREE.BoxGeometry(0.026, 0.088, 0.070);
      lace.translate(0, 0.052, 0.056);
      sb.addGeometry(lace, mat4(rig, 'shin' + s).multiply(
        new THREE.Matrix4().makeTranslation(0, D.shin * 0.78, 0)), [[bi('shin' + s), 1]]);
    }
  }

  // ---- head ----------------------------------------------------------------
  const headM = mat4(rig, 'head');
  const headB = [[bi('head'), 1]];

  sb.beginGroup(SLOT.skin);
  {
    const skull = new THREE.SphereGeometry(1, det.props ? 18 : 8, det.props ? 14 : 7);
    skull.scale(0.086, 0.104, 0.096);
    skull.translate(0, 0.098, 0.004);
    sb.addGeometry(skull, headM, headB);
    const jaw = new THREE.SphereGeometry(1, det.props ? 14 : 7, det.props ? 10 : 5);
    jaw.scale(0.066, 0.062, 0.074);
    jaw.translate(0, 0.046, 0.020);
    sb.addGeometry(jaw, headM, headB);
  }

  // face mask / neck gaiter pulled up over the chin
  sb.beginGroup(SLOT.gaiter);
  {
    const g = new THREE.SphereGeometry(1, det.props ? 16 : 8, det.props ? 12 : 6);
    g.scale(0.076, 0.070, 0.083);
    g.translate(0, 0.036, 0.016);
    sb.addGeometry(g, headM, headB);
    if (det.props) {
      for (const sx of [-1, 1]) {
        const ear = new THREE.SphereGeometry(1, 10, 8);
        ear.scale(0.026, 0.044, 0.046);
        ear.translate(sx * 0.098, 0.074, -0.006);
        sb.addGeometry(ear, headM, headB);
      }
    }
  }

  // helmet shell — a partial sphere, so the face opening is real geometry
  sb.beginGroup(SLOT.helmet);
  {
    const h = new THREE.SphereGeometry(1, det.props ? 24 : 10, det.props ? 16 : 7, 0, TAU, 0, Math.PI * 0.70);
    h.scale(0.111, 0.124, 0.119);
    h.translate(0, 0.086, -0.006);
    sb.addGeometry(h, headM, headB);
    if (det.props) {
      // brim over the goggles
      const brim = new THREE.TorusGeometry(0.100, 0.013, 6, 16, Math.PI * 0.8);
      brim.rotateX(-Math.PI / 2);
      brim.rotateY(Math.PI * 0.6);
      brim.scale(1, 1, 0.86);
      brim.translate(0, 0.158, -0.004);
      sb.addGeometry(brim, headM, headB);
    }
  }

  // goggles
  if (det.props) {
    sb.beginGroup(SLOT.plastic);
    const frame = new THREE.TorusGeometry(0.098, 0.038, 8, 22, Math.PI * 1.05);
    frame.rotateX(-Math.PI / 2);
    frame.rotateY(Math.PI * 0.475);
    frame.scale(1, 0.60, 0.88);
    frame.translate(0, 0.116, 0.000);
    sb.addGeometry(frame, headM, headB);

    sb.beginGroup(SLOT.lens);
    const lens = new THREE.TorusGeometry(0.100, 0.031, 8, 22, Math.PI * 1.0);
    lens.rotateX(-Math.PI / 2);
    lens.rotateY(Math.PI * 0.5);
    lens.scale(1, 0.62, 0.94);
    lens.translate(0, 0.116, 0.012);
    sb.addGeometry(lens, headM, headB);

    sb.beginGroup(SLOT.accent);
    const strap = new THREE.TorusGeometry(0.114, 0.013, 6, 20, Math.PI * 1.10);
    strap.rotateX(-Math.PI / 2);
    strap.rotateY(-Math.PI * 0.55);
    strap.scale(1, 1, 0.90);
    strap.translate(0, 0.112, -0.004);
    sb.addGeometry(strap, headM, headB);
  }

  // hood bunched behind the neck — pure silhouette, and it hides the seam
  // where the neck tube meets the shoulders.
  sb.beginGroup(SLOT.jacket);
  {
    const hood = new THREE.SphereGeometry(1, det.props ? 16 : 8, det.props ? 12 : 6);
    hood.scale(0.115, 0.078, 0.098);
    hood.translate(0, D.chest * 0.94, -0.075);
    sb.addGeometry(hood, mat4(rig, 'chest'), [[bi('chest'), 0.7], [bi('neck'), 0.3]]);
  }

  const geo = sb.build();
  geo.computeVertexNormals();
  return geo;
}

// ── the rider ──────────────────────────────────────────────────────────────

export class Rider {
  constructor(opts = {}) {
    this.group = new THREE.Group();
    this.group.name = 'rider';

    this.mats = createMaterials(opts.palette);
    this.rig = new RiderRig();
    this.solver = new PoseSolver();

    // Solve the bind pose FIRST — the skin is generated from wherever the
    // skeleton is standing right now.
    this.rig.solve(this.solver.bindPose());
    this.group.add(this.rig.root);
    this.rig.root.updateMatrixWorld(true);

    this.skeleton = new THREE.Skeleton(this.rig.list);
    const matArray = SLOT_ORDER.map((k) => this.mats[k]);

    this.lod = new THREE.LOD();
    for (const [key, dist] of [['hi', 0], ['lo', 30]]) {
      const geo = buildSkin(this.rig, DETAIL[key]);
      const mesh = new THREE.SkinnedMesh(geo, matArray);
      mesh.bind(this.skeleton, new THREE.Matrix4());
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      // Bind-pose bounds are useless once the rider folds into a grab or
      // ragdolls, so give it a sphere that covers every pose.
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.7, 0), 2.2);
      mesh.frustumCulled = false;
      this.lod.addLevel(mesh, dist);
      if (key === 'hi') this.mesh = mesh;
    }
    this.group.add(this.lod);

    // ---- board -------------------------------------------------------------
    this.board = buildBoard(this.mats);
    this.group.add(this.board);

    // ---- cloth -------------------------------------------------------------
    // Cloth is a single sheet with no back face, so it needs its own
    // double-sided copy of the fabric rather than flipping the body's.
    const clothJacket = this.mats.jacket.clone();
    clothJacket.side = THREE.DoubleSide;
    const clothStrap = this.mats.strap.clone();
    clothStrap.side = THREE.DoubleSide;

    const skirtCols = 12;
    this.skirt = new ClothStrip({
      cols: skirtCols, rows: 4, drop: 0.185, closed: true, material: clothJacket, stretch: 1.02,
    });
    this.group.add(this.skirt.mesh);
    this._skirtAnchors = Array.from({ length: skirtCols }, () => new THREE.Vector3());

    // Two strap tails hanging off the bindings. Their anchors are fixed points
    // on the board, so they behave correctly no matter what the rider does.
    this.straps = [];
    for (const [z, x] of [[BOARD.noseZ, 0.115], [BOARD.tailZ, 0.115]]) {
      const s = new ClothStrip({ cols: 3, rows: 4, drop: 0.135, closed: false, material: clothStrap });
      this.group.add(s.mesh);
      const y = baseLine(z / (BOARD.length * 0.5)) + 0.085;
      this.straps.push({
        strip: s,
        anchors: [
          new THREE.Vector3(x - 0.012, y + 0.02, z - 0.022),
          new THREE.Vector3(x, y, z),
          new THREE.Vector3(x - 0.012, y + 0.02, z + 0.022),
        ],
      });
    }

    // ---- scratch -----------------------------------------------------------
    this._q = new THREE.Quaternion();
    this._q2 = new THREE.Quaternion();
    this._m = new THREE.Matrix4();
    this._x = new THREE.Vector3();
    this._y = new THREE.Vector3();
    this._z = new THREE.Vector3();
    this._accel = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
    this._crashSpin = new THREE.Quaternion();
    this._crashAxis = new THREE.Vector3(0.3, 0.5, 0.8).normalize();
    this._crashT = 0;
    this._wasCrashed = false;
    this._t = 0;
  }

  /** Swap the outfit palette at runtime (materials.js rebuilds its textures). */
  setPalette(p) {
    const m = createMaterials(p);
    for (const k of SLOT_ORDER) {
      if (this.mats[k] && m[k]) this.mats[k].copy(m[k]);
    }
  }

  update(dt, body, tricks) {
    if (!body) return;
    const d = Math.min(dt || 0, 1 / 15);
    this._t += d;

    // ---- frame ---------------------------------------------------------------
    // Board basis from the physics body: local -Z is the heading, local +Y the
    // surface up. On the ground that keeps the base flat on a traverse; in the
    // air `up` has already relaxed to world up, so it degenerates to yaw.
    const fwd = this._z.copy(body.forward ?? { x: 0, y: 0, z: -1 });
    if (fwd.lengthSq() < 1e-8) fwd.set(0, 0, -1);
    fwd.normalize();
    const up = this._y.copy(body.up ?? { x: 0, y: 1, z: 0 });
    if (up.lengthSq() < 1e-8) up.set(0, 1, 0);
    up.normalize();
    this._x.crossVectors(fwd, up);
    if (this._x.lengthSq() < 1e-8) this._x.set(1, 0, 0);
    this._x.normalize();
    up.crossVectors(this._x, fwd).normalize();
    this._m.makeBasis(this._x, up, this._tmp.copy(fwd).negate());
    this._q.setFromRotationMatrix(this._m);

    // Flip (about the board's lateral axis) then edge roll (about its length).
    // Positive body.pitch is a frontflip, which drops the nose, hence -pitch.
    this._q2.setFromAxisAngle(this._tmp.set(1, 0, 0), -(body.pitch ?? 0));
    this._q.multiply(this._q2);
    this._q2.setFromAxisAngle(this._tmp.set(0, 0, 1), body.roll ?? 0);
    this._q.multiply(this._q2);

    // Crash: the physics body freezes its angles, so the tumble is ours. It
    // accelerates into the fall and then bleeds off as the rider slides out.
    const crashed = !!body.crashed;
    if (crashed) {
      this._crashT += d;
      if (!this._wasCrashed) {
        this._crashAxis.set(0.35 + Math.random() * 0.5, 0.35 + Math.random() * 0.5,
          (Math.random() - 0.5) * 1.6).normalize();
      }
      const spin = Math.min(this._crashT, 1.5) * 3.4 + this._crashT * 1.2;
      this._crashSpin.setFromAxisAngle(this._crashAxis, spin);
      this._q.multiply(this._crashSpin);
    } else if (this._crashT > 0) {
      this._crashT = Math.max(0, this._crashT - d * 3.5);
      if (this._crashT > 0.01) {
        this._crashSpin.setFromAxisAngle(this._crashAxis, this._crashT * 3.4);
        this._q.multiply(this._crashSpin);
      }
    }
    this._wasCrashed = crashed;

    this.group.quaternion.copy(this._q);
    this.group.position.copy(body.pos);
    // The physics origin is the base of the board; sink it by half the base
    // camber so the contact points, not the middle of the base, touch snow.
    this.group.position.addScaledVector(up, -BOARD.camber * 0.5);
    this.group.updateMatrixWorld();

    // ---- pose ----------------------------------------------------------------
    this.solver.update(d, body, tricks, this.rig);

    // ---- cloth ---------------------------------------------------------------
    this._updateCloth(d, body);
  }

  _updateCloth(dt, body) {
    // Gravity plus the slipstream, both rotated into board space. The cloth
    // solver runs entirely in this frame, so once the rider inverts, the skirt
    // falls towards their head exactly as it should.
    const inv = this._q2.copy(this.group.quaternion).invert();
    this._accel.set(0, -22, 0);
    if (body.vel) {
      // Drag from the relative airflow. Quadratic-ish, capped so a 60 m/s
      // straight-line does not turn the jacket into a flat plate.
      const v = this._tmp.copy(body.vel);
      const sp = v.length();
      if (sp > 0.1) this._accel.addScaledVector(v, -Math.min(1.35, 0.055 * sp));
    }
    this._accel.applyQuaternion(inv);
    // A little flutter so the fabric never goes dead in a straight line.
    const f = this._t * 12;
    this._accel.x += Math.sin(f) * 2.4;
    this._accel.z += Math.sin(f * 0.77 + 1.3) * 2.4;

    // Jacket skirt: anchored to a ring around the waist, driven off the actual
    // solved spine so it swings when the rider twists.
    const wp = this.rig.wp.spine1, wq = this.rig.wq.spine1;
    const n = this._skirtAnchors.length;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      this._skirtAnchors[i]
        .set(Math.cos(a) * 0.146, 0.020, Math.sin(a) * 0.118)
        .applyQuaternion(wq).add(wp);
    }
    this._collide = this._collide || { p: new THREE.Vector3(), r: 0.118, axis: new THREE.Vector3() };
    this._collide.p.copy(this.rig.wp.hips);
    this._collide.axis.set(0, 1, 0).applyQuaternion(this.rig.wq.hips);
    this.skirt.update(dt, this._skirtAnchors, this._accel, this._collide);

    for (const s of this.straps) s.strip.update(dt, s.anchors, this._accel, null);
  }
}

export default Rider;
