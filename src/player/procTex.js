/**
 * OWNER: agent "character".
 *
 * Every texture the rider uses is generated here, at runtime, into a canvas.
 * There are no image assets in this project — and honestly a good procedural
 * weave beats a 512px jpeg of a jacket. Everything is cached so the second
 * Rider (if we ever spawn one) costs nothing.
 *
 * Normal maps are produced from a scalar height field by central differences,
 * which keeps the authoring side to "write a height function".
 */
import * as THREE from 'three';
import { noise2, fbm2, hash2 } from '../core/noise.js';

const cache = new Map();
function cached(key, make) {
  let t = cache.get(key);
  if (!t) { t = make(); cache.set(key, t); }
  return t;
}

function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  return c;
}

function finish(tex, repeat = 1) {
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Build a tangent-space normal map from a height function h(u,v) in [0,1]^2.
 * The function is sampled on a torus so the result tiles seamlessly.
 */
function normalFromHeight(size, strength, h) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const inv = 1 / size;
  const H = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) H[y * size + x] = h(x * inv, y * inv);
  }
  const at = (x, y) => H[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      // n = normalize(-dx, -dy, 1)
      const l = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      d[i] = Math.round((-dx / l * 0.5 + 0.5) * 255);
      d[i + 1] = Math.round((-dy / l * 0.5 + 0.5) * 255);
      d[i + 2] = Math.round((1 / l * 0.5 + 0.5) * 255);
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  return finish(tex);
}

/** Grey-scale data map (roughness / ao / metalness). fn returns 0..1. */
function dataMap(size, fn, colorSpace = THREE.NoColorSpace) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const inv = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = Math.max(0, Math.min(1, fn(x * inv, y * inv)));
      const i = (y * size + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = Math.round(v * 255);
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = colorSpace;
  return finish(tex);
}

// ── fabric ─────────────────────────────────────────────────────────────────
// A twill weave: two interleaved thread families plus quilting-scale noise so
// the silhouette catches light unevenly the way a shell jacket does.
function weaveHeight(u, v, threads) {
  const tu = u * threads, tv = v * threads;
  const fu = tu - Math.floor(tu), fv = tv - Math.floor(tv);
  const overU = Math.sin(fu * Math.PI);
  const overV = Math.sin(fv * Math.PI);
  // twill: which family is on top depends on the diagonal index
  const diag = (Math.floor(tu) + Math.floor(tv)) % 3;
  const w = diag === 0 ? overU * 0.9 + overV * 0.25 : overV * 0.9 + overU * 0.25;
  return w;
}

export function fabricNormal() {
  return cached('fabricNormal', () => normalFromHeight(256, 26, (u, v) => (
    weaveHeight(u, v, 64) * 0.55
    + fbm2(u * 18, v * 18, 4) * 0.9
    + noise2(u * 90, v * 90) * 0.12
  )));
}

/** Coarser, softer: for pants and the pack. */
export function canvasNormal() {
  return cached('canvasNormal', () => normalFromHeight(256, 20, (u, v) => (
    weaveHeight(u, v, 34) * 0.75
    + fbm2(u * 11, v * 11, 4) * 1.25
  )));
}

export function fabricRough() {
  return cached('fabricRough', () => dataMap(256, (u, v) => (
    0.74 + fbm2(u * 14 + 31, v * 14 - 7, 4) * 0.20 + weaveHeight(u, v, 64) * 0.05
  )));
}

/** Fine orange-peel for helmets / glossy shells. */
export function shellNormal() {
  return cached('shellNormal', () => normalFromHeight(256, 4.0, (u, v) => (
    fbm2(u * 26, v * 26, 3) * 1.0 + noise2(u * 70, v * 70) * 0.25
  )));
}

/** Grippy rubber: for boot soles, straps and the glove palm. */
export function rubberNormal() {
  return cached('rubberNormal', () => normalFromHeight(256, 22, (u, v) => {
    const gx = Math.abs(((u * 22) % 1) - 0.5);
    const gy = Math.abs(((v * 22) % 1) - 0.5);
    const dots = Math.max(0, 1 - Math.hypot(gx, gy) * 3.2);
    return dots * 1.4 + fbm2(u * 40, v * 40, 3) * 0.35;
  }));
}

// ── jacket colour ──────────────────────────────────────────────────────────
/**
 * The jacket colour map. UVs on the skin run u = around the body, v = along
 * the limb, so horizontal bands here read as chest/waist panels and vertical
 * ones as sleeve stripes.
 */
export function jacketMap(opts = {}) {
  const key = 'jacket' + JSON.stringify(opts);
  return cached(key, () => {
    const S = 512;
    const c = makeCanvas(S);
    const ctx = c.getContext('2d');
    const base = opts.base || '#d8402f';
    const dark = opts.dark || '#7c1a18';
    const accent = opts.accent || '#f2f0ea';
    ctx.fillStyle = base; ctx.fillRect(0, 0, S, S);

    // horizontal panel bands (they wrap the torso)
    const band = (y0, y1, fill) => { ctx.fillStyle = fill; ctx.fillRect(0, y0, S, y1 - y0); };
    band(0.00 * S, 0.16 * S, dark);
    band(0.16 * S, 0.19 * S, accent);
    band(0.62 * S, 0.78 * S, dark);
    band(0.60 * S, 0.62 * S, accent);

    // vertical seam shading
    for (let i = 0; i < 6; i++) {
      const x = (i / 6) * S + 8;
      const g = ctx.createLinearGradient(x - 10, 0, x + 10, 0);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(0.5, 'rgba(0,0,0,0.30)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.fillRect(x - 10, 0, 20, S);
    }

    // stitched-in fabric grain
    const img = ctx.getImageData(0, 0, S, S);
    const d = img.data;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const n = 0.90 + fbm2(x * 0.045, y * 0.045, 4) * 0.16 + hash2(x, y) * 0.05;
        const i = (y * S + x) * 4;
        d[i] = Math.min(255, d[i] * n);
        d[i + 1] = Math.min(255, d[i + 1] * n);
        d[i + 2] = Math.min(255, d[i + 2] * n);
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return finish(tex);
  });
}

export function pantsMap(opts = {}) {
  const key = 'pants' + JSON.stringify(opts);
  return cached(key, () => {
    const S = 512;
    const c = makeCanvas(S);
    const ctx = c.getContext('2d');
    ctx.fillStyle = opts.base || '#2b2f3a'; ctx.fillRect(0, 0, S, S);
    // knee reinforcement patches + a cargo pocket band
    ctx.fillStyle = opts.dark || '#1b1e26';
    ctx.fillRect(0, 0.40 * S, S, 0.16 * S);
    ctx.fillStyle = opts.accent || '#4a5164';
    ctx.fillRect(0, 0.385 * S, S, 0.012 * S);
    ctx.fillRect(0, 0.565 * S, S, 0.012 * S);
    const img = ctx.getImageData(0, 0, S, S);
    const d = img.data;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const n = 0.88 + fbm2(x * 0.03 + 11, y * 0.03 + 5, 4) * 0.22 + hash2(x * 3, y * 3) * 0.06;
        const i = (y * S + x) * 4;
        d[i] *= n; d[i + 1] *= n; d[i + 2] *= n;
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return finish(tex);
  });
}

// ── board graphics ─────────────────────────────────────────────────────────
/** Base graphic: bold, high-contrast, reads at speed and upside down. */
export function boardBaseMap() {
  return cached('boardBase', () => {
    const W = 256, H = 1024;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0.0, '#0d0f14');
    g.addColorStop(0.5, '#151a24');
    g.addColorStop(1.0, '#0d0f14');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    // diagonal speed slashes
    ctx.save();
    ctx.translate(W / 2, H / 2); ctx.rotate(-0.30); ctx.translate(-W / 2, -H / 2);
    const cols = ['#ff5a1f', '#ffd23f', '#28c4d8'];
    for (let i = 0; i < 9; i++) {
      ctx.fillStyle = cols[i % 3];
      ctx.globalAlpha = 0.85;
      const y = -80 + i * 130;
      ctx.fillRect(-60, y, W + 120, 26 + (i % 3) * 8);
    }
    ctx.restore();
    ctx.globalAlpha = 1;

    // big centre chevrons
    ctx.strokeStyle = '#f4f6fb'; ctx.lineWidth = 16; ctx.lineJoin = 'round';
    for (let i = 0; i < 3; i++) {
      const y = H * 0.5 + (i - 1) * 78;
      ctx.beginPath();
      ctx.moveTo(24, y - 46); ctx.lineTo(W - 24, y); ctx.lineTo(24, y + 46);
      ctx.stroke();
    }
    // wordmark blocks near the tail
    ctx.fillStyle = '#f4f6fb';
    ctx.fillRect(40, H * 0.86, W - 80, 10);
    ctx.fillRect(70, H * 0.89, W - 140, 6);

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
  });
}

/** Topsheet: darker, sits under the bindings so it is mostly seen edge-on. */
export function boardTopMap() {
  return cached('boardTop', () => {
    const W = 256, H = 1024;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#101319'; ctx.fillRect(0, 0, W, H);
    const g = ctx.createLinearGradient(0, 0, W, 0);
    g.addColorStop(0, '#1c222e'); g.addColorStop(0.5, '#2a3242'); g.addColorStop(1, '#1c222e');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#ff5a1f';
    ctx.fillRect(0, H * 0.06, W, 18);
    ctx.fillRect(0, H * 0.92, W, 18);
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    for (let i = 0; i < 40; i++) {
      const y = (i / 40) * H;
      ctx.fillRect(0, y, W, 2);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
  });
}

/** Fine scratches for the board base roughness — snow-worn P-tex. */
export function baseRough() {
  return cached('baseRough', () => dataMap(256, (u, v) => {
    const scratch = Math.abs(noise2(u * 3.0, v * 220)) * 0.35;
    return 0.20 + scratch + fbm2(u * 9, v * 9, 3) * 0.10;
  }));
}
