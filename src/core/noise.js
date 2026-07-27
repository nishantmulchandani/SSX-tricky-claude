/**
 * Deterministic value/simplex-style noise. No dependencies, no seeding surprises —
 * terrain, props and GPU shaders must all agree on these exact functions, so the
 * GLSL mirrors in shaders/noise.glsl.js are kept byte-for-byte equivalent.
 */

export function hash2(x, y) {
  let h = x * 374761393 + y * 668265263;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 4294967296;
}

function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
function lerp(a, b, t) { return a + (b - a) * t; }

/**
 * Precomputed unit gradients.
 *
 * The obvious implementation derives the gradient with cos/sin of a hashed
 * angle, which costs two transcendentals per corner — eight per noise sample,
 * around two hundred per heightAt(). That made the terrain rebuild cost 327ms,
 * twenty times an entire frame. A table lookup is identical in character and
 * roughly free.
 */
const GRAD_N = 256;
const GRAD_X = new Float64Array(GRAD_N);
const GRAD_Y = new Float64Array(GRAD_N);
for (let i = 0; i < GRAD_N; i++) {
  const a = (i / GRAD_N) * Math.PI * 2;
  GRAD_X[i] = Math.cos(a);
  GRAD_Y[i] = Math.sin(a);
}

/** Integer hash -> gradient index. Same mixing as hash2, without the divide. */
function gradIndex(x, y) {
  let h = x * 374761393 + y * 668265263;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) & (GRAD_N - 1);
}

function grad2(ix, iy, x, y) {
  const g = gradIndex(ix, iy);
  return GRAD_X[g] * x + GRAD_Y[g] * y;
}

/** Perlin-style gradient noise in roughly [-1, 1]. */
export function noise2(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const u = fade(fx), v = fade(fy);
  return lerp(
    lerp(grad2(ix, iy, fx, fy), grad2(ix + 1, iy, fx - 1, fy), u),
    lerp(grad2(ix, iy + 1, fx, fy - 1), grad2(ix + 1, iy + 1, fx - 1, fy - 1), u),
    v,
  );
}

/** Fractal Brownian motion. Returns roughly [-1, 1]. */
export function fbm2(x, y, octaves = 5, lacunarity = 2.02, gain = 0.5) {
  let amp = 0.5, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2(x * freq, y * freq);
    norm += amp;
    freq *= lacunarity;
    amp *= gain;
  }
  return sum / norm;
}

/** Ridged multifractal — sharp alpine crests rather than rolling dunes. */
export function ridged2(x, y, octaves = 6, lacunarity = 2.07, gain = 0.5) {
  let amp = 0.5, freq = 1, sum = 0, norm = 0, prev = 1;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(noise2(x * freq, y * freq));
    const r = n * n * prev;
    prev = r;
    sum += amp * r;
    norm += amp;
    freq *= lacunarity;
    amp *= gain;
  }
  return sum / norm;
}

/** Worley / cellular F1 distance — used for snow granularity and ice cracks. */
export function worley2(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  let best = 1e9;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx, cy = iy + dy;
      const px = cx + hash2(cx, cy);
      const py = cy + hash2(cy, cx);
      const d = (px - x) * (px - x) + (py - y) * (py - y);
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}

/** Seeded PRNG — every generator that needs randomness uses this, never Math.random. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
