/**
 * OWNER: agent "props".
 *
 * Rails, boxes and handrails — and the query the trick system grinds on.
 *
 * `src/tricks/rails.js` is already finished and is looking for exactly this:
 *
 *     props.nearestRail(pos, maxDist) -> null | { point, tangent, dist, id, t, length, kind }
 *
 * so that is what is exported. The metadata for every rail on the mountain is
 * built once, up front — it is only a few hundred vectors — because the grind
 * query has to work whether or not that stretch of course has been streamed in
 * yet. Only the *geometry* is lazy, emitted into the shared Dressing buckets.
 *
 * Rails are hung off the authored features from `courseFeatures()`: a box on
 * the deck of a table, a down-rail off the landing of a kicker, a handrail on
 * the flat between features. Every rail is checked against the height field
 * along its length and lifted until it clears the snow, so none of them ever
 * end up buried in a roller.
 */

import * as THREE from 'three';
import { mulberry32 } from '../core/noise.js';
import {
  heightAt, courseXAt, courseAt, progressAt, courseFeatures, COURSE_LENGTH,
} from './terrain.js';
import { cyl, tubeAlong, xf, paint, span, slab, mergeAll, clamp } from './propCommon.js';

const RAIL_R = 0.075;
const BOX_W = 1.5;

/** Straight-line rail, sampled against the snow so it always clears it. */
function makeRail(id, kind, zTop, len, off, height, rng) {
  const n = 9;
  const raw = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const z = zTop - len * t;
    const x = courseXAt(z) + off;
    raw.push([x, heightAt(x, z), z]);
  }
  // Fit a straight chord through the ends, then lift it until every sample
  // underneath clears by `height`.
  const a = raw[0], b = raw[n - 1];
  let lift = 0;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const chord = a[1] + (b[1] - a[1]) * t;
    lift = Math.max(lift, raw[i][1] + height - chord);
  }

  const points = [];
  const kink = kind === 'handrail' ? 1 : 0;
  const segs = kink ? 3 : 1;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const z = zTop - len * t;
    const x = courseXAt(z) + off;
    let y = a[1] + (b[1] - a[1]) * t + lift;
    // A handrail kinks: flat entry, steep middle, flat runout.
    if (kink) y += Math.sin(t * Math.PI) * (0.9 + rng() * 0.8);
    points.push(new THREE.Vector3(x, y, z));
  }

  let length = 0;
  for (let i = 0; i + 1 < points.length; i++) length += points[i].distanceTo(points[i + 1]);

  return { id, kind, points, length, z: zTop, height };
}

// --------------------------------------------------------------------------
// geometry
// --------------------------------------------------------------------------
function railGeometry(rail, sink) {
  const { kind, points } = rail;
  const metal = [];
  const matte = [];

  if (kind === 'box') {
    // A snow-dusted slider box: timber deck, steel coping down each edge.
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i], b = points[i + 1];
      matte.push(paint(slab(a, b, BOX_W, 0.30), 0x9aa3b0));
      for (const s of [-1, 1]) {
        const ca = a.clone(); ca.x += s * BOX_W * 0.5;
        const cb = b.clone(); cb.x += s * BOX_W * 0.5;
        metal.push(paint(span(cyl(0.045, 0.045, 1, 5), ca, cb), 0xb9c2cc));
      }
    }
  } else {
    const tube = tubeAlong(points, kind === 'handrail' ? RAIL_R * 1.15 : RAIL_R, 6);
    metal.push(paint(tube, 0xc2ccd6));
  }

  // supports
  const total = rail.length;
  const nPosts = Math.max(2, Math.round(total / 4.2));
  const postR = kind === 'box' ? 0.075 : 0.055;
  for (let i = 0; i <= nPosts; i++) {
    const t = i / nPosts;
    const p = pointOn(points, t);
    const g = heightAt(p.x, p.z) - 0.25;
    if (p.y - g < 0.2) continue;
    const foot = new THREE.Vector3(p.x, g, p.z);
    const head = new THREE.Vector3(p.x, p.y - (kind === 'box' ? 0.15 : 0.02), p.z);
    metal.push(paint(span(cyl(postR * 0.85, postR, 1, 5), foot, head), 0x8d97a3));
    // small foot plate so the post does not just vanish into the snow
    metal.push(paint(xf(cyl(0.20, 0.24, 0.10, 6), { p: [p.x, g + 0.06, p.z] }), 0x7f8994));
  }

  sink.add('metal', mergeAll(metal));
  sink.add('matte', mergeAll(matte));
}

function pointOn(points, t) {
  const segs = points.length - 1;
  const f = clamp(t, 0, 1) * segs;
  const i = Math.min(segs - 1, Math.floor(f));
  const u = f - i;
  return new THREE.Vector3().lerpVectors(points[i], points[i + 1], u);
}

// --------------------------------------------------------------------------
export function createRails() {
  const rng = mulberry32(0x4A115);
  return buildRails(rng);
}

function buildRails(rng) {
  const list = [];
  const features = courseFeatures();
  let id = 0;

  for (const f of features) {
    const { width } = courseAt(progressAt(f.z));
    const half = width * 0.5;
    if (f.type === 'table') {
      // A box straight down the deck, offset to one side of the landing zone.
      const side = rng() < 0.5 ? -1 : 1;
      list.push(makeRail(id++, 'box', f.z + 2, f.gap + f.len * 0.9,
        f.off + side * (f.w * 0.42), 0.45, rng));
    } else if (f.type === 'kicker') {
      // Down-rail off the landing, parallel to the fall line.
      const side = rng() < 0.5 ? -1 : 1;
      list.push(makeRail(id++, 'rail', f.z - 12, 20 + rng() * 12,
        f.off + side * (half * 0.42 + 4), 0.75 + rng() * 0.35, rng));
    } else if (f.type === 'roller') {
      const side = rng() < 0.5 ? -1 : 1;
      list.push(makeRail(id++, rng() < 0.45 ? 'box' : 'rail', f.z - f.len * 0.8,
        16 + rng() * 14, f.off + side * (half * 0.5 + 3), 0.6 + rng() * 0.4, rng));
    } else if (f.type === 'quarter') {
      // Flat-bar along the base of the wall, on the opposite side of the run.
      list.push(makeRail(id++, 'rail', f.z + f.len * 0.5, 26 + rng() * 10,
        -f.side * (half * 0.45), 0.55 + rng() * 0.3, rng));
    }
  }

  // Standalone handrails and long flat rails on the mellow sections between
  // features, so the run always has something to hit.
  for (let z = -180; z > -COURSE_LENGTH + 160; z -= 190 + rng() * 130) {
    let clash = false;
    for (const f of features) if (Math.abs(z - f.z) < 90) { clash = true; break; }
    if (clash) continue;
    const { width } = courseAt(progressAt(z));
    const half = width * 0.5;
    const side = rng() < 0.5 ? -1 : 1;
    const kind = rng() < 0.35 ? 'handrail' : rng() < 0.5 ? 'box' : 'rail';
    list.push(makeRail(id++, kind, z, 18 + rng() * 20,
      side * (half * (0.30 + rng() * 0.36)), 0.6 + rng() * 0.5, rng));
  }

  // Spatial index: rails are short, so one 200 m bucket each is plenty.
  const BUCKET = 200;
  const index = new Map();
  for (const r of list) {
    const b0 = Math.floor(-(r.z) / BUCKET);
    const b1 = Math.floor(-(r.z - r.length) / BUCKET);
    for (let b = b0; b <= b1; b++) {
      if (!index.has(b)) index.set(b, []);
      index.get(b).push(r);
    }
  }

  // ---- grind query --------------------------------------------------------
  const _ab = new THREE.Vector3();
  const _ap = new THREE.Vector3();
  const _cl = new THREE.Vector3();
  const hit = {
    point: new THREE.Vector3(), tangent: new THREE.Vector3(),
    dist: 0, id: -1, t: 0, length: 0, kind: 'rail',
  };

  function nearestRail(pos, maxDist = 2.0) {
    const b = Math.floor(-pos.z / BUCKET);
    let best = null, bestD2 = maxDist * maxDist, bestT = 0, bestSeg = 0;
    for (let k = b - 1; k <= b + 1; k++) {
      const bucket = index.get(k);
      if (!bucket) continue;
      for (const r of bucket) {
        const pts = r.points;
        for (let i = 0; i + 1 < pts.length; i++) {
          const a = pts[i], c = pts[i + 1];
          _ab.copy(c).sub(a);
          _ap.copy(pos).sub(a);
          const len2 = _ab.lengthSq();
          const t = len2 > 1e-9 ? clamp(_ap.dot(_ab) / len2, 0, 1) : 0;
          _cl.copy(a).addScaledVector(_ab, t);
          const d2 = _cl.distanceToSquared(pos);
          if (d2 < bestD2) {
            bestD2 = d2; best = r; bestT = t; bestSeg = i;
            hit.point.copy(_cl);
          }
        }
      }
    }
    if (!best) return null;
    const pts = best.points;
    hit.tangent.copy(pts[bestSeg + 1]).sub(pts[bestSeg]).normalize();
    hit.dist = Math.sqrt(bestD2);
    hit.id = best.id;
    hit.t = (bestSeg + bestT) / (pts.length - 1);
    hit.length = best.length;
    hit.kind = best.kind;
    return hit;
  }

  /** Dressing emitter: build every rail whose head sits in this z bucket. */
  function emit(sink, z0, z1) {
    for (const r of list) {
      if (r.z < z0 || r.z >= z1) continue;
      railGeometry(r, sink);
    }
  }

  return { list, nearestRail, emit };
}
