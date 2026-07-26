/**
 * OWNER: agent "props".
 *
 * Shared plumbing for every piece of environment dressing:
 *   - tiny procedural geometry kit (tubes, boxes, tapered posts, cards)
 *   - vertex-colour + cloth-wave attribute convention so wildly different
 *     objects can share three materials and therefore three draw calls
 *   - `Dressing`, the lazy z-bucketed merge/stream system that every static
 *     prop (rails, gates, banners, lodge, lift) is emitted into.
 *
 * Nothing in here touches the height field maths — terrain.js is the only
 * source of truth for that.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { heightAt } from './terrain.js';

// --------------------------------------------------------------------------
// attribute convention
// --------------------------------------------------------------------------
// Every geometry that goes into a merged bucket carries exactly:
//   position, normal, uv, color (vec3), aWave (float)
// `aWave` is the cloth mask: 0 = rigid, 1 = free-flying corner of a banner.

const _c = new THREE.Color();

/** Stamp a flat colour + cloth mask onto a geometry. Returns the geometry. */
export function paint(geo, color, wave = 0) {
  const n = geo.attributes.position.count;
  if (!geo.attributes.uv) {
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  _c.set(color);
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const w = new Float32Array(n);
  if (wave) w.fill(wave);
  geo.setAttribute('aWave', new THREE.BufferAttribute(w, 1));
  return geo;
}

/** Per-vertex cloth mask from a callback on the local position. */
export function waveByX(geo, fn) {
  const p = geo.attributes.position;
  const w = geo.attributes.aWave;
  for (let i = 0; i < p.count; i++) w.setX(i, fn(p.getX(i), p.getY(i), p.getZ(i)));
  return geo;
}

/** Assign a cell of the 4x6 sponsor atlas to a geometry's uvs. */
export const ATLAS_COLS = 4, ATLAS_ROWS = 6;
export function atlasUV(geo, cell, flipV = false) {
  const cx = cell % ATLAS_COLS, cy = Math.floor(cell / ATLAS_COLS);
  const uv = geo.attributes.uv;
  const u0 = cx / ATLAS_COLS, v0 = 1 - (cy + 1) / ATLAS_ROWS;
  const IN = 0.012; // inset so mip bleed never drags in the neighbouring cell
  for (let i = 0; i < uv.count; i++) {
    const u = IN + uv.getX(i) * (1 - 2 * IN);
    const v0v = IN + (flipV ? 1 - uv.getY(i) : uv.getY(i)) * (1 - 2 * IN);
    uv.setXY(i, u0 + u / ATLAS_COLS, v0 + v0v / ATLAS_ROWS);
  }
  return geo;
}

// --------------------------------------------------------------------------
// transforms
// --------------------------------------------------------------------------
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();

export function xf(geo, { p, r, s, q } = {}) {
  _v.set(p ? p[0] : 0, p ? p[1] : 0, p ? p[2] : 0);
  if (q) _q.copy(q);
  else { _e.set(r ? r[0] : 0, r ? r[1] : 0, r ? r[2] : 0); _q.setFromEuler(_e); }
  if (typeof s === 'number') _s.set(s, s, s); else _s.set(s ? s[0] : 1, s ? s[1] : 1, s ? s[2] : 1);
  _m.compose(_v, _q, _s);
  geo.applyMatrix4(_m);
  return geo;
}

/** Orient +Y of `geo` along a->b and stretch it to that length. */
const _up = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();
export function span(geo, a, b) {
  _dir.copy(b).sub(a);
  const len = _dir.length() || 1e-6;
  _dir.divideScalar(len);
  _q.setFromUnitVectors(_up, _dir);
  _v.copy(a).addScaledVector(_dir, len * 0.5);
  _s.set(1, len, 1);
  _m.compose(_v, _q, _s);
  geo.applyMatrix4(_m);
  return geo;
}

// --------------------------------------------------------------------------
// geometry kit — all unit-ish, centred, meant to be xf'd into place
// --------------------------------------------------------------------------

/** Vertical cylinder of unit height centred on the origin. */
export function cyl(rTop, rBot, h = 1, seg = 8, open = false) {
  return new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, open);
}

export function box(w, h, d) { return new THREE.BoxGeometry(w, h, d); }

export function card(w, h) { return new THREE.PlaneGeometry(w, h, 1, 1); }

/** Round tube following a polyline. Points are world-space THREE.Vector3. */
export function tubeAlong(points, radius, radial = 6, closedCaps = false) {
  const curve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.0);
  const segs = Math.max(2, (points.length - 1) * 3);
  return new THREE.TubeGeometry(curve, segs, radius, radial, false);
}

/** A stretched-box beam from a to b with a given cross-section. */
export function beam(a, b, w, h) {
  const g = new THREE.BoxGeometry(w, 1, h);
  return span(g, a, b);
}

/** Simple lattice-ish truss column: 4 legs + rungs. Unit height, base at y=0. */
export function truss(h, halfW, legR = 0.09, rungs = 6) {
  const parts = [];
  const legs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (const [sx, sz] of legs) {
    const a = new THREE.Vector3(sx * halfW, 0, sz * halfW);
    const b = new THREE.Vector3(sx * halfW * 0.45, h, sz * halfW * 0.45);
    parts.push(span(cyl(legR * 0.6, legR, 1, 5), a, b));
  }
  for (let i = 1; i <= rungs; i++) {
    const t = i / (rungs + 1);
    const y = t * h;
    const w = halfW * (1 - 0.55 * t);
    const ring = [[-1, -1, 1, -1], [1, -1, 1, 1], [1, 1, -1, 1], [-1, 1, -1, -1]];
    for (const [ax, az, bx, bz] of ring) {
      parts.push(span(cyl(legR * 0.4, legR * 0.4, 1, 4),
        new THREE.Vector3(ax * w, y, az * w), new THREE.Vector3(bx * w, y, bz * w)));
    }
    // one diagonal per bay reads as lattice without doubling the cost
    parts.push(span(cyl(legR * 0.3, legR * 0.3, 1, 4),
      new THREE.Vector3(-w, y, -w), new THREE.Vector3(w, y + h / (rungs + 1), w)));
  }
  return mergeGeometries(parts);
}

export function mergeAll(list) {
  const clean = list.filter(Boolean);
  if (!clean.length) return null;
  if (clean.length === 1) return clean[0];
  return mergeGeometries(clean);
}

// --------------------------------------------------------------------------
// terrain helpers
// --------------------------------------------------------------------------

/** Ground height with a small settle so posts bite into the snow. */
export function groundY(x, z, sink = 0.25) { return heightAt(x, z) - sink; }

/** Average ground over a footprint — stops big flat objects from floating. */
export function padY(x, z, r) {
  let s = 0;
  s += heightAt(x - r, z - r); s += heightAt(x + r, z - r);
  s += heightAt(x - r, z + r); s += heightAt(x + r, z + r);
  s += heightAt(x, z);
  return s / 5;
}

// --------------------------------------------------------------------------
// Dressing: lazy, z-bucketed, merged static props
// --------------------------------------------------------------------------
/**
 * The whole 6.4 km of course furniture is far too much to submit every frame,
 * but it is also completely static — so it is generated on demand per 320 m
 * bucket, merged down to one mesh per material, and shown or hidden purely by
 * distance. Typical steady state is 4 buckets x 3 materials = 12 draw calls.
 */
export class Dressing {
  constructor(scene, materials, { bucketSize = 320, range = 1250, castRange = 260 } = {}) {
    this.group = new THREE.Group();
    this.group.name = 'dressing';
    scene.add(this.group);
    this.materials = materials;           // { matte, metal, fabric }
    this.bucketSize = bucketSize;
    this.range = range;
    this.castRange = castRange;
    this.emitters = [];
    this.buckets = new Map();             // index -> { meshes[], built }
    this._pending = [];
  }

  addEmitter(fn) { this.emitters.push(fn); }

  _build(i) {
    const z1 = -i * this.bucketSize;
    const z0 = z1 - this.bucketSize;      // [z0, z1) with z going negative
    const sink = { lists: { matte: [], metal: [], fabric: [] } };
    sink.add = (key, geo) => { if (geo) sink.lists[key].push(geo); };
    for (const fn of this.emitters) {
      try { fn(sink, z0, z1, i); } catch (e) { console.warn('[props] emitter failed', e); }
    }
    const entry = { meshes: [], z: (z0 + z1) * 0.5 };
    for (const key of ['matte', 'metal', 'fabric']) {
      const geo = mergeAll(sink.lists[key]);
      if (!geo) continue;
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, this.materials[key]);
      mesh.name = `dress-${key}-${i}`;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      mesh.visible = false;
      this.group.add(mesh);
      entry.meshes.push(mesh);
    }
    this.buckets.set(i, entry);
    return entry;
  }

  update(camZ, budget = 1) {
    const lo = Math.max(0, Math.floor((-camZ - this.range) / this.bucketSize));
    const hi = Math.floor((-camZ + this.range) / this.bucketSize);
    let built = 0;
    for (let i = lo; i <= hi; i++) {
      let b = this.buckets.get(i);
      if (!b) {
        if (built >= budget) continue;
        b = this._build(i);
        built++;
      }
      const d = Math.abs(b.z - camZ);
      const vis = d < this.range;
      const cast = d < this.castRange;
      for (const m of b.meshes) { m.visible = vis; if (m.castShadow !== cast) m.castShadow = cast; }
    }
    for (const [i, b] of this.buckets) {
      if (i < lo - 1 || i > hi + 1) for (const m of b.meshes) m.visible = false;
    }
  }
}

// --------------------------------------------------------------------------
// misc
// --------------------------------------------------------------------------
export function lerp(a, b, t) { return a + (b - a) * t; }
export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
export function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
/** Pick from a list with a seeded rng. */
export function pick(rng, arr) { return arr[Math.min(arr.length - 1, (rng() * arr.length) | 0)]; }
