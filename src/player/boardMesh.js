/**
 * OWNER: agent "character".
 *
 * The snowboard. Modelled the way a real one is specified rather than as a
 * box: an effective edge with sidecut between the contact points, rounded
 * tip/tail outside them, camber under the bindings, progressive rocker in the
 * kicks, and a cross-section that actually has a base, a steel edge, a sidewall
 * and a crowned topsheet — which is what makes the thing read as a board from
 * every angle instead of only from above.
 *
 * Board space is the rider group's local space: -Z nose, +Z tail, +Y up.
 */
import * as THREE from 'three';

export const BOARD = {
  length: 1.56,
  waist: 0.1255,        // half-width at the waist
  tip: 0.1480,          // half-width at the widest point
  contact: 0.70,        // |s| at the contact points, s in [-1,1]
  camber: 0.0135,
  kick: 0.088,
  thick: 0.0145,
  noseZ: -0.255,        // binding centres — must match poses.js STANCE
  tailZ: 0.255,
  angleNose: 0.30,
  angleTail: -0.14,
};

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Half-width at s in [-1,1]. Sidecut inside the contacts, round outside. */
export function halfWidth(s) {
  const a = Math.abs(s);
  const c = BOARD.contact;
  if (a <= c) {
    const k = a / c;
    return BOARD.waist + (BOARD.tip - BOARD.waist) * k * k;
  }
  const k = (a - c) / (1 - c);
  return Math.max(0.008, BOARD.tip * Math.sqrt(Math.max(0, 1 - k * k * (1 - 0.0035))));
}

/** Base-line height at s: camber between the contacts, rocker beyond them. */
export function baseLine(s) {
  const a = Math.abs(s);
  const c = BOARD.contact;
  let y = 0;
  if (a <= c) {
    const k = a / c;
    y += BOARD.camber * (1 - k * k);
  }
  if (a > 0.58) {
    const k = (a - 0.58) / 0.42;
    y += BOARD.kick * Math.pow(k, 2.3);
  }
  return y;
}

function thickness(s) {
  const a = Math.abs(s);
  return 0.0055 + (BOARD.thick - 0.0055) * (1 - a * a * a);
}

/**
 * One cross-section loop. Each point carries the material of the segment that
 * *leaves* it, so the loft can split into groups without a second pass.
 */
function loop(hw, y0, th) {
  const pts = [];
  const NB = 8, NT = 10;
  const hwb = Math.max(0.001, hw - 0.0048);
  const hwt = hw * 0.965;
  const chamfer = 0.0032;

  for (let i = 0; i <= NB; i++) {
    const x = -hwb + (i / NB) * 2 * hwb;
    pts.push({ x, y: y0, u: 0.5 + 0.5 * (x / (hw || 1)), seg: i < NB ? 'base' : 'edge' });
  }
  pts.push({ x: hw, y: y0 + chamfer, u: 1, seg: 'wall' });
  pts.push({ x: hw, y: y0 + th * 0.62, u: 1, seg: 'top' });
  for (let i = 0; i <= NT; i++) {
    const f = i / NT;
    const x = hwt - f * 2 * hwt;
    const crown = Math.cos((x / (hwt || 1)) * Math.PI * 0.5);
    pts.push({
      x, y: y0 + th * (0.70 + 0.30 * crown), u: 0.5 + 0.5 * (x / (hw || 1)),
      seg: i < NT ? 'top' : 'wall',
    });
  }
  pts.push({ x: -hw, y: y0 + th * 0.62, u: 0, seg: 'wall' });
  pts.push({ x: -hw, y: y0 + chamfer, u: 0, seg: 'edge' });
  return pts;
}

const MAT_ORDER = ['base', 'edge', 'wall', 'top'];

/**
 * @returns { geometry, groups } — geometry group material indices are the
 * offsets into `materialsInOrder` below.
 */
export function buildBoardGeometry(stations = 46) {
  const pos = [], uv = [], idx = [];
  const buckets = { base: [], edge: [], wall: [], top: [] };
  const rows = [];

  for (let i = 0; i <= stations; i++) {
    const t = i / stations;
    const s = (t - 0.5) * 2;
    const z = s * BOARD.length * 0.5;
    const hw = halfWidth(s);
    const y0 = baseLine(s);
    const th = thickness(s);
    const L = loop(hw, y0, th);
    const row = [];
    for (const pt of L) {
      pos.push(pt.x, pt.y, z);
      uv.push(pt.u, t * 1.0);
      row.push({ id: pos.length / 3 - 1, seg: pt.seg });
    }
    rows.push(row);
  }

  const N = rows[0].length;
  for (let i = 0; i < rows.length - 1; i++) {
    const A = rows[i], B = rows[i + 1];
    for (let k = 0; k < N; k++) {
      const k2 = (k + 1) % N;
      const bucket = buckets[A[k].seg] || buckets.top;
      bucket.push(A[k].id, B[k].id, B[k2].id, A[k].id, B[k2].id, A[k2].id);
    }
  }

  // Tip and tail caps. The end loops are tiny but not degenerate, so a fan off
  // the section centre closes them cleanly.
  const cap = (row, s) => {
    const zc = (s - 0.5) * 2 * BOARD.length * 0.5;
    const c = pos.length / 3;
    let ys = 0;
    for (const r of row) ys += pos[r.id * 3 + 1];
    pos.push(0, ys / row.length, zc);
    uv.push(0.5, s);
    for (let k = 0; k < N; k++) {
      const k2 = (k + 1) % N;
      if (s < 0.5) buckets.wall.push(row[k].id, c, row[k2].id);
      else buckets.wall.push(row[k].id, row[k2].id, c);
    }
  };
  cap(rows[0], 0);
  cap(rows[rows.length - 1], 1);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  let start = 0;
  for (let m = 0; m < MAT_ORDER.length; m++) {
    const b = buckets[MAT_ORDER[m]];
    for (const v of b) idx.push(v);
    geo.addGroup(start, b.length, m);
    start += b.length;
  }
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

// ── bindings ───────────────────────────────────────────────────────────────

function roundedPlate(w, l, h, r = 0.012) {
  const shape = new THREE.Shape();
  const hw = w / 2 - r, hl = l / 2 - r;
  shape.moveTo(-hw - r, -hl);
  shape.lineTo(-hw - r, hl);
  shape.quadraticCurveTo(-hw - r, hl + r, -hw, hl + r);
  shape.lineTo(hw, hl + r);
  shape.quadraticCurveTo(hw + r, hl + r, hw + r, hl);
  shape.lineTo(hw + r, -hl);
  shape.quadraticCurveTo(hw + r, -hl - r, hw, -hl - r);
  shape.lineTo(-hw, -hl - r);
  shape.quadraticCurveTo(-hw - r, -hl - r, -hw - r, -hl);
  const g = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: true, bevelSize: 0.004, bevelThickness: 0.003, bevelSegments: 2, curveSegments: 4 });
  g.rotateX(-Math.PI / 2);
  return g;
}

/** A strap: a shallow arc of a flattened tube, spanning the boot. */
function strapArc(span, rise, width, thick, seg = 12) {
  const pts = [];
  for (let i = 0; i <= seg; i++) {
    const u = i / seg;
    const x = (u - 0.5) * span;
    const y = Math.sin(u * Math.PI) * rise;
    pts.push(new THREE.Vector3(x, y, 0));
  }
  const curve = new THREE.CatmullRomCurve3(pts);
  const g = new THREE.TubeGeometry(curve, seg, width * 0.5, 6, false);
  g.scale(1, 1, thick / width);
  return g;
}

/**
 * A complete binding: baseplate, heelcup, highback with a forward-lean strut,
 * an ankle strap and a toe cap strap, each with a ratchet buckle.
 * Built at the origin, +X toe side, and returned as a list of
 * { geometry, material } so the caller can merge or place them.
 */
export function buildBinding(mats, angle) {
  const parts = [];
  const push = (g, m, fn) => { if (fn) fn(g); parts.push({ geometry: g, material: m }); };

  // baseplate sits on the topsheet
  push(roundedPlate(0.245, 0.135, 0.012, 0.014), mats.plastic, (g) => g.translate(0, 0.0, 0));

  // heelcup: a low wall around the heel edge
  const cup = new THREE.CylinderGeometry(0.082, 0.086, 0.048, 14, 1, true, Math.PI * 0.42, Math.PI * 1.16);
  push(cup, mats.plastic, (g) => { g.scale(1.35, 1, 0.95); g.translate(-0.012, 0.030, 0); });

  // highback
  const hb = new THREE.CylinderGeometry(0.072, 0.062, 0.175, 12, 3, true, Math.PI * 0.52, Math.PI * 0.96);
  push(hb, mats.plastic, (g) => {
    g.scale(1.25, 1, 1.0);
    g.rotateZ(0.30);
    g.translate(-0.052, 0.106, 0);
  });
  // forward-lean strut
  push(new THREE.BoxGeometry(0.018, 0.052, 0.030), mats.metal, (g) => { g.rotateZ(0.3); g.translate(-0.094, 0.038, 0); });

  // ankle strap
  push(strapArc(0.190, 0.052, 0.062, 0.016, 14), mats.strap, (g) => { g.translate(0.006, 0.088, 0); });
  push(new THREE.BoxGeometry(0.030, 0.024, 0.036), mats.metal, (g) => g.translate(0.086, 0.078, 0));
  push(new THREE.BoxGeometry(0.014, 0.038, 0.026), mats.accent, (g) => { g.rotateZ(-0.4); g.translate(0.100, 0.092, 0); });

  // toe cap strap
  push(strapArc(0.150, 0.040, 0.052, 0.014, 12), mats.strap, (g) => { g.rotateZ(0.22); g.translate(0.062, 0.038, 0); });
  push(new THREE.BoxGeometry(0.026, 0.020, 0.030), mats.metal, (g) => g.translate(0.128, 0.030, 0));

  // disc / hardware
  const disc = new THREE.CylinderGeometry(0.042, 0.042, 0.006, 16);
  push(disc, mats.metal, (g) => g.translate(0, 0.013, 0));

  const group = new THREE.Group();
  group.rotation.y = angle;
  for (const p of parts) {
    const m = new THREE.Mesh(p.geometry, p.material);
    m.castShadow = true;
    group.add(m);
  }
  return group;
}

/**
 * The whole board: deck plus both bindings, parented into one group at the
 * board origin (the centre of the base).
 */
export function buildBoard(mats, opts = {}) {
  const group = new THREE.Group();
  const geo = buildBoardGeometry(opts.stations ?? 46);
  const deck = new THREE.Mesh(geo, [mats.boardBase, mats.metal, mats.plastic, mats.boardTop]);
  deck.castShadow = true;
  deck.receiveShadow = true;
  group.add(deck);

  for (const [z, ang] of [[BOARD.noseZ, BOARD.angleNose], [BOARD.tailZ, BOARD.angleTail]]) {
    const b = buildBinding(mats, ang);
    b.position.set(0, baseLine((z / (BOARD.length * 0.5))) + thickness(z / (BOARD.length * 0.5)) * 0.98, z);
    group.add(b);
  }
  group.userData.deck = deck;
  return group;
}
