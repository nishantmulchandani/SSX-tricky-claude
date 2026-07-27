/**
 * OWNER: agent "props".
 *
 * Every texture in the world is drawn here with Canvas2D at load time — there
 * are no image assets and no network. Seeded with mulberry32 so the mountain
 * is byte-identical on every boot.
 */

import * as THREE from 'three';
import { mulberry32 } from '../core/noise.js';

export const ATLAS_COLS = 4, ATLAS_ROWS = 7;
const COLS = ATLAS_COLS, ROWS = ATLAS_ROWS;
const CW = 256, CH = 128;

/** Fictional sponsors. No real trademarks anywhere on this mountain. */
export const BRANDS = [
  { name: 'VERTEX', bg: '#b3162a', fg: '#ffffff', sub: 'OUTERWEAR' },
  { name: 'KODIAK', bg: '#12356e', fg: '#eaf2ff', sub: 'SNOW CO.' },
  { name: 'NORTHGRID', bg: '#14432f', fg: '#d8ffe8', sub: 'ENERGY' },
  { name: 'ARCTYX', bg: '#d4620d', fg: '#1a1206', sub: 'FUEL' },
  { name: 'GLACIER 9', bg: '#0d6f7a', fg: '#e6feff', sub: 'HYDRATION' },
  { name: 'PYRE', bg: '#8d1a63', fg: '#ffe9f8', sub: 'BOARDS' },
  { name: 'SUMMIT & CO', bg: '#1b2333', fg: '#ffd166', sub: 'EST. 1974' },
  { name: 'HELIX WAX', bg: '#e2c318', fg: '#141414', sub: 'FAST' },
];

/** Atlas cell indices, referenced by the prop builders. */
export const CELL = {
  brand0: 0,          // .. brand0 + 7
  netOrange: 8,
  netBlue: 9,
  pennantRed: 10,
  pennantBlue: 11,
  start: 12,
  finish: 13,
  hazard: 14,
  pisteMarker: 15,
  km6: 16,            // .. km6 + 5  ->  6 KM .. 1 KM
  seriesBanner: 22,
  blank: 23,
  checkpoint1: 24,    // .. checkpoint1 + 3  ->  CHECKPOINT 1..4
};

function cellRect(i) {
  return { x: (i % COLS) * CW, y: Math.floor(i / COLS) * CH };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function fitText(ctx, text, maxW, px, weight = '800') {
  let size = px;
  do {
    ctx.font = `${weight} ${size}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
    if (ctx.measureText(text).width <= maxW) break;
    size -= 2;
  } while (size > 8);
  return size;
}

function brandCell(ctx, i, brand, rng) {
  const { x, y } = cellRect(i);
  const m = 4;
  ctx.save();
  ctx.translate(x, y);

  // base panel with a subtle vertical shade so it does not read as flat vinyl
  const g = ctx.createLinearGradient(0, 0, 0, CH);
  g.addColorStop(0, brand.bg);
  g.addColorStop(0.55, brand.bg);
  g.addColorStop(1, '#000000');
  ctx.globalAlpha = 1;
  ctx.fillStyle = g;
  ctx.fillRect(m, m, CW - 2 * m, CH - 2 * m);
  ctx.globalAlpha = 0.82;
  ctx.fillStyle = brand.bg;
  ctx.fillRect(m, m, CW - 2 * m, CH - 2 * m);
  ctx.globalAlpha = 1;

  // a diagonal flash — every sponsor banner on earth has one
  ctx.save();
  ctx.beginPath(); ctx.rect(m, m, CW - 2 * m, CH - 2 * m); ctx.clip();
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(-20, CH); ctx.lineTo(CW * 0.42, m - 10); ctx.lineTo(CW * 0.62, m - 10); ctx.lineTo(CW * 0.2, CH);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.restore();

  // wordmark
  ctx.fillStyle = brand.fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const s = fitText(ctx, brand.name, CW - 34, 52);
  ctx.fillText(brand.name, CW / 2, CH * 0.44);
  ctx.font = `600 ${Math.round(s * 0.34)}px Arial, sans-serif`;
  ctx.globalAlpha = 0.8;
  ctx.fillText(brand.sub, CW / 2, CH * 0.72);
  ctx.globalAlpha = 1;

  // eyelets down the edge
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  for (let e = 0; e < 4; e++) {
    const ey = CH * (0.18 + e * 0.215);
    ctx.beginPath(); ctx.arc(10, ey, 3.2, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(CW - 10, ey, 3.2, 0, 7); ctx.fill();
  }

  // grime / wear
  ctx.globalAlpha = 0.1;
  ctx.fillStyle = '#000';
  for (let k = 0; k < 40; k++) {
    ctx.fillRect(rng() * CW, rng() * CH, 1 + rng() * 20, 1 + rng() * 3);
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

function netCell(ctx, i, color) {
  const { x, y } = cellRect(i);
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = color;
  ctx.lineWidth = 3.2;
  ctx.lineCap = 'round';
  const step = 14;
  ctx.beginPath();
  for (let k = -CH; k < CW + CH; k += step) {
    ctx.moveTo(k, 0); ctx.lineTo(k + CH, CH);
    ctx.moveTo(k, CH); ctx.lineTo(k + CH, 0);
  }
  ctx.stroke();
  // heavier border rope
  ctx.lineWidth = 7;
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, 4); ctx.lineTo(CW, 4);
  ctx.moveTo(0, CH - 4); ctx.lineTo(CW, CH - 4);
  ctx.stroke();
  ctx.restore();
}

function pennantCell(ctx, i, color) {
  const { x, y } = cellRect(i);
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(2, 4); ctx.lineTo(CW - 6, CH * 0.5); ctx.lineTo(2, CH - 4);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.beginPath();
  ctx.moveTo(2, CH * 0.34); ctx.lineTo(CW * 0.55, CH * 0.5); ctx.lineTo(2, CH * 0.66);
  ctx.closePath(); ctx.fill();
  ctx.restore();
}

function signCell(ctx, i, text, bg, fg, sub) {
  const { x, y } = cellRect(i);
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = bg;
  roundRect(ctx, 4, 4, CW - 8, CH - 8, 8); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 3; ctx.stroke();
  ctx.fillStyle = fg;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  fitText(ctx, text, CW - 30, sub ? 54 : 76, '900');
  ctx.fillText(text, CW / 2, sub ? CH * 0.42 : CH * 0.5);
  if (sub) {
    ctx.font = '600 22px Arial, sans-serif';
    ctx.globalAlpha = 0.85;
    ctx.fillText(sub, CW / 2, CH * 0.75);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

function hazardCell(ctx, i) {
  const { x, y } = cellRect(i);
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = '#f2c200';
  ctx.fillRect(4, 4, CW - 8, CH - 8);
  ctx.save();
  ctx.beginPath(); ctx.rect(4, 4, CW - 8, CH - 8); ctx.clip();
  ctx.fillStyle = '#191919';
  for (let k = -CH; k < CW; k += 44) {
    ctx.beginPath();
    ctx.moveTo(k, CH); ctx.lineTo(k + 22, CH); ctx.lineTo(k + 22 + CH, 0); ctx.lineTo(k + CH, 0);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
  ctx.restore();
}

function pisteMarkerCell(ctx, i) {
  const { x, y } = cellRect(i);
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = '#e8500f';
  ctx.fillRect(4, 4, CW - 8, CH - 8);
  ctx.fillStyle = '#141414';
  ctx.fillRect(4, CH * 0.42, CW - 8, CH * 0.16);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = '900 44px Arial, sans-serif';
  ctx.fillText('PISTE', CW / 2, CH * 0.22);
  ctx.fillText('7', CW / 2, CH * 0.78);
  ctx.restore();
}

let _atlas = null;
/** 4x7 atlas of banners, signage, netting and pennants. Alpha-tested. */
export function propAtlas() {
  if (_atlas) return _atlas;
  const cv = document.createElement('canvas');
  cv.width = COLS * CW; cv.height = ROWS * CH;
  const ctx = cv.getContext('2d');
  const rng = mulberry32(0xB1A2C3);
  ctx.clearRect(0, 0, cv.width, cv.height);

  for (let b = 0; b < BRANDS.length; b++) brandCell(ctx, CELL.brand0 + b, BRANDS[b], rng);
  netCell(ctx, CELL.netOrange, '#ff6a12');
  netCell(ctx, CELL.netBlue, '#2f6fd0');
  pennantCell(ctx, CELL.pennantRed, '#d81f2a');
  pennantCell(ctx, CELL.pennantBlue, '#1f5ad8');
  signCell(ctx, CELL.start, 'START', '#0f2f5c', '#ffffff', 'SUMMIT SERIES DOWNHILL');
  signCell(ctx, CELL.finish, 'FINISH', '#8f0f1c', '#ffffff', 'SUMMIT SERIES DOWNHILL');
  hazardCell(ctx, CELL.hazard);
  pisteMarkerCell(ctx, CELL.pisteMarker);
  for (let k = 0; k < 6; k++) signCell(ctx, CELL.km6 + k, `${6 - k} KM`, '#101820', '#ffe066', 'TO FINISH');
  signCell(ctx, CELL.seriesBanner, 'SUMMIT SERIES', '#101a2c', '#7fd4ff', 'STAGE 4 - TRICKY');
  signCell(ctx, CELL.blank, ' ', '#f2f4f8', '#f2f4f8');
  for (let k = 0; k < 4; k++) {
    signCell(ctx, CELL.checkpoint1 + k, `CHECKPOINT ${k + 1}`, '#12301c', '#8dffb0', 'SPLIT TIME');
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  _atlas = tex;
  return tex;
}
