/**
 * OWNER: agent "props".
 *
 * The big man-made objects. Their job is scale and place: a lift line climbing
 * away up the flank tells you how big the mountain is far more convincingly
 * than any amount of terrain does, and a lodge with smoke and lit windows tells
 * you people are here.
 *
 *   chairlift   towers every 95 m, twin haul ropes with real sag, and chairs
 *               that travel up the line and swing on their hangers
 *   lodge       timber-and-stone day lodge with a snow-loaded roof
 *   patrol hut  a small red hut with a cross, half way down
 *   snow guns   fan cannons on the piste edge, angled into the run
 *
 * The towers, buildings and guns are static and go into the shared Dressing
 * buckets. The chairs move, so they are a single InstancedMesh refilled each
 * frame from the same cable function the towers were built from — which is why
 * they hang exactly on the rope instead of near it.
 */

import * as THREE from 'three';
import { mulberry32 } from '../core/noise.js';
import { heightAt, courseXAt, courseAt, progressAt, COURSE_LENGTH } from './terrain.js';
import {
  cyl, box, card, xf, span, slab, paint, atlasUV, mergeAll, truss, padY, lerp,
} from './propCommon.js';
import { makeMetal } from '../shaders/propShaders.js';
import { CELL, BRANDS } from '../shaders/propTextures.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

// --------------------------------------------------------------------------
// the lift line
// --------------------------------------------------------------------------
const LIFT_OFFSET = 178;        // metres to skier's left of the course centre
const TOWER_SPACING = 96;
const TOWER_H = 12.5;
const CABLE_GAUGE = 2.9;        // separation of the two haul ropes
const SAG = 2.4;
const TOP_TOWER = 2;            // first tower index (the run starts below the top)
const N_TOWERS = Math.floor(COURSE_LENGTH / TOWER_SPACING);

function liftX(z) { return courseXAt(z) + LIFT_OFFSET; }
function towerZ(m) { return -m * TOWER_SPACING; }

/** Top-of-tower point for tower m. */
function towerTop(m) {
  const z = towerZ(m);
  const x = liftX(z);
  return V(x, heightAt(x, z) + TOWER_H, z);
}

/**
 * Height of the haul rope at depth z, with catenary sag between towers.
 * Towers and chairs both call this, so they cannot disagree.
 */
function cableAt(z) {
  const s = -z / TOWER_SPACING;
  const m = Math.floor(s);
  const u = s - m;
  const a = towerTop(Math.max(TOP_TOWER, Math.min(N_TOWERS, m)));
  const b = towerTop(Math.max(TOP_TOWER, Math.min(N_TOWERS, m + 1)));
  return V(lerp(a.x, b.x, u), lerp(a.y, b.y, u) - SAG * 4 * u * (1 - u), z);
}

/** One lift tower: tapered lattice mast, cross-arm, sheave trains. */
function liftTower(out, m) {
  const top = towerTop(m);
  const g = truss(TOWER_H, 0.95, 0.10, 8);
  xf(g, { p: [top.x, top.y - TOWER_H, top.z] });
  out.metal.push(paint(g, 0xb9c2cc));
  out.matte.push(paint(xf(box(2.8, 0.8, 2.8), { p: [top.x, top.y - TOWER_H + 0.2, top.z] }), 0x6f757e));

  // cross-arm and the sheave trains hanging off each end
  out.metal.push(paint(span(cyl(0.13, 0.13, 1, 6),
    V(top.x, top.y, top.z - CABLE_GAUGE * 0.5 - 0.5),
    V(top.x, top.y, top.z + CABLE_GAUGE * 0.5 + 0.5)), 0xcbd2da));
  for (const s of [-1, 1]) {
    const az = top.z + s * CABLE_GAUGE * 0.5;
    out.metal.push(paint(xf(box(2.6, 0.16, 0.20), { p: [top.x, top.y - 0.34, az], r: [0, Math.PI * 0.5, 0] }), 0x99a2ac));
    for (let k = -2; k <= 2; k++) {
      out.metal.push(paint(xf(cyl(0.20, 0.20, 0.14, 8),
        { p: [top.x, top.y - 0.52, az + k * 0.52], r: [Math.PI * 0.5, 0, 0] }), 0x3d434b));
    }
  }
  // ladder up the back
  for (let k = 0; k < 12; k++) {
    out.metal.push(paint(xf(cyl(0.022, 0.022, 0.7, 4),
      { p: [top.x + 1.0, top.y - TOWER_H + 0.8 + k, top.z], r: [Math.PI * 0.5, 0, 0] }), 0xa8b0ba));
  }
}

// --------------------------------------------------------------------------
// buildings
// --------------------------------------------------------------------------
/** Timber lodge: stone base, log walls, deep snow-loaded gable roof. */
function lodge(out, x, z, yaw, w, d, rng) {
  const y = padY(x, z, Math.max(w, d) * 0.5) - 0.4;
  const wallH = 4.6;
  const parts = { matte: [], metal: [], fabric: [] };

  // stone base
  parts.matte.push(paint(xf(box(w + 1.1, 1.5, d + 1.1), { p: [0, 0.55, 0] }), 0x5b5f66));
  // log walls
  parts.matte.push(paint(xf(box(w, wallH, d), { p: [0, 1.3 + wallH * 0.5, 0] }), 0x6b4a2f));
  for (let k = 0; k < 7; k++) {
    parts.matte.push(paint(xf(box(w + 0.14, 0.16, d + 0.14),
      { p: [0, 1.6 + k * 0.62, 0] }), 0x54381f));
  }
  // gable roof: two slabs meeting at the ridge, with a heavy snow cap
  const ridgeY = 1.3 + wallH + 2.9;
  for (const s of [-1, 1]) {
    const a = V(s * (w * 0.5 + 1.0), 1.3 + wallH - 0.2, 0);
    const b = V(0, ridgeY, 0);
    const roof = slab(a, b, d + 2.0, 0.34);
    parts.matte.push(paint(roof, 0x3b2a1c));
    const snow = slab(V(a.x, a.y + 0.30, 0), V(b.x, b.y + 0.30, 0), d + 2.2, 0.30);
    parts.matte.push(paint(snow, 0xeaf1fb));
  }
  // gable ends
  for (const s of [-1, 1]) {
    parts.matte.push(paint(xf(box(w, 2.9, 0.22),
      { p: [0, 1.3 + wallH + 1.45, s * d * 0.5] }), 0x6b4a2f));
  }
  // windows, warm inside
  for (let k = 0; k < 5; k++) {
    const px = -w * 0.36 + (k / 4) * w * 0.72;
    parts.matte.push(paint(xf(box(1.5, 1.4, 0.12), { p: [px, 1.3 + 2.6, d * 0.5 + 0.02] }), 0xffd79a));
    parts.matte.push(paint(xf(box(1.7, 1.6, 0.08), { p: [px, 1.3 + 2.6, d * 0.5 - 0.02] }), 0x33241a));
  }
  // deck and railing on the downhill face
  parts.matte.push(paint(xf(box(w + 2.2, 0.22, 3.4), { p: [0, 1.28, d * 0.5 + 1.9] }), 0x4d3a25));
  for (let k = 0; k <= 10; k++) {
    const px = -(w + 2.0) * 0.5 + (k / 10) * (w + 2.0);
    parts.metal.push(paint(xf(cyl(0.04, 0.05, 1.0, 5), { p: [px, 1.9, d * 0.5 + 3.5] }), 0x8a949e));
  }
  parts.metal.push(paint(xf(box(w + 2.2, 0.09, 0.09), { p: [0, 2.4, d * 0.5 + 3.5] }), 0x8a949e));
  // chimney
  parts.matte.push(paint(xf(box(1.1, 4.2, 1.1), { p: [w * 0.22, 1.3 + wallH + 1.6, -d * 0.18] }), 0x55595f));
  // a sponsor board on the gable
  const sign = card(w * 0.66, 1.2);
  atlasUV(sign, CELL.seriesBanner);
  paint(sign, 0xffffff);
  xf(sign, { p: [0, 1.3 + wallH + 1.6, d * 0.5 + 0.16] });
  parts.fabric.push(sign);

  for (const k of ['matte', 'metal', 'fabric']) {
    const g = mergeAll(parts[k]);
    if (g) out[k].push(xf(g, { p: [x, y, z], r: [0, yaw, 0] }));
  }
  void rng;
}

/** Small patrol hut: red, cross on the gable, a stack of rescue sleds outside. */
function patrolHut(out, x, z, yaw) {
  const y = padY(x, z, 3.2) - 0.3;
  const parts = { matte: [], metal: [], fabric: [] };
  parts.matte.push(paint(xf(box(4.6, 2.9, 3.6), { p: [0, 1.45, 0] }), 0xa8231f));
  for (const s of [-1, 1]) {
    const a = V(s * 2.9, 2.75, 0), b = V(0, 4.5, 0);
    parts.matte.push(paint(slab(a, b, 4.2, 0.22), 0x2f2a28));
    parts.matte.push(paint(slab(V(a.x, a.y + 0.22, 0), V(b.x, b.y + 0.22, 0), 4.4, 0.26), 0xecf3fd));
  }
  parts.matte.push(paint(xf(box(0.9, 0.24, 0.1), { p: [0, 3.55, 1.83] }), 0xffffff));
  parts.matte.push(paint(xf(box(0.24, 0.9, 0.1), { p: [0, 3.55, 1.83] }), 0xffffff));
  parts.matte.push(paint(xf(box(1.1, 2.1, 0.1), { p: [0, 1.05, 1.82] }), 0x3a2b22));
  parts.metal.push(paint(xf(cyl(0.05, 0.06, 5.0, 5), { p: [2.6, 2.5, -1.6] }), 0x99a2ac));
  const flag = card(1.5, 0.95);
  atlasUV(flag, CELL.hazard);
  paint(flag, 0xffffff, 0.9);
  xf(flag, { p: [2.6 - 0.75, 4.4, -1.6], r: [0, Math.PI * 0.5, 0] });
  parts.fabric.push(flag);
  // sleds
  for (let k = 0; k < 3; k++) {
    parts.matte.push(paint(xf(box(0.7, 0.22, 2.2), { p: [-2.9, 0.2 + k * 0.26, 1.0 + k * 0.1], r: [0, 0.2, 0] }), 0xe8500f));
  }
  for (const k of ['matte', 'metal', 'fabric']) {
    const g = mergeAll(parts[k]);
    if (g) out[k].push(xf(g, { p: [x, y, z], r: [0, yaw, 0] }));
  }
}

/** Fan-type snow cannon on a mast, aimed across the piste. */
function snowGun(out, x, z, aim) {
  const y = heightAt(x, z) - 0.3;
  out.metal.push(paint(xf(cyl(0.11, 0.16, 3.2, 6), { p: [x, y + 1.6, z] }), 0x8d97a2));
  out.metal.push(paint(xf(box(0.9, 0.24, 0.9), { p: [x, y + 0.12, z] }), 0x6d757e));
  // barrel
  const dir = V(Math.sin(aim), 0.36, Math.cos(aim)).normalize();
  const a = V(x, y + 3.1, z);
  const b = a.clone().addScaledVector(dir, 1.7);
  out.metal.push(paint(span(cyl(0.44, 0.50, 1, 10), a, b), 0x3f454d));
  out.matte.push(paint(span(cyl(0.52, 0.52, 1, 10),
    b, b.clone().addScaledVector(dir, 0.12)), 0xf2c200));
  // hose coiled at the foot
  out.matte.push(paint(xf(cyl(0.42, 0.42, 0.22, 10), { p: [x + 0.8, y + 0.2, z + 0.5] }), 0x1c2026));
}

// --------------------------------------------------------------------------
// chairs
// --------------------------------------------------------------------------
function buildChair() {
  const parts = [];
  // hanger
  parts.push(paint(xf(cyl(0.05, 0.05, 2.5, 5), { p: [0, -1.25, 0] }), 0x9aa3ad));
  parts.push(paint(xf(box(0.3, 0.22, 0.3), { p: [0, 0.05, 0] }), 0x545b64));
  // seat pan and back
  parts.push(paint(xf(box(2.6, 0.14, 0.62), { p: [0, -2.5, 0.16] }), 0xd4341f));
  parts.push(paint(xf(box(2.6, 0.85, 0.12), { p: [0, -2.1, -0.22] }), 0xd4341f));
  parts.push(paint(xf(box(2.6, 0.10, 0.10), { p: [0, -1.55, 0.42] }), 0x8a929b));
  // arms
  for (const s of [-1, 1]) {
    parts.push(paint(xf(cyl(0.035, 0.035, 1.05, 4), { p: [s * 1.28, -2.05, 0] }), 0x8a929b));
  }
  const g = mergeAll(parts);
  g.computeBoundingSphere();
  return g;
}

// --------------------------------------------------------------------------
export function createStructures(scene, materials) {
  const rng = mulberry32(0x1F7C0);

  // Fixed sites, chosen so they read against the run rather than hide behind it.
  const SITES = [
    { kind: 'lodge', z: -3320, side: 1, off: 96, yaw: -0.35, w: 17, d: 11 },
    { kind: 'lodge', z: -6180, side: -1, off: 86, yaw: 0.5, w: 21, d: 13 },
    { kind: 'hut', z: -1180, side: -1, off: 52, yaw: 0.3 },
    { kind: 'hut', z: -4460, side: 1, off: 58, yaw: -0.4 },
  ];

  function emit(sink, z0, z1, bucket) {
    const out = { matte: [], metal: [], fabric: [] };

    // lift towers in this slice
    const m0 = Math.max(TOP_TOWER, Math.ceil(-z1 / TOWER_SPACING));
    const m1 = Math.min(N_TOWERS, Math.floor(-z0 / TOWER_SPACING));
    for (let m = m0; m <= m1; m++) liftTower(out, m);

    // haul ropes: one polyline per bay, both directions
    for (let m = m0 - 1; m <= m1; m++) {
      if (m < TOP_TOWER || m >= N_TOWERS) continue;
      for (const s of [-1, 1]) {
        const pts = [];
        for (let k = 0; k <= 4; k++) {
          const z = towerZ(m) - (k / 4) * TOWER_SPACING;
          const c = cableAt(z);
          pts.push(V(c.x, c.y - 0.52, z + s * CABLE_GAUGE * 0.5));
        }
        for (let k = 0; k + 1 < pts.length; k++) {
          out.metal.push(paint(span(cyl(0.045, 0.045, 1, 4), pts[k], pts[k + 1]), 0x6a7078));
        }
      }
    }

    // buildings
    for (const s of SITES) {
      if (s.z < z0 || s.z >= z1) continue;
      const half = courseAt(progressAt(s.z)).width * 0.5;
      const x = courseXAt(s.z) + s.side * (half + s.off);
      if (s.kind === 'lodge') lodge(out, x, s.z, s.yaw, s.w, s.d, rng);
      else patrolHut(out, x, s.z, s.yaw);
    }

    // snow guns down the piste edge
    for (let zz = Math.ceil(-z1 / 210) * 210; -zz > z0; zz += 210) {
      const z = -zz;
      if (z > -120 || z < -COURSE_LENGTH + 120) continue;
      const side = ((zz / 210) | 0) % 2 ? 1 : -1;
      const half = courseAt(progressAt(z)).width * 0.5;
      const x = courseXAt(z) + side * (half + 5.0);
      snowGun(out, x, z, side < 0 ? 1.25 : -1.25);
    }

    sink.add('matte', mergeAll(out.matte));
    sink.add('metal', mergeAll(out.metal));
    sink.add('fabric', mergeAll(out.fabric));
    void bucket;
    void BRANDS;
  }

  // ---- moving chairs ------------------------------------------------------
  const CHAIR_MAX = 40;
  const CHAIR_SPACING = 74;
  const chairMat = makeMetal({ snow: 0.10, name: 'liftChair' });
  const chairMesh = new THREE.InstancedMesh(buildChair(), chairMat, CHAIR_MAX);
  chairMesh.name = 'lift-chairs';
  chairMesh.count = 0;
  chairMesh.frustumCulled = false;
  chairMesh.castShadow = false;
  chairMesh.receiveShadow = false;
  chairMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  scene.add(chairMesh);

  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _e = new THREE.Euler();
  const _p = new THREE.Vector3();
  const _s = new THREE.Vector3(1, 1, 1);
  let elapsed = 0;

  function update(dt, camera) {
    elapsed += dt;
    const camZ = camera.position.z;
    const RANGE = 420;
    // Chairs travel uphill, so their distance along the line decreases.
    const phase = (elapsed * 2.7) % CHAIR_SPACING;
    let n = 0;
    const kMin = Math.floor((-camZ - RANGE - phase) / CHAIR_SPACING);
    const kMax = Math.ceil((-camZ + RANGE - phase) / CHAIR_SPACING);
    for (let k = kMin; k <= kMax && n < CHAIR_MAX; k++) {
      const sDist = k * CHAIR_SPACING + phase;
      if (sDist < TOP_TOWER * TOWER_SPACING || sDist > N_TOWERS * TOWER_SPACING) continue;
      const z = -sDist;
      const side = ((k % 2) + 2) % 2 ? 1 : -1;   // two ropes, alternating
      const c = cableAt(z);
      // Pendulum swing: gentle, phase-shifted per chair so the line is alive.
      const sw = Math.sin(elapsed * 0.9 + k * 1.7) * 0.055 + Math.sin(elapsed * 1.7 + k) * 0.02;
      _p.set(c.x, c.y - 0.55, z + side * CABLE_GAUGE * 0.5);
      _e.set(sw * 0.5, side > 0 ? 0 : Math.PI, sw, 'YXZ');
      _q.setFromEuler(_e);
      _m.compose(_p, _q, _s);
      _m.toArray(chairMesh.instanceMatrix.array, n * 16);
      n++;
    }
    chairMesh.count = n;
    chairMesh.instanceMatrix.needsUpdate = true;
  }

  return { emit, update, chairMesh, cableAt };
}
