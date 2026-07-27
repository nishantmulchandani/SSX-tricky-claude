/**
 * OWNER: agent "props".
 *
 * The conifer forest — the single biggest thing standing between "a white
 * height field" and "a mountain".
 *
 * Three LOD tiers, one InstancedMesh each, so the whole forest is three draw
 * calls no matter how many trees are on screen:
 *
 *   near   real geometry: tapered trunk, nine whorls of drooping needle cards,
 *          a snow-loaded card riding just above each of them.
 *   cross  two quads at 90 degrees carrying a whole-tree silhouette.
 *   far    one quad spun about Y to face the camera.
 *
 * Tiers hand over by dithered dissolve in the shader (see propShaders.js), so
 * the CPU side here only has to make sure a tree is present in *both* buffers
 * across the handover band — the bucket ranges below deliberately overlap.
 *
 * Placement is streamed in 120 m chunks by ScatterField and is a pure function
 * of world position: slope, altitude relative to the tree line, distance from
 * the piste, and a low-frequency clearing noise. The piste itself is kept
 * scrupulously clear — nothing is ever placed inside 1.45 half-widths of the
 * course centre, which is outside the banks the terrain builds for itself.
 */

import * as THREE from 'three';
import { fbm2, mulberry32 } from '../core/noise.js';
import {
  heightAt, slopeAt, courseXAt, courseAt, progressAt, featureAt, COURSE_LENGTH,
} from './terrain.js';
import { ScatterField, smoothstep } from './propCommon.js';
import { makeTreeNear, makeTreeCross, makeTreeFar } from '../shaders/propShaders.js';

// --------------------------------------------------------------------------
// tuning
// --------------------------------------------------------------------------
const TREELINE = 1985;          // metres: half density here
const TREELINE_BAND = 210;      // +/- metres over which the forest gives out
const STREAM_RADIUS = 900;

const NEAR_END = 152;
const CROSS_START = 98, CROSS_END = 404;
const FAR_START = 290, FAR_END = 900;

const NEAR_MAX = 900, CROSS_MAX = 4200, FAR_MAX = 15000;

// item layout in the ScatterField float stream
const S_X = 0, S_Y = 1, S_Z = 2, S_H = 3, S_W = 4, S_YAW = 5, S_LEAN = 6,
  S_CELL = 7, S_SHADE = 8;
const STRIDE = 9;

// atlas regions of barkNeedleAtlas()
const BARK = [0.005, 0.005, 0.495, 0.995];
const NEEDLE = [0.505, 0.505, 0.998, 0.998];
const SNOW = [0.505, 0.002, 0.998, 0.495];

// --------------------------------------------------------------------------
// near-LOD geometry
// --------------------------------------------------------------------------
/**
 * A quad card lying along +X, drooping at the tip, tapering in Z.
 * Written straight into the flat arrays so building a whole tree never
 * allocates an intermediate BufferGeometry.
 */
function pushCard(A, len, halfW, rise, droop, yaw, y, uv, cr, cg, cb) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const [u0, v0, u1, v1] = uv;
  const inner = halfW * 0.62, outer = halfW * 0.20;
  const local = [
    [0, rise, -inner, u0, v0],
    [0, rise, inner, u0, v1],
    [len, -droop, outer, u1, v1],
    [len, -droop, -outer, u1, v0],
  ];
  const base = A.p.length / 3;
  // Face normal, then leant heavily towards straight up: a conifer canopy is
  // read as one big soft upward-facing mass, and that is also what puts the
  // shader snow term where the eye expects it.
  let nx = droop + rise, ny = len, nz = 0;
  const nl = Math.hypot(nx, ny, nz) || 1;
  nx /= nl; ny /= nl; nz /= nl;
  ny = ny * 0.35 + 0.65;
  nx *= 0.35;
  const nl2 = Math.hypot(nx, ny, nz) || 1;
  const wnx = (nx * c - nz * s) / nl2, wny = ny / nl2, wnz = (nx * s + nz * c) / nl2;

  for (const [lx, ly, lz, u, v] of local) {
    A.p.push(lx * c - lz * s, ly + y, lx * s + lz * c);
    A.n.push(wnx, wny, wnz);
    A.u.push(u, v);
    A.c.push(cr, cg, cb);
  }
  A.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function pushTrunk(A, rBot, rTop, h, seg) {
  const base = A.p.length / 3;
  const [u0, v0, u1, v1] = BARK;
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const cx = Math.cos(a), cz = Math.sin(a);
    // Bark wraps twice round the trunk, which halves the visible tiling period
    // without needing a wider atlas cell. The seam closes because i = seg
    // lands back on u0 exactly.
    const uu = u0 + (u1 - u0) * (((i / seg) * 2) % 1);
    A.p.push(cx * rBot, 0, cz * rBot); A.n.push(cx, 0.12, cz); A.u.push(uu, v0); A.c.push(0.62, 0.58, 0.54);
    A.p.push(cx * rTop, h, cz * rTop); A.n.push(cx, 0.12, cz); A.u.push(uu, v1); A.c.push(0.86, 0.83, 0.80);
  }
  for (let i = 0; i < seg; i++) {
    const a = base + i * 2, b = a + 1, c = a + 2, d = a + 3;
    A.i.push(a, c, b, b, c, d);
  }
}

/** One unit-height spruce, base at y = 0, crown roughly 0.34 wide. */
function buildConifer(seed) {
  const rng = mulberry32(seed);
  const A = { p: [], n: [], u: [], c: [], i: [] };

  const crownBase = 0.10 + rng() * 0.07;
  pushTrunk(A, 0.026, 0.006, 1.0, 6);

  const NW = 9;
  const maxHalf = 0.165 + rng() * 0.03;
  for (let w = 0; w < NW; w++) {
    const t = w / (NW - 1);                       // 0 = lowest whorl
    const y = crownBase + (0.985 - crownBase) * t;
    const shrink = Math.pow(1 - t, 0.60);
    const half = maxHalf * shrink * (0.86 + rng() * 0.28);
    if (half < 0.012) continue;
    const cards = t > 0.66 ? 4 : t > 0.33 ? 5 : 6;
    const spin = rng() * Math.PI * 2;
    const droop = (0.030 + 0.030 * (1 - t)) * (0.7 + rng() * 0.6);
    const rise = 0.012 * (0.6 + rng() * 0.8);
    // Ambient occlusion down the crown: the inside of a spruce is very dark.
    const ao = 0.34 + 0.66 * Math.pow(t, 0.75);
    for (let k = 0; k < cards; k++) {
      const yaw = spin + (k / cards) * Math.PI * 2 + (rng() - 0.5) * 0.28;
      const l = half * (0.82 + rng() * 0.36);
      const g = 0.82 + rng() * 0.30;
      pushCard(A, l, l * 0.62, rise, droop, yaw, y + (rng() - 0.5) * 0.012,
        NEEDLE, ao * g * 0.95, ao * g, ao * g * 0.88);
      // snow load: a slightly shorter card riding just above the needles
      if (rng() < 0.78) {
        pushCard(A, l * 0.90, l * 0.56, rise + 0.010, droop * 0.80, yaw + (rng() - 0.5) * 0.10,
          y + (rng() - 0.5) * 0.012 + 0.010, SNOW,
          0.80 + ao * 0.24, 0.84 + ao * 0.22, 0.90 + ao * 0.18);
      }
    }
  }

  // leader
  pushCard(A, 0.055, 0.030, 0.0, -0.045, rng() * 6.28, 0.965, NEEDLE, 0.9, 0.95, 0.85);
  pushCard(A, 0.050, 0.026, 0.008, -0.045, rng() * 6.28, 0.978, SNOW, 1.0, 1.02, 1.06);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(A.p, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(A.n, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(A.u, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(A.c, 3));
  geo.setIndex(A.i);
  geo.computeBoundingSphere();
  return geo;
}

/** Two quads at 90 degrees, unit height, unit width, base at y = 0. */
function buildCrossBillboard() {
  const p = [], n = [], u = [], c = [], i = [];
  for (let q = 0; q < 2; q++) {
    const a = q * Math.PI * 0.5;
    const ex = Math.cos(a) * 0.5, ez = Math.sin(a) * 0.5;
    const base = p.length / 3;
    p.push(-ex, 0, -ez, ex, 0, ez, ex, 1, ez, -ex, 1, -ez);
    for (let k = 0; k < 4; k++) { n.push(0, 0.75, 0); c.push(1, 1, 1); }
    // The silhouette is drawn with its own top at the top of the cell.
    u.push(0, 0, 1, 0, 1, 1, 0, 1);
    i.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  // Fake a bit of volume: bias the normals of each plane outwards so the two
  // planes do not shade identically and the pair reads as a solid crown.
  for (let k = 0; k < 4; k++) { n[k * 3] = -0.45; n[k * 3 + 2] = 0.0; }
  for (let k = 4; k < 8; k++) { n[k * 3] = 0.0; n[k * 3 + 2] = -0.45; }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(u, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
  geo.setIndex(i);
  geo.computeBoundingSphere();
  return geo;
}

/** One quad in XY, unit height, unit width, base at y = 0. */
function buildFarBillboard() {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(
    [-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0], 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(
    [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.computeBoundingSphere();
  return geo;
}

// --------------------------------------------------------------------------
// placement
// --------------------------------------------------------------------------
/**
 * Density at a point, 0..1. Cheap tests first: the expensive part of this
 * function is heightAt/slopeAt, and the great majority of candidates are
 * rejected before either of them is reached.
 */
function emitTree(x, z, rng, out) {
  const r0 = rng(), r1 = rng(), r2 = rng(), r3 = rng(), r4 = rng();

  if (z > 90 || z < -COURSE_LENGTH - 620) return;

  const cx = courseXAt(z);
  const { width } = courseAt(progressAt(z));
  const half = width * 0.5;
  const d = Math.abs(x - cx);
  // Keep the piste and its banks completely clear.
  const clear = half * 1.45 + 10;
  if (d < clear) return;

  // A low-frequency clearing field: avalanche paths, gullies, old cuts.
  const clearing = fbm2(x * 0.00185, z * 0.00185, 3) * 0.5 + 0.5;
  let dens = smoothstep(0.30, 0.56, clearing);
  // Trees crowd the edge of the run but thin out right against it.
  dens *= smoothstep(0, 26, d - clear);
  if (dens < 0.02 || r0 > dens) return;

  const y = heightAt(x, z);
  const alt = 1 - smoothstep(TREELINE - TREELINE_BAND, TREELINE + TREELINE_BAND, y);
  if (alt <= 0.03 || r1 > alt) return;

  const slope = slopeAt(x, z);
  if (slope > 0.76) return;                       // 43 deg: bare rock, no soil
  if (r2 > 1 - smoothstep(0.50, 0.76, slope)) return;

  // Never inside an authored feature's footprint.
  if (Math.abs(featureAt(x, z)) > 2.0) return;

  // Height: tall and full in the valley, stunted and scrubby at the tree line.
  const vigour = 0.42 + 0.58 * alt;
  const h = (7.5 + r3 * 15.5) * vigour;
  const wRatio = (0.80 + r4 * 0.42) * (1.18 - 0.28 * vigour);
  const yaw = rng() * Math.PI * 2;
  const lean = (rng() - 0.5) * 0.13 * (1.6 - alt);
  const cell = Math.min(3, (rng() * 4) | 0);
  const shade = rng();

  out.push(x, y - 0.28, z, h, wRatio, yaw, lean, cell, shade);
}

// --------------------------------------------------------------------------
// the forest
// --------------------------------------------------------------------------
export function createForest(scene) {
  const group = new THREE.Group();
  group.name = 'forest';
  scene.add(group);

  const field = new ScatterField({
    chunk: 120, cell: 7.5, seed: 0x7A1E5, stride: STRIDE, emit: emitTree,
  });

  const tiers = [
    { geo: buildConifer(0x1234), mat: makeTreeNear(), max: NEAR_MAX, shadow: true, name: 'tree-near' },
    { geo: buildCrossBillboard(), mat: makeTreeCross(), max: CROSS_MAX, shadow: false, name: 'tree-cross' },
    { geo: buildFarBillboard(), mat: makeTreeFar(), max: FAR_MAX, shadow: false, name: 'tree-far' },
  ];

  for (const t of tiers) {
    const mesh = new THREE.InstancedMesh(t.geo, t.mat, t.max);
    mesh.name = t.name;
    mesh.count = 0;
    mesh.frustumCulled = false;          // culled on the CPU during the refill
    mesh.castShadow = t.shadow;
    mesh.receiveShadow = t.max !== FAR_MAX;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const attr = new THREE.InstancedBufferAttribute(new Float32Array(t.max * 4), 4);
    attr.setUsage(THREE.DynamicDrawUsage);
    t.geo.setAttribute('aTree', attr);
    t.attr = attr;
    t.mesh = mesh;
    group.add(mesh);
  }

  // Shadow casting has to alpha-test against the same map or the near trees
  // throw solid rectangular shadows.
  tiers[0].mesh.customDepthMaterial = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    map: tiers[0].mat.map,
    alphaTest: 0.5,
  });

  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _e = new THREE.Euler();
  const _p = new THREE.Vector3();
  const _s = new THREE.Vector3();
  const _fwd = new THREE.Vector3();

  let lastX = 1e9, lastZ = 1e9, lastFx = 0, lastFz = 0, since = 99;
  let burst = 90;

  function refill(camera) {
    const cx = camera.position.x, cz = camera.position.z;
    camera.getWorldDirection(_fwd);
    let fx = _fwd.x, fz = _fwd.z;
    const fl = Math.hypot(fx, fz) || 1;
    fx /= fl; fz /= fl;

    const counts = [0, 0, 0];
    const mats = tiers.map((t) => t.mesh.instanceMatrix.array);
    const attrs = tiers.map((t) => t.attr.array);

    // World wind direction. Constant, so every tree on the hill leans together.
    const wx = 0.86, wz = 0.51;

    field.forEachChunk(cx, cz, FAR_END, (data) => {
      for (let i = 0; i < data.length; i += STRIDE) {
        const x = data[i + S_X], z = data[i + S_Z];
        const dx = x - cx, dz = z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 > FAR_END * FAR_END) continue;
        const d = Math.sqrt(d2);
        // Horizontal cone cull with a generous margin over the 45 deg half-FOV,
        // so a fast camera rotation cannot outrun the refill interval.
        if (d > 64 && dx * fx + dz * fz < 0.17 * d) continue;

        const y = data[i + S_Y], h = data[i + S_H], wr = data[i + S_W];
        const yaw = data[i + S_YAW], lean = data[i + S_LEAN];
        const cell = data[i + S_CELL], shade = data[i + S_SHADE];

        for (let t = 0; t < 3; t++) {
          if (t === 0 && d > NEAR_END) continue;
          if (t === 1 && (d < CROSS_START || d > CROSS_END)) continue;
          if (t === 2 && d < FAR_START) continue;
          const n = counts[t];
          if (n >= tiers[t].max) continue;

          // Billboard tiers are wider than the 3D tree because the silhouette
          // in the atlas fills its cell, and shorter-looking, so they are given
          // the crown width rather than the trunk width.
          const w = t === 0 ? h * wr : h * wr * 0.46;
          _p.set(x, y, z);
          if (t === 2) {
            _q.identity();                       // spun to face the camera in the shader
          } else {
            _e.set(lean, yaw, lean * 0.62, 'YXZ');
            _q.setFromEuler(_e);
          }
          _s.set(w, h, w);
          _m.compose(_p, _q, _s);
          _m.toArray(mats[t], n * 16);

          // Wind direction rotated into this instance's frame.
          const c = Math.cos(-yaw), s = Math.sin(-yaw);
          const o = n * 4;
          if (t === 2) { attrs[t][o] = wx; attrs[t][o + 1] = wz; }
          else { attrs[t][o] = wx * c - wz * s; attrs[t][o + 1] = wx * s + wz * c; }
          attrs[t][o + 2] = shade * 62.8;
          attrs[t][o + 3] = cell;
          counts[t] = n + 1;
        }
      }
    });

    for (let t = 0; t < 3; t++) {
      tiers[t].mesh.count = counts[t];
      tiers[t].mesh.instanceMatrix.needsUpdate = true;
      tiers[t].attr.needsUpdate = true;
    }
    lastX = cx; lastZ = cz; lastFx = fx; lastFz = fz; since = 0;
    return counts;
  }

  let counts = [0, 0, 0];

  function update(dt, camera) {
    const cx = camera.position.x, cz = camera.position.z;
    const jumped = Math.hypot(cx - lastX, cz - lastZ) > 320;
    if (jumped) { field.chunks.clear(); burst = 90; }

    field.stream(cx, cz, STREAM_RADIUS, burst > 0 ? 12 : 3);
    if (burst > 0) burst--;

    camera.getWorldDirection(_fwd);
    let fx = _fwd.x, fz = _fwd.z;
    const fl = Math.hypot(fx, fz) || 1;
    fx /= fl; fz /= fl;

    since += dt;
    const moved = Math.hypot(cx - lastX, cz - lastZ);
    const turned = 1 - (fx * lastFx + fz * lastFz);
    if (burst > 0 || moved > 11 || turned > 0.022 || since > 0.5) counts = refill(camera);
  }

  return {
    group,
    update,
    stats: () => ({ near: counts[0], cross: counts[1], far: counts[2], chunks: field.chunks.size }),
  };
}
