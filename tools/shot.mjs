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
      // Captures must show a live run, not the title screen.
      g.run?.beginCountdown?.();
      if (g.run) { g.run.state = 'riding'; g.run.countdown = 0; }
      // Move the WHOLE field, not just the player — otherwise the AI are left
      // at the start gate and never appear in the frame.
      if (g.race) {
        g.race.racers.forEach((r, i) => {
          // Player dead centre on the track; opponents fanned out around them.
          const lateral = i === 0 ? 0 : ((i % 2 ? 1 : -1) * (3 + (i >> 1) * 4));
          // Downhill (more negative z) so they are in front of the camera.
          r.reset(s.z - (i === 0 ? 0 : 14 + (i % 3) * 11), lateral);
          r.body.pos.x = g.__courseX(r.body.pos.z) + lateral;
          r.body.vel.set(0, 0, -(s.speed || 20));
        });
      }
      g.body.reset(s.z);
      g.body.vel.set(0, 0, -(s.speed || 20));
      if (s.steer !== undefined) g.__driveSteer = s.steer;
      if (s.air) { g.body.pos.y += 26; g.body.vel.y = 9; g.body.grounded = false; }
      g.chase.snap(g.body);
      g.mountain.update(g.engine.camera.position);
    }, s);
    // Step the simulation deterministically so VFX reach a steady state.
    // Software rendering runs well under 1 fps here, so simply waiting would
    // capture a frame with barely any simulated time elapsed — no spray, no
    // settled particles. Driving fixedUpdate directly gives the same code path
    // at a known rate. A held steer produces a sustained carve.
    await page.evaluate(async (s) => {
      const g = globalThis.__game;
      const sys = g.engine.systems.find((x) => x.fixedUpdate);
      const DT = 1 / 120;

      // Drive the player with the AI controller for the settle.
      //
      // Hand-rolling a steering controller here kept putting the rider off the
      // course and into the trees, which produced crash frames instead of
      // gameplay frames. The AI already holds a racing line, hits features and
      // spots its landings, and it is exercised by racetest — so captures use
      // that rather than a second, untested driver. `steer` still forces a
      // sustained carve when a shot explicitly asks for one.
      const AI = g.race.racers[1].controller.constructor;
      const saved = g.race.player.controller;
      if (s.steer === undefined) {
        g.race.player.controller = new AI({ skill: 0.95, seed: 7, lane: 0 });
      }

      // 2.2s was not enough. A capture drops the rider onto the course from a
      // standing reset, and the AI needs a few seconds to gather the line — so
      // frame after frame showed it still drifting out towards the barrier,
      // with the camera half inside a padded wall panel. That is a picture of
      // the capture harness, not of the game. 5s gets it onto the racing line.
      const steps = Math.round((s.settle ?? 5.0) / DT);
      for (let i = 0; i < steps; i++) {
        if (s.steer !== undefined) {
          g.input.actions.right = s.steer > 0;
          g.input.actions.left = s.steer < 0;
          g.input.actions.tuck = true;
        }
        sys.fixedUpdate(DT, i * DT);
        // VFX, the rider rig and the camera live in the VARIABLE-rate update,
        // not fixedUpdate. Software rendering only reaches ~0.5fps here, so
        // without driving update() too the particle systems never emit and the
        // capture shows no spray at all.
        if (i % 2 === 0) sys.update(DT * 2, 0, i * DT);
        if (i % 240 === 0) await new Promise((r) => setTimeout(r, 0));
      }
      g.race.player.controller = saved;
    }, s);
    // Now give the renderer real time to actually draw the frame.
    await page.waitForTimeout((s.wait ?? 3) * 1000);
    const out = args.out || `${dir}/${s.name}.png`;
    mkdirSync(dirname(out), { recursive: true });
    // Software rendering draws the full post stack at well under 1fps, so the
    // default 30s screenshot timeout is not enough for a 1080p frame.
    await page.screenshot({ path: out, timeout: 180000 });
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
