/**
 * OWNER: agent "props".
 *
 * Boulders, outcrops and shattered scree. These do two jobs: they break up the
 * long empty flanks above the tree line, and they give the steep ground a
 * reason to read as steep — a 40 degree face of unbroken white has no scale.
 *
 * Four base shapes, each an icosahedron pushed around by the same noise the
 * terrain uses, welded flat-shaded. One InstancedMesh per shape, so the whole
 * scree field is four draw calls. Snow accumulation is the shader's job (see
 * makeRock in propShaders.js): it lands on whatever faces up, broken by world
 * noise, so a boulder is never uniformly frosted.
 */

import * as THREE from 'three';
import { fbm2, mulberry32 } from '../core/noise.js';
import {
  heightAt, slopeAt, courseXAt, courseAt, progressAt, featureAt, COURSE_LENGTH,
} from './terrain.js';
import { ScatterField, smoothstep } from './propCommon.js';

const STREAM_RADIUS = 620;
const DRAW_END = 620;
const SHAPES = 4;
const PER_SHAPE_MAX = 900;

const S_X = 0, S_Y = 1, S_Z = 2, S_S = 3, S_SY = 4, S_YAW = 5, S_TILT = 6,
  S_SHAPE = 7, S_TONE = 8;
const STRIDE = 9;

/**
 * A unit boulder: subdivided icosahedron, radius modulated by two octaves of
 * value noise on the direction vector, then squashed. Flat shading does the
 * rest — the facets are the whole point.
 */
function buildBoulder(seed, detail, squash, jag) {
  const rng = mulberry32(seed);
  const geo = new THREE.IcosahedronGeometry(0.5, detail);
  const pos = geo.attributes.position;
  const ox = rng() * 40, oy = rng() * 40, oz = rng() * 40;

  // Weld first so the noise displacement cannot tear the surface open.
  const map = new Map();
  const keyOf = (x, y, z) => `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
  for (let i = 0; i < pos.count; i++) {
    const k = keyOf(pos.getX(i), pos.getY(i), pos.getZ(i));
    if (map.has(k)) {
      const [nx, ny, nz] = map.get(k);
      pos.setXYZ(i, nx, ny, nz);
      continue;
    }
    let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const len = Math.hypot(x, y, z) || 1;
    const dx = x / len, dy = y / len, dz = z / len;
    let r = 1;
    r += fbm2(ox + dx * 2.1 + dz * 0.7, oy + dz * 2.1 + dy * 0.9, 3) * jag;
    r += fbm2(oz + dx * 6.3, oy + dy * 5.7 + dz * 3.1, 2) * jag * 0.42;
    r = Math.max(0.42, r);
    x = dx * r * len; y = dy * r * len * squash; z = dz * r * len;
    // Flatten the underside: a boulder sits in the snow, it does not balance.
    if (y < -0.16) y = -0.16 - (y + 0.16) * 0.22;
    map.set(k, [x, y, z]);
    pos.setXYZ(i, x, y, z);
  }

  geo.computeVertexNormals();

  // Vertex colour: a granite base with darker crevices and lichen-free faces.
  const n = pos.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const y = pos.getY(i);
    const g = 0.42 + fbm2(pos.getX(i) * 7.0 + ox, pos.getZ(i) * 7.0 + oz, 3) * 0.30;
    const ao = 0.62 + smoothstep(-0.4, 0.5, y) * 0.38;
    col[i * 3] = g * ao * 1.03;
    col[i * 3 + 1] = g * ao * 1.00;
    col[i * 3 + 2] = g * ao * 1.02;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeBoundingSphere();
  return geo;
}

function emitRock(x, z, rng, out) {
  const r0 = rng(), r1 = rng(), r2 = rng();

  if (z > 140 || z < -COURSE_LENGTH - 700) return;

  const cx = courseXAt(z);
  const { width } = courseAt(progressAt(z));
  const half = width * 0.5;
  const d = Math.abs(x - cx);
  if (d < half * 1.5 + 12) return;

  // Two populations: a sparse scatter everywhere, and dense scree wherever the
  // ground is steep enough that snow would slide off it.
  const clump = fbm2(x * 0.0042, z * 0.0042, 3) * 0.5 + 0.5;
  if (r0 > 0.30 * smoothstep(0.42, 0.76, clump) + 0.028) return;

  const y = heightAt(x, z);
  const slope = slopeAt(x, z);
  const steepF = smoothstep(0.30, 0.62, slope);
  const altF = smoothstep(1650, 2150, y);         // more bare rock up high
  if (r1 > 0.16 + 0.72 * steepF + 0.42 * altF) return;

  if (Math.abs(featureAt(x, z)) > 2.0) return;

  const big = r2 * r2;                             // mostly small, a few huge
  const s = 1.1 + big * 12.5 * (0.5 + 0.5 * steepF);
  const sy = s * (0.52 + rng() * 0.42);
  const yaw = rng() * Math.PI * 2;
  const tilt = (rng() - 0.5) * 0.5;
  const shape = Math.min(SHAPES - 1, (rng() * SHAPES) | 0);
  const tone = 0.80 + rng() * 0.36;

  // Sink it into the snow by a third of its height so nothing perches.
  out.push(x, y - sy * 0.30, z, s, sy, yaw, tilt, shape, tone);
}

export function createRocks(scene, material) {
  const group = new THREE.Group();
  group.name = 'rocks';
  scene.add(group);

  const geos = [
    buildBoulder(0x51A7E1, 2, 0.78, 0.30),
    buildBoulder(0x51A7E2, 1, 0.62, 0.46),
    buildBoulder(0x51A7E3, 2, 1.05, 0.22),   // upright outcrop
    buildBoulder(0x51A7E4, 1, 0.44, 0.52),   // flat slab
  ];

  const meshes = geos.map((g, i) => {
    const m = new THREE.InstancedMesh(g, material, PER_SHAPE_MAX);
    m.name = `rock-${i}`;
    m.count = 0;
    m.frustumCulled = false;
    m.castShadow = false;
    m.receiveShadow = true;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(PER_SHAPE_MAX * 3), 3);
    m.instanceColor.setUsage(THREE.DynamicDrawUsage);
    group.add(m);
    return m;
  });

  const field = new ScatterField({
    chunk: 128, cell: 11, seed: 0x30CC5, stride: STRIDE, emit: emitRock,
  });

  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _e = new THREE.Euler();
  const _p = new THREE.Vector3();
  const _s = new THREE.Vector3();
  const _fwd = new THREE.Vector3();

  let lastX = 1e9, lastZ = 1e9, lastFx = 0, lastFz = 0, since = 99, burst = 60;
  let counts = [0, 0, 0, 0];

  function refill(camera) {
    const cx = camera.position.x, cz = camera.position.z;
    camera.getWorldDirection(_fwd);
    let fx = _fwd.x, fz = _fwd.z;
    const fl = Math.hypot(fx, fz) || 1;
    fx /= fl; fz /= fl;

    counts = [0, 0, 0, 0];
    field.forEachChunk(cx, cz, DRAW_END, (data) => {
      for (let i = 0; i < data.length; i += STRIDE) {
        const x = data[i + S_X], z = data[i + S_Z];
        const dx = x - cx, dz = z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 > DRAW_END * DRAW_END) continue;
        const d = Math.sqrt(d2);
        if (d > 60 && dx * fx + dz * fz < 0.17 * d) continue;
        // Small rocks are not worth a draw at range: cull by screen size.
        const s = data[i + S_S];
        if (s < d * 0.006) continue;

        const shape = data[i + S_SHAPE] | 0;
        const n = counts[shape];
        if (n >= PER_SHAPE_MAX) continue;

        _p.set(x, data[i + S_Y], z);
        _e.set(data[i + S_TILT], data[i + S_YAW], data[i + S_TILT] * 0.7, 'YXZ');
        _q.setFromEuler(_e);
        _s.set(s, data[i + S_SY], s);
        _m.compose(_p, _q, _s);
        _m.toArray(meshes[shape].instanceMatrix.array, n * 16);

        const t = data[i + S_TONE];
        const ca = meshes[shape].instanceColor.array;
        ca[n * 3] = t; ca[n * 3 + 1] = t * 1.01; ca[n * 3 + 2] = t * 1.06;
        counts[shape] = n + 1;
      }
    });

    for (let i = 0; i < SHAPES; i++) {
      meshes[i].count = counts[i];
      meshes[i].instanceMatrix.needsUpdate = true;
      meshes[i].instanceColor.needsUpdate = true;
    }
    lastX = cx; lastZ = cz; lastFx = fx; lastFz = fz; since = 0;
  }

  function update(dt, camera) {
    const cx = camera.position.x, cz = camera.position.z;
    if (Math.hypot(cx - lastX, cz - lastZ) > 320) { field.chunks.clear(); burst = 60; }
    field.stream(cx, cz, STREAM_RADIUS, burst > 0 ? 8 : 2);
    if (burst > 0) burst--;

    camera.getWorldDirection(_fwd);
    let fx = _fwd.x, fz = _fwd.z;
    const fl = Math.hypot(fx, fz) || 1;
    fx /= fl; fz /= fl;

    since += dt;
    const moved = Math.hypot(cx - lastX, cz - lastZ);
    const turned = 1 - (fx * lastFx + fz * lastFz);
    if (burst > 0 || moved > 14 || turned > 0.025 || since > 0.6) refill(camera);
  }

  return {
    group,
    update,
    stats: () => ({ total: counts.reduce((a, b) => a + b, 0), chunks: field.chunks.size }),
  };
}
