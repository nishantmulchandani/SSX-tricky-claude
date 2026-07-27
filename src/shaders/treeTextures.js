/**
 * OWNER: agent "props".
 *
 * Procedural conifer textures:
 *   barkNeedleAtlas() — 512x512. Left half is bark. The right half is split into
 *                       a green needle spray (top) and the same spray under a
 *                       snow load (bottom); the near LOD lays the snowy card
 *                       just above the green one so the load has real thickness
 *                       and a ragged edge instead of being a white wash.
 *   coniferAtlas()    — 1024x1024, 2x2 whole-tree silhouettes with snow load,
 *                       used by the crossed-billboard mid LOD and the single
 *                       camera-facing far LOD.
 *
 * All drawn with Canvas2D from a mulberry32 stream, so the forest is identical
 * on every boot.
 */

import * as THREE from 'three';
import { mulberry32 } from '../core/noise.js';

// --------------------------------------------------------------------------
// bark + needle card
// --------------------------------------------------------------------------
function drawBark(ctx, x, y, w, h, rng) {
  const g = ctx.createLinearGradient(x, 0, x + w, 0);
  g.addColorStop(0, '#2b1f18');
  g.addColorStop(0.35, '#5a4433');
  g.addColorStop(0.62, '#6b5340');
  g.addColorStop(1, '#241a14');
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);

  // vertical fissures
  for (let i = 0; i < 260; i++) {
    const bx = x + rng() * w;
    const by = y + rng() * h;
    const len = 14 + rng() * 110;
    const wid = 0.8 + rng() * 3.2;
    const dark = rng() < 0.6;
    ctx.globalAlpha = 0.16 + rng() * 0.3;
    ctx.fillStyle = dark ? '#160f0a' : '#8b7154';
    ctx.beginPath();
    ctx.ellipse(bx, by, wid, len * 0.5, (rng() - 0.5) * 0.12, 0, 7);
    ctx.fill();
  }
  // flaky plates
  for (let i = 0; i < 90; i++) {
    ctx.globalAlpha = 0.12 + rng() * 0.16;
    ctx.fillStyle = rng() < 0.5 ? '#0f0a07' : '#9a7f5f';
    ctx.fillRect(x + rng() * w, y + rng() * h, 3 + rng() * 12, 3 + rng() * 20);
  }
  ctx.globalAlpha = 1;
}

function drawNeedleCard(ctx, x, y, w, h, rng) {
  const midY = y + h * 0.5;
  const tipX = x + w * 0.97;

  // fine needles: back-swept pairs off a central stem, shrinking towards the tip
  const N = 420;
  for (let i = 0; i < N; i++) {
    const t = Math.pow(rng(), 0.72);            // bias towards the trunk end
    const sx = x + w * (0.02 + t * 0.93);
    const reach = (h * 0.46) * Math.pow(1 - t, 0.72) * (0.55 + rng() * 0.65);
    const side = rng() < 0.5 ? -1 : 1;
    const sweep = 0.55 + rng() * 0.6;           // how far back the needle lies
    const ex = sx + reach * sweep * 0.85;
    const ey = midY + side * reach;
    const shade = 0.55 + rng() * 0.45;
    const green = `rgb(${Math.round(28 + 44 * shade)},${Math.round(60 + 74 * shade)},${Math.round(30 + 46 * shade)})`;
    ctx.strokeStyle = green;
    ctx.lineWidth = 1.1 + rng() * 1.7;
    ctx.lineCap = 'round';
    ctx.globalAlpha = 0.65 + rng() * 0.35;
    ctx.beginPath();
    ctx.moveTo(sx, midY + side * h * 0.02);
    ctx.quadraticCurveTo(sx + reach * 0.4, midY + side * reach * 0.55, ex, ey);
    ctx.stroke();
  }

  // secondary sprigs so the card is not a single flat fan
  for (let i = 0; i < 34; i++) {
    const t = rng();
    const sx = x + w * (0.05 + t * 0.8);
    const side = rng() < 0.5 ? -1 : 1;
    const reach = h * 0.3 * (1 - t) * (0.6 + rng() * 0.7);
    ctx.strokeStyle = 'rgba(48,38,26,0.85)';
    ctx.lineWidth = 1.3 + rng() * 1.4;
    ctx.beginPath();
    ctx.moveTo(sx, midY);
    ctx.lineTo(sx + reach * 0.9, midY + side * reach);
    ctx.stroke();
  }

  // central stem
  ctx.globalAlpha = 1;
  ctx.strokeStyle = '#3d2f21';
  ctx.lineWidth = 4.2;
  ctx.beginPath();
  ctx.moveTo(x + w * 0.01, midY);
  ctx.lineTo(tipX, midY);
  ctx.stroke();
  ctx.strokeStyle = '#5a4630';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(x + w * 0.01, midY - 1.2);
  ctx.lineTo(tipX, midY - 1.2);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

/**
 * The same spray, buried. Drawn as a mat of small overlapping caps following
 * the needle envelope, so the alpha edge stays ragged and the clumps catch
 * their own shading rather than reading as a painted-on white stripe.
 */
function drawSnowCard(ctx, x, y, w, h, rng) {
  const midY = y + h * 0.5;
  for (let i = 0; i < 300; i++) {
    const t = Math.pow(rng(), 0.62);
    const sx = x + w * (0.03 + t * 0.92);
    const spread = (h * 0.44) * Math.pow(1 - t, 0.7);
    const off = (rng() * 2 - 1) * spread;
    const px = sx + Math.abs(off) * 0.35;
    const py = midY + off;
    const r = (h * 0.028 + rng() * h * 0.045) * (0.45 + (1 - t) * 0.8);
    const shade = 0.86 + rng() * 0.14;
    ctx.fillStyle = `rgb(${Math.round(226 * shade)},${Math.round(238 * shade)},${Math.round(252 * shade)})`;
    ctx.beginPath();
    ctx.ellipse(px, py, r * (1.1 + rng() * 0.7), r * (0.62 + rng() * 0.4), (rng() - 0.5) * 0.9, 0, 7);
    ctx.fill();
  }
  // a few dark needle tips poking through the load
  ctx.strokeStyle = 'rgba(22,46,26,0.75)';
  for (let i = 0; i < 70; i++) {
    const t = rng();
    const sx = x + w * (0.05 + t * 0.9);
    const spread = (h * 0.42) * Math.pow(1 - t, 0.7);
    const off = (rng() * 2 - 1) * spread;
    ctx.lineWidth = 1 + rng() * 1.6;
    ctx.beginPath();
    ctx.moveTo(sx, midY + off);
    ctx.lineTo(sx + h * 0.03 * rng(), midY + off + (rng() - 0.5) * h * 0.05);
    ctx.stroke();
  }
  // bright rim on the sunward side of each clump ridge
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = '#ffffff';
  for (let i = 0; i < 90; i++) {
    const t = Math.pow(rng(), 0.6);
    const sx = x + w * (0.04 + t * 0.9);
    const spread = (h * 0.4) * Math.pow(1 - t, 0.7);
    const off = (rng() * 2 - 1) * spread;
    const r = h * 0.016 + rng() * h * 0.022;
    ctx.beginPath();
    ctx.ellipse(sx, midY + off, r * 1.3, r * 0.55, 0, 0, 7);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

let _barkTex = null;
export function barkNeedleAtlas() {
  if (_barkTex) return _barkTex;
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = S; cv.height = S;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, S, S);
  const rng = mulberry32(0x5EED11);
  drawBark(ctx, 0, 0, S * 0.5, S, rng);
  drawNeedleCard(ctx, S * 0.5, 0, S * 0.5, S * 0.5, rng);
  drawSnowCard(ctx, S * 0.5, S * 0.5, S * 0.5, S * 0.5, rng);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  _barkTex = tex;
  return tex;
}

// --------------------------------------------------------------------------
// whole-tree silhouettes
// --------------------------------------------------------------------------
function jaggedEdge(ctx, x0, y0, x1, y1, steps, amp, rng) {
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const jx = x0 + (x1 - x0) * t + (rng() - 0.5) * amp;
    const jy = y0 + (y1 - y0) * t + (rng() - 0.5) * amp * 0.7;
    ctx.lineTo(jx, jy);
  }
}

/**
 * A single snow-laden spruce filling the box (ox, oy, S, S).
 * `form` shifts between a narrow alpine fir (0) and a broad spruce (1).
 */
function drawConifer(ctx, ox, oy, S, rng, form = 0.5, snowAmt = 0.85) {
  const cx = ox + S * 0.5;
  const baseY = oy + S * 0.985;
  const topY = oy + S * 0.035;
  const maxHalf = S * (0.20 + 0.20 * form);

  // ---- trunk -------------------------------------------------------------
  ctx.fillStyle = '#3a2b20';
  ctx.beginPath();
  ctx.moveTo(cx - S * 0.022, baseY);
  ctx.lineTo(cx - S * 0.007, topY + S * 0.06);
  ctx.lineTo(cx + S * 0.007, topY + S * 0.06);
  ctx.lineTo(cx + S * 0.024, baseY);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = 'rgba(120,96,68,0.5)';
  ctx.fillRect(cx - S * 0.004, topY + S * 0.1, S * 0.012, S * 0.86);

  const N = 17;
  // top-down so the lower whorls overlay: reads correctly from the side
  for (let i = N - 1; i >= 0; i--) {
    const t = i / (N - 1);                    // 0 = bottom whorl, 1 = apex
    const y = baseY - (baseY - topY) * (t * 0.94 + 0.02);
    const shrink = Math.pow(1 - t, 0.62);
    const half = maxHalf * shrink * (0.82 + rng() * 0.34);
    if (half < S * 0.012) continue;
    const droop = S * (0.035 + 0.045 * (1 - t)) * (0.7 + rng() * 0.6);
    const lift = S * 0.032 * (0.6 + rng() * 0.8);

    for (const side of [-1, 1]) {
      const tipX = cx + side * half;
      const g = ctx.createLinearGradient(0, y - lift, 0, y + droop);
      const lum = 0.55 + t * 0.35;
      g.addColorStop(0, `rgb(${Math.round(34 * lum + 14)},${Math.round(92 * lum + 18)},${Math.round(44 * lum + 16)})`);
      g.addColorStop(1, `rgb(${Math.round(10 * lum + 5)},${Math.round(32 * lum + 8)},${Math.round(16 * lum + 6)})`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(cx - side * S * 0.01, y - lift);
      // upper edge out to the drooping tip
      jaggedEdge(ctx, cx, y - lift, tipX, y + droop, 7, S * 0.016, rng);
      // ragged underside back to the trunk
      jaggedEdge(ctx, tipX, y + droop, cx, y + droop * 0.35 + S * 0.02, 8, S * 0.026, rng);
      ctx.closePath();
      ctx.fill();

      // needle fringe hanging off the underside
      ctx.strokeStyle = `rgba(16,42,20,0.85)`;
      ctx.lineWidth = Math.max(1, S * 0.004);
      for (let k = 0; k < 13; k++) {
        const u = 0.15 + rng() * 0.85;
        const sx = cx + side * half * u;
        const sy = y + droop * u * 0.85 + S * 0.004;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(sx + side * S * 0.012 * rng(), sy + S * (0.012 + rng() * 0.03));
        ctx.stroke();
      }

      // ---- snow load on the upper surface --------------------------------
      if (rng() < 0.92) {
        ctx.fillStyle = `rgba(238,246,255,${0.72 + 0.28 * snowAmt})`;
        ctx.beginPath();
        ctx.moveTo(cx - side * S * 0.008, y - lift);
        jaggedEdge(ctx, cx, y - lift, tipX * 0.995 + cx * 0.005, y + droop * 0.9, 7, S * 0.012, rng);
        // inner boundary of the snow cap, ragged so it is not a painted stripe
        for (let k = 6; k >= 0; k--) {
          const u = k / 6;
          const px = cx + side * half * u;
          const py = y - lift + (droop + lift) * u * (0.42 + rng() * 0.34) - S * 0.004;
          ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
        // clumps sitting proud of the branch
        ctx.fillStyle = 'rgba(250,253,255,0.95)';
        for (let k = 0; k < 5; k++) {
          const u = 0.1 + rng() * 0.85;
          const px = cx + side * half * u;
          const py = y - lift + (droop + lift) * u * 0.4;
          ctx.beginPath();
          ctx.ellipse(px, py - S * 0.004, S * (0.008 + rng() * 0.016), S * (0.005 + rng() * 0.009), 0, 0, 7);
          ctx.fill();
        }
      }
    }
  }

  // apex spike
  ctx.fillStyle = '#173a1e';
  ctx.beginPath();
  ctx.moveTo(cx - S * 0.014, topY + S * 0.075);
  ctx.lineTo(cx, topY);
  ctx.lineTo(cx + S * 0.014, topY + S * 0.075);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = 'rgba(240,248,255,0.9)';
  ctx.beginPath();
  ctx.moveTo(cx - S * 0.008, topY + S * 0.05);
  ctx.lineTo(cx, topY);
  ctx.lineTo(cx + S * 0.008, topY + S * 0.05);
  ctx.closePath(); ctx.fill();

  // ambient shading: the base of the crown sits in its own shadow
  const ao = ctx.createLinearGradient(0, oy + S * 0.45, 0, baseY);
  ao.addColorStop(0, 'rgba(6,18,28,0)');
  ao.addColorStop(1, 'rgba(6,18,28,0.42)');
  ctx.save();
  ctx.globalCompositeOperation = 'source-atop';
  ctx.fillStyle = ao;
  ctx.fillRect(ox, oy, S, S);
  ctx.restore();
}

let _coniferTex = null;
/** 2x2 atlas of whole snowy conifers. Cell (col,row) picked per instance. */
export function coniferAtlas() {
  if (_coniferTex) return _coniferTex;
  const S = 512;
  const cv = document.createElement('canvas');
  cv.width = S * 2; cv.height = S * 2;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  const rng = mulberry32(0xC0FFEE);
  const forms = [0.15, 0.5, 0.85, 0.35];
  const snows = [0.95, 0.7, 0.9, 0.45];
  for (let i = 0; i < 4; i++) {
    drawConifer(ctx, (i % 2) * S, Math.floor(i / 2) * S, S, rng, forms[i], snows[i]);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  _coniferTex = tex;
  return tex;
}
