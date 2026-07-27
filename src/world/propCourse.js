/**
 * OWNER: agent "props".
 *
 * Course furniture. Trees and rocks make a mountain; this file is what makes
 * the mountain a *race course* — the difference between riding down a valley
 * and riding down stage 4 of a series.
 *
 *   start gate and finish arch      the two moments that book-end the run
 *   marker poles down both edges    the single strongest read of "this is a run"
 *   pennant lines                   colour and motion at the periphery
 *   B-net on the outside of corners this is where a real course puts it
 *   padded gate posts               paired at every authored feature
 *   sponsor banners                 fictional brands, see propTextures.js
 *   distance boards                 6 KM ... 1 KM to the finish
 *   spectator hoardings             crowd barriers around the big hits
 *
 * Everything here is a Dressing emitter: it is asked for one 400 m slice of
 * course at a time and returns merged geometry per material, so a whole
 * kilometre of dressing costs three draw calls.
 */

import * as THREE from 'three';
import { mulberry32 } from '../core/noise.js';
import {
  heightAt, courseXAt, courseAt, progressAt, courseFeatures, COURSE_LENGTH,
} from './terrain.js';
import {
  cyl, box, card, xf, span, paint, waveByX, atlasUV, mergeAll, truss, clamp,
} from './propCommon.js';
import { CELL, BRANDS } from '../shaders/propTextures.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

/** Half-width of the groomed run at a depth. */
function halfAt(z) { return courseAt(progressAt(z)).width * 0.5; }

/** A point on the edge of the run, `margin` metres outside the groomed width. */
function edge(z, side, margin) {
  const x = courseXAt(z) + side * (halfAt(z) + margin);
  return V(x, heightAt(x, z), z);
}

/**
 * Course curvature at a depth, in the same units terrain.js uses to bank its
 * own turns. Positive means the run is bending towards +X, so the *outside* of
 * the corner — where the netting goes — is the -X side.
 */
function curvature(z) {
  const cx = courseXAt(z);
  return (courseXAt(z - 80) - 2 * cx + courseXAt(z + 80)) / 6400;
}

// --------------------------------------------------------------------------
// pieces
// --------------------------------------------------------------------------

/** Slalom / piste marker pole with a pennant. */
function markerPole(out, p, colour, pennant, rng) {
  const h = 2.5 + rng() * 0.4;
  out.matte.push(paint(xf(cyl(0.035, 0.055, h, 5), { p: [p.x, p.y - 0.3 + h * 0.5, p.z] }), colour));
  // a snow-coloured collar at the base, as if drifted in
  out.matte.push(paint(xf(cyl(0.13, 0.20, 0.22, 6), { p: [p.x, p.y - 0.22, p.z] }), 0xdfe8f4));
  if (pennant >= 0) {
    const flag = card(0.62, 0.36);
    atlasUV(flag, pennant);
    paint(flag, 0xffffff, 1);
    // Only the free edge flaps; the hoist stays on the pole.
    waveByX(flag, (x) => clamp((x + 0.31) / 0.62, 0, 1) ** 1.6);
    xf(flag, { p: [p.x, p.y - 0.3 + h - 0.24, p.z - 0.31], r: [0, Math.PI * 0.5, 0] });
    out.fabric.push(flag);
  }
}

/** Padded post: a fat foam sleeve on a stake. Used in pairs as a gate. */
function paddedPost(out, p, colour) {
  out.matte.push(paint(xf(cyl(0.055, 0.075, 2.0, 6), { p: [p.x, p.y + 0.7, p.z] }), 0x4a4f57));
  out.matte.push(paint(xf(cyl(0.26, 0.28, 1.35, 8), { p: [p.x, p.y + 0.62, p.z] }), colour));
  out.matte.push(paint(xf(cyl(0.28, 0.29, 0.17, 8), { p: [p.x, p.y + 0.95, p.z] }), 0xf2f4f8));
  out.matte.push(paint(xf(cyl(0.20, 0.22, 0.10, 8), { p: [p.x, p.y + 1.36, p.z] }), 0x1d2026));
}

/** A run of B-net: steel uprights, top rope, mesh panels. */
function bNet(out, z0, zEnd, side, cell) {
  const STEP = 5.0;
  const H = 2.3;
  let prev = null;
  for (let z = z0; z >= zEnd; z -= STEP) {
    const p = edge(z, side, 7);
    const top = V(p.x, p.y + H, p.z);
    out.metal.push(paint(span(cyl(0.05, 0.07, 1, 5), V(p.x, p.y - 0.35, p.z), top), 0xd4d9e0));
    // guyed back into the hill
    out.metal.push(paint(span(cyl(0.025, 0.025, 1, 4), top,
      V(p.x + side * 1.5, p.y - 0.2, p.z + 0.4)), 0xb0b7c0));
    if (prev) {
      out.metal.push(paint(span(cyl(0.035, 0.035, 1, 4), prev.top, top), 0xe2e7ee));
      const panel = card(1, H);
      atlasUV(panel, cell);
      paint(panel, 0xffffff, 0.30);
      waveByX(panel, (x, y) => clamp((y + H * 0.5) / H, 0, 1) * 0.5);
      const mid = V((prev.p.x + p.x) * 0.5, (prev.p.y + p.y) * 0.5 + H * 0.5 - 0.2,
        (prev.p.z + p.z) * 0.5);
      const len = Math.hypot(p.x - prev.p.x, p.z - prev.p.z);
      xf(panel, { p: [mid.x, mid.y, mid.z], r: [0, Math.PI * 0.5, 0], s: [len, 1, 1] });
      out.fabric.push(panel);
    }
    prev = { p, top };
  }
}

/** A sponsor / signage panel hung between two posts at the edge of the run. */
function banner(out, z, side, cell, w = 7.0, h = 1.7, lift = 0.55) {
  const a = edge(z, side, 5.5);
  const b = edge(z - w, side, 5.5);
  for (const p of [a, b]) {
    out.metal.push(paint(xf(cyl(0.055, 0.075, h + lift + 0.4, 5),
      { p: [p.x, p.y + (h + lift) * 0.5 - 0.2, p.z] }), 0x9aa3ae));
  }
  const panel = card(1, h);
  atlasUV(panel, cell);
  paint(panel, 0xffffff, 0.22);
  waveByX(panel, (x, y) => (0.5 - Math.abs(x)) * 1.3 * clamp(0.5 - y / h, 0, 1) + 0.12);
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  const ang = Math.atan2(b.x - a.x, b.z - a.z);
  xf(panel, {
    p: [(a.x + b.x) * 0.5, (a.y + b.y) * 0.5 + lift + h * 0.5, (a.z + b.z) * 0.5],
    r: [0, ang - Math.PI * 0.5, 0], s: [len, 1, 1],
  });
  out.fabric.push(panel);
}

/** Free-standing signboard on two legs — the distance boards. */
function signBoard(out, z, side, cell, w = 3.4, h = 1.7) {
  const p = edge(z, side, 9);
  for (const s of [-1, 1]) {
    out.metal.push(paint(xf(cyl(0.06, 0.08, h + 1.4, 5),
      { p: [p.x + s * w * 0.34, p.y + (h + 1.4) * 0.5 - 0.3, p.z] }), 0x8f98a3));
  }
  const panel = card(w, h);
  atlasUV(panel, cell);
  paint(panel, 0xffffff, 0);
  xf(panel, { p: [p.x, p.y + 1.55, p.z], r: [0, -side * 0.42, 0] });
  out.fabric.push(panel);
  out.matte.push(paint(xf(box(w + 0.12, 0.10, 0.10), { p: [p.x, p.y + 1.55 + h * 0.5, p.z], r: [0, -side * 0.42, 0] }), 0x2a2f36));
}

/** Crowd hoarding: an A-frame barrier with a sponsor face. */
function hoarding(out, p, ang, cell, w = 2.4) {
  const h = 1.05;
  const g = box(w, h, 0.09);
  atlasUV(g, cell);
  paint(g, 0xffffff);
  xf(g, { p: [p.x, p.y + h * 0.55, p.z], r: [0, ang, 0] });
  out.matte.push(g);
  for (const s of [-1, 1]) {
    const lx = Math.cos(ang) * s * w * 0.45, lz = -Math.sin(ang) * s * w * 0.45;
    out.metal.push(paint(span(cyl(0.03, 0.035, 1, 4),
      V(p.x + lx, p.y + h, p.z + lz), V(p.x + lx - Math.sin(ang) * 0.5, p.y - 0.2, p.z - Math.cos(ang) * 0.5)), 0x9099a3));
  }
}

/** The start gate / finish arch. A real truss span, not a painted rectangle. */
function arch(out, z, cell, seriesCell) {
  const half = halfAt(z);
  const cx = courseXAt(z);
  const span2 = half + 9;
  const L = V(cx - span2, heightAt(cx - span2, z), z);
  const R = V(cx + span2, heightAt(cx + span2, z), z);
  const H = 8.4;
  const topY = Math.max(L.y, R.y) + H;

  for (const p of [L, R]) {
    const t = truss(topY - p.y, 0.62, 0.085, 7);
    xf(t, { p: [p.x, p.y - 0.4, p.z] });
    out.metal.push(paint(t, 0xc8ced6));
    // concrete-block foot
    out.matte.push(paint(xf(box(2.0, 0.7, 1.6), { p: [p.x, p.y - 0.25, p.z] }), 0x6e7480));
  }

  // top chord: two parallel tubes with a zigzag web
  const a = V(L.x, topY, z), b = V(R.x, topY, z);
  for (const dz of [-0.55, 0.55]) {
    out.metal.push(paint(span(cyl(0.10, 0.10, 1, 6),
      V(a.x, topY, z + dz), V(b.x, topY, z + dz)), 0xc8ced6));
    out.metal.push(paint(span(cyl(0.09, 0.09, 1, 6),
      V(a.x, topY - 1.5, z + dz), V(b.x, topY - 1.5, z + dz)), 0xc8ced6));
  }
  const bays = Math.max(6, Math.round((b.x - a.x) / 3.2));
  for (let i = 0; i < bays; i++) {
    const x0 = a.x + (b.x - a.x) * (i / bays);
    const x1 = a.x + (b.x - a.x) * ((i + 1) / bays);
    out.metal.push(paint(span(cyl(0.045, 0.045, 1, 4),
      V(x0, topY, z + 0.55), V(x1, topY - 1.5, z - 0.55)), 0xb4bbc4));
    out.metal.push(paint(span(cyl(0.045, 0.045, 1, 4),
      V(x0, topY - 1.5, z + 0.55), V(x1, topY, z - 0.55)), 0xb4bbc4));
  }

  // the big banner slung under the truss
  const bw = (b.x - a.x) * 0.86, bh = 2.6;
  const g = card(bw, bh);
  atlasUV(g, cell);
  paint(g, 0xffffff, 0.30);
  waveByX(g, (x, y) => clamp(0.5 - y / bh, 0, 1) * 0.8);
  xf(g, { p: [(a.x + b.x) * 0.5, topY - 3.0, z], r: [0, 0, 0] });
  out.fabric.push(g);

  const g2 = card(bw * 0.5, 1.2);
  atlasUV(g2, seriesCell);
  paint(g2, 0xffffff, 0.18);
  xf(g2, { p: [(a.x + b.x) * 0.5, topY + 1.15, z], r: [0, 0, 0] });
  out.fabric.push(g2);
}

// --------------------------------------------------------------------------
// the emitter
// --------------------------------------------------------------------------
const FEATURES = courseFeatures();

export function emitCourse(sink, z0, z1, bucket) {
  const out = { matte: [], metal: [], fabric: [] };
  const rng = mulberry32(0x5EA51 ^ (bucket * 0x9e3779b1));

  // ---- edge marker poles, every 20 m, both sides --------------------------
  const STEP = 20;
  const start = Math.ceil(-z1 / STEP) * STEP;
  for (let s = start; -s > z0; s += STEP) {
    const z = -s;
    if (z > 0 || z < -COURSE_LENGTH) continue;
    const alt = (s / STEP) % 2 === 0;
    for (const side of [-1, 1]) {
      const p = edge(z, side, 3.2);
      markerPole(out, p, alt ? 0xe8500f : 0x1f5ad8,
        (s / STEP) % 4 === 0 ? (alt ? CELL.pennantRed : CELL.pennantBlue) : -1, rng);
    }
  }

  // ---- netting on the outside of the fast corners -------------------------
  for (let s = start; -s > z0; s += 40) {
    const z = -s;
    if (z > -60 || z < -COURSE_LENGTH + 60) continue;
    const k = curvature(z);
    if (Math.abs(k) < 3.2e-4) continue;
    const side = k > 0 ? -1 : 1;
    bNet(out, z, Math.max(z - 40, z0), side, k > 0 ? CELL.netOrange : CELL.netBlue);
  }

  // ---- padded gates + hoardings at every authored feature -----------------
  for (const f of FEATURES) {
    if (f.z < z0 || f.z >= z1) continue;
    const cx = courseXAt(f.z);
    for (const side of [-1, 1]) {
      const x = cx + f.off + side * (f.w * 0.92 + 1.5);
      paddedPost(out, V(x, heightAt(x, f.z), f.z), side < 0 ? 0xd11a2a : 0x1350c8);
      const x2 = cx + f.off + side * (f.w * 0.92 + 1.5);
      const z2 = f.z - (f.gap || 0) - f.len * 1.2;
      paddedPost(out, V(x2, heightAt(x2, z2), z2), side < 0 ? 0xd11a2a : 0x1350c8);
    }
    // a short row of crowd hoardings on the landing side of the big hits
    if (f.h >= 9) {
      const side = f.off > 0 ? -1 : 1;
      for (let i = 0; i < 5; i++) {
        const z = f.z - 14 - i * 2.6;
        const p = edge(z, side, 6.5 + (i % 2) * 0.3);
        hoarding(out, p, Math.PI * 0.5, CELL.brand0 + ((i + bucket) % BRANDS.length));
      }
    }
  }

  // ---- sponsor banners, roughly every 130 m -------------------------------
  for (let s = start; -s > z0; s += 130) {
    const z = -s - 40;
    if (z > -70 || z < -COURSE_LENGTH + 90) continue;
    const side = rng() < 0.5 ? -1 : 1;
    banner(out, z, side, CELL.brand0 + ((s / 130 + bucket) | 0) % BRANDS.length);
  }

  // ---- distance boards ----------------------------------------------------
  for (let n = 1; n <= 6; n++) {
    const z = -(COURSE_LENGTH - n * 1000);
    if (z < z0 || z >= z1) continue;
    signBoard(out, z, n % 2 ? 1 : -1, CELL.km6 + (6 - n));
  }

  // ---- piste identity boards ----------------------------------------------
  for (let s = start; -s > z0; s += 520) {
    const z = -s - 210;
    if (z > -140 || z < -COURSE_LENGTH + 140) continue;
    signBoard(out, z, rng() < 0.5 ? -1 : 1, CELL.pisteMarker, 2.2, 1.5);
  }

  // ---- start gate and finish arch -----------------------------------------
  if (-8 >= z0 && -8 < z1) {
    arch(out, -8, CELL.start, CELL.seriesBanner);
    for (let i = 0; i < 10; i++) {
      const side = i < 5 ? -1 : 1;
      const p = edge(-16 - (i % 5) * 2.6, side, 6.0);
      hoarding(out, p, Math.PI * 0.5, CELL.brand0 + (i % BRANDS.length));
    }
  }
  const fz = -COURSE_LENGTH + 60;
  if (fz >= z0 && fz < z1) {
    arch(out, fz, CELL.finish, CELL.seriesBanner);
    for (let i = 0; i < 12; i++) {
      const side = i < 6 ? -1 : 1;
      const p = edge(fz + 24 - (i % 6) * 2.6, side, 6.0);
      hoarding(out, p, Math.PI * 0.5, CELL.brand0 + ((i + 3) % BRANDS.length));
    }
  }

  sink.add('matte', mergeAll(out.matte));
  sink.add('metal', mergeAll(out.metal));
  sink.add('fabric', mergeAll(out.fabric));
}
