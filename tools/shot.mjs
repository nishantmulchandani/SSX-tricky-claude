#!/usr/bin/env node
/**
 * Visual capture harness. Boots the game in headless Chromium with WebGL,
 * drives it to a deterministic state, and writes PNGs.
 *
 *   node tools/shot.mjs --out shots/x.png --z -400 --wait 3 --w 1920 --h 1080
 *   node tools/shot.mjs --preset gallery --dir shots/
 *
 * Presets capture the canonical review angles so comparisons stay honest
 * across iterations (same camera, same time of day, same seed).
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]]);
    return acc;
  }, []),
);

const URL_BASE = args.url || 'http://localhost:5173/';
const W = +(args.w || 1920), H = +(args.h || 1080);

// Canonical review shots. Keep these stable — the critic compares across runs.
const PRESETS = {
  gallery: [
    { name: '01-start-gate', z: -30, wait: 2.0, speed: 0 },
    { name: '02-open-slope', z: -900, wait: 3.5, speed: 34 },
    { name: '03-steep-carve', z: -2100, wait: 3.5, speed: 46, steer: 0.85 },
    { name: '04-big-air', z: -3200, wait: 3.5, speed: 55, air: true },
    { name: '05-treeline', z: -4300, wait: 3.5, speed: 40 },
    { name: '06-vista', z: -5200, wait: 3.5, speed: 30, wide: true },
  ],
};

async function main() {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || undefined,
    args: [
      '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--disable-gpu-sandbox', '--no-sandbox', '--ignore-gpu-blocklist',
      '--enable-webgl', '--disable-dev-shm-usage',
    ],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(URL_BASE, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !!globalThis.__game, null, { timeout: 30000 });

  const shots = args.preset ? PRESETS[args.preset] : [{
    name: 'shot', z: +(args.z ?? -800), wait: +(args.wait ?? 3), speed: +(args.speed ?? 30),
  }];
  const dir = args.dir || 'shots';
  mkdirSync(dir, { recursive: true });

  for (const s of shots) {
    await page.evaluate((s) => {
      const g = globalThis.__game;
      g.body.reset(s.z);
      g.body.vel.set(0, 0, -(s.speed || 20));
      if (s.steer !== undefined) g.__steer = s.steer;
      if (s.air) { g.body.pos.y += 26; g.body.vel.y = 9; g.body.grounded = false; }
      g.chase.snap(g.body);
      g.mountain.update(g.engine.camera.position);
    }, s);
    // Let the sim settle so terrain streaming, LOD and VFX reach steady state.
    await page.waitForTimeout((s.wait ?? 3) * 1000);
    const out = args.out || `${dir}/${s.name}.png`;
    mkdirSync(dirname(out), { recursive: true });
    await page.screenshot({ path: out });
    console.log('wrote', out);
  }

  if (errors.length) {
    console.error('\n=== PAGE ERRORS ===');
    for (const e of [...new Set(errors)].slice(0, 20)) console.error(e);
    await browser.close();
    process.exit(1);
  }
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
