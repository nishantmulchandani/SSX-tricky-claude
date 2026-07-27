#!/usr/bin/env node
/**
 * End-to-end integration smoke test.
 *
 * Several agents edit this project in parallel, and the failure mode that hurts
 * most is a module that parses fine but blanks the screen at runtime — a shader
 * that will not compile, a temporal-dead-zone reference, a missing uniform.
 * Those do not show up in the unit-level ride/trick tests, which never touch a
 * browser. This boots the real page, plays the game for a few seconds, and
 * fails loudly on anything that would ruin a frame.
 *
 *   node tools/smoke.mjs [--seconds 8] [--w 1280] [--h 720]
 *
 * Requires the dev server on :5173 and CHROME_PATH.
 */
import { chromium } from 'playwright';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : def;
};
const SECONDS = +arg('seconds', 8);
const W = +arg('w', 1280), H = +arg('h', 720);

const failures = [];
const notes = [];
function expect(name, cond, detail = '') {
  if (cond) console.log(` PASS  ${name}${detail ? '  — ' + detail : ''}`);
  else { console.log(` FAIL  ${name}${detail ? '  — ' + detail : ''}`); failures.push(name); }
}

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });

const pageErrors = [];
const shaderErrors = [];
const consoleErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.stack || String(e)));
page.on('console', (m) => {
  if (m.type() !== 'error' && m.type() !== 'warning') return;
  const t = m.text();
  if (/ERROR:\s*\d+:\d+|Shader Error|not compiled|VALIDATE_STATUS/i.test(t)) shaderErrors.push(t);
  else if (m.type() === 'error' && !/404|Failed to load resource/.test(t)) consoleErrors.push(t);
});

console.log('=== SMOKE TEST ===\n');

await page.goto('http://localhost:5173/', { waitUntil: 'load' });

let booted = true;
try {
  await page.waitForFunction(() => !!globalThis.__game, null, { timeout: 30000 });
} catch {
  booted = false;
}
expect('page boots and exposes __game', booted,
  booted ? '' : 'the module graph failed — check pageErrors below');

if (!booted) {
  report();
} else {
  // --- run lifecycle -------------------------------------------------------
  const atTitle = await page.evaluate(() => globalThis.__game.run?.state);
  expect('starts on the title screen', atTitle === 'title', `state=${atTitle}`);

  await page.evaluate(() => globalThis.__game.run.beginCountdown());
  const counting = await page.evaluate(() => globalThis.__game.run.state);
  expect('jump/tuck starts a countdown', counting === 'countdown', `state=${counting}`);

  // Drop into a live run partway down the course and actually play it.
  await page.evaluate(() => {
    const g = globalThis.__game;
    g.run.state = 'riding';
    g.run.countdown = 0;
    g.body.reset(-1400);
    g.body.vel.set(0, 0, -40);
    g.chase.snap(g.body);
  });

  // Hold tuck so the rider carries speed. Steering is applied per-step below
  // as a line-holding controller — pinning a direction key for six seconds
  // just carves the rider 180 degrees and sends them back up the mountain.
  await page.evaluate(() => { globalThis.__game.input.actions.tuck = true; });

  const t0 = Date.now();
  const before = await page.evaluate(() => ({
    z: globalThis.__game.body.pos.z,
    frames: globalThis.__game.engine.renderer.info.render.frame,
  }));

  // Drive the simulation deterministically rather than trusting wall time.
  //
  // Under swiftshader the full post stack renders at well under 1 fps, and the
  // engine deliberately caps fixed steps per frame (anti spiral-of-death), so
  // the sim advances in slow motion. Waiting N seconds would therefore assert
  // almost nothing. Stepping the game system directly exercises the identical
  // code path — physics, tricks, vfx, audio, hud — at a known rate.
  await page.evaluate(async (seconds) => {
    const g = globalThis.__game;
    const sys = g.engine.systems.find((s) => s.fixedUpdate);
    const DT = 1 / 120;
    const steps = Math.round(seconds / DT);
    for (let i = 0; i < steps; i++) {
      // Hold the fall line, and pop an ollie every second to exercise the
      // air/trick/landing path rather than only steady-state riding.
      const cx = g.__courseX ? g.__courseX(g.body.pos.z) : 0;
      const err = g.body.pos.x - cx;
      g.input.axis.steer = Math.max(-0.5, Math.min(0.5, err * 0.02 + g.body.vel.x * 0.05));
      const phase = i % 120;
      g.input.actions.jump = phase < 30;
      g.input.released.jump = phase === 30;

      sys.fixedUpdate(DT, i * DT);
      // Let the browser breathe so rendering still happens alongside.
      if (i % 240 === 0) await new Promise((r) => setTimeout(r, 0));
    }
  }, SECONDS);

  // A short real-time window as well, so the render path is genuinely exercised.
  await page.waitForTimeout(2500);
  const after = await page.evaluate(() => {
    const g = globalThis.__game;
    const info = g.engine.renderer.info;
    return {
      z: g.body.pos.z,
      y: g.body.pos.y,
      speed: g.body.speed,
      frames: info.render.frame,
      calls: info.render.calls,
      triangles: info.render.triangles,
      programs: info.programs?.length ?? 0,
      textures: info.memory.textures,
      geometries: info.memory.geometries,
      state: g.run.state,
      finite: Number.isFinite(g.body.pos.x) && Number.isFinite(g.body.pos.y) && Number.isFinite(g.body.pos.z),
      // renderer.info.render resets on every render() call, and the post stack
      // ends on a fullscreen quad — so reading it after a frame reports "1 call,
      // 1 triangle". Render the scene once directly to get the real cost of the
      // world, which is the number that matters for the instancing budget.
      scene: (() => {
        const prevTarget = g.engine.renderer.getRenderTarget();
        g.engine.renderer.setRenderTarget(null);
        g.engine.renderer.info.reset();
        g.engine.renderer.render(g.engine.scene, g.engine.camera);
        const r = g.engine.renderer.info.render;
        const out = { calls: r.calls, triangles: r.triangles, points: r.points, lines: r.lines };
        g.engine.renderer.setRenderTarget(prevTarget);
        return out;
      })(),
      riderChildren: g.rider?.group?.children?.length ?? 0,
      sceneChildren: g.engine.scene.children.length,
    };
  });
  const wall = (Date.now() - t0) / 1000;
  // NOTE: renderer.info.render.frame counts RENDER PASSES, not animation
  // frames — the post stack issues ~25 per frame — so this is a throughput
  // number, not a frame rate. Under swiftshader it means nothing about real
  // GPU performance; it is here only to spot a total rendering stall.
  const passes = after.frames - before.frames;

  expect('the rider actually moves down the course', after.z < before.z - 50,
    `${Math.round(before.z)} -> ${Math.round(after.z)} over ${SECONDS}s of simulated time`);
  expect('position stays finite (no NaN blow-up)', after.finite);
  expect('speed is sane', after.speed > 1 && after.speed < 120, `${after.speed.toFixed(1)} m/s`);
  expect('no uncaught page errors', pageErrors.length === 0, `${pageErrors.length} error(s)`);
  expect('no shader compile errors', shaderErrors.length === 0, `${shaderErrors.length} error(s)`);
  expect('no unexpected console errors', consoleErrors.length === 0, `${consoleErrors.length} error(s)`);
  expect('the scene actually draws geometry', after.scene.calls > 0 && after.scene.triangles > 1000,
    `${after.scene.calls} calls, ${after.scene.triangles.toLocaleString()} tris`);

  // Budgets. These are warnings, not failures — swiftshader is not a GPU, so
  // absolute fps here is meaningless; the counts are what matter.
  notes.push(`scene calls:  ${after.scene.calls}`);
  notes.push(`scene tris:   ${after.scene.triangles.toLocaleString()}`);
  if (after.scene.points) notes.push(`scene points: ${after.scene.points.toLocaleString()}`);
  notes.push(`programs:     ${after.programs}`);
  notes.push(`textures:     ${after.textures}, geometries: ${after.geometries}`);
  notes.push(`scene roots:  ${after.sceneChildren}`);
  notes.push(`rider parts:  ${after.riderChildren}`);
  notes.push(`render passes: ${passes} in ${wall.toFixed(1)}s wall (software raster; not a frame rate)`);

  if (after.scene.calls > 400) notes.push(`WARNING: ${after.scene.calls} scene draw calls (>400) — instancing may have regressed`);

  // --- pause must actually hold the sim ------------------------------------
  await page.evaluate(() => globalThis.__game.run.togglePause());
  const pz1 = await page.evaluate(() => globalThis.__game.body.pos.z);
  await page.evaluate(() => {
    const g = globalThis.__game;
    const sys = g.engine.systems.find((s) => s.fixedUpdate);
    for (let i = 0; i < 240; i++) sys.fixedUpdate(1 / 120, i / 120);
  });
  const pz2 = await page.evaluate(() => globalThis.__game.body.pos.z);
  expect('pause freezes the rider', Math.abs(pz2 - pz1) < 0.5,
    `moved ${Math.abs(pz2 - pz1).toFixed(2)}m over 2s of stepping while paused`);
  await page.evaluate(() => globalThis.__game.run.togglePause());

  report();
}

function report() {
  if (notes.length) {
    console.log('\n--- metrics ---');
    for (const n of notes) console.log('  ' + n);
  }
  if (pageErrors.length) {
    console.log('\n--- page errors ---');
    for (const e of [...new Set(pageErrors)].slice(0, 5)) console.log('  ' + e.split('\n').slice(0, 3).join('\n  '));
  }
  if (shaderErrors.length) {
    console.log('\n--- shader errors ---');
    for (const e of [...new Set(shaderErrors)].slice(0, 3)) console.log('  ' + e.slice(0, 600));
  }
  if (consoleErrors.length) {
    console.log('\n--- console errors ---');
    for (const e of [...new Set(consoleErrors)].slice(0, 5)) console.log('  ' + e.slice(0, 300));
  }
  console.log(`\nRESULT: ${failures.length ? 'FAIL (' + failures.join(', ') + ')' : 'PASS'}`);
}

await browser.close();
process.exit(failures.length ? 1 : 0);
