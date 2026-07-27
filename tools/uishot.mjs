#!/usr/bin/env node
/**
 * Captures the HUD in each run state, plus a mid-combo gameplay state.
 *
 * The state screens only appear for particular values of run.state, so they
 * are invisible to the normal gameplay capture path.
 *
 *   node tools/uishot.mjs [--dir shots/ui] [--w 1280] [--h 720]
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const DIR = arg('dir', 'shots/ui');
const W = +arg('w', 1280), H = +arg('h', 720);
mkdirSync(DIR, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto('http://localhost:5173/', { waitUntil: 'load' });
await page.waitForFunction(() => !!globalThis.__game, null, { timeout: 30000 });

/** Run the game forward, then leave it in a given state. */
async function settle(seconds, fn) {
  await page.evaluate(async ({ seconds, src }) => {
    const g = globalThis.__game;
    const sys = g.engine.systems.find((s) => s.fixedUpdate);
    const DT = 1 / 120;
    const steps = Math.round(seconds / DT);
    for (let i = 0; i < steps; i++) {
      const cx = g.__courseX(g.body.pos.z);
      const err = (g.body.pos.x - cx) * 0.02 + g.body.vel.x * 0.05;
      g.input.actions.right = err > 0.08;
      g.input.actions.left = err < -0.08;
      g.input.actions.tuck = true;
      // Pop an ollie with a spin every second to build a combo.
      const ph = i % 130;
      g.input.actions.jump = ph < 26;
      g.input.released.jump = ph === 26;
      g.input.actions.spinR = !g.body.grounded;
      g.input.actions.grab1 = !g.body.grounded && g.body.airTime > 0.2 && g.body.vel.y > -6;
      sys.fixedUpdate(DT, i * DT);
      if (i % 2 === 0) sys.update(DT * 2, 0, i * DT);
      if (i % 240 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    if (src) new Function('g', src)(g);
  }, { seconds, src: fn ? `(${fn})(g)` : null });
  await page.waitForTimeout(4500);
}

const shots = [
  {
    name: '01-title',
    go: async () => {
      await page.evaluate(() => { globalThis.__game.run.reset(); });
      await page.waitForTimeout(4000);
    },
  },
  {
    name: '02-countdown',
    go: async () => {
      await page.evaluate(() => {
        const g = globalThis.__game;
        g.run.reset(); g.run.beginCountdown(); g.run.countdown = 2.4;
      });
      await page.waitForTimeout(4000);
    },
  },
  {
    name: '03-combo',
    go: async () => {
      await page.evaluate(() => {
        const g = globalThis.__game;
        g.run.reset(); g.run.beginCountdown();
        g.run.state = 'riding'; g.run.countdown = 0;
        g.body.reset(-1000); g.body.vel.set(0, 0, -42); g.chase.snap(g.body);
      });
      await settle(9);
    },
  },
  {
    name: '04-paused',
    go: async () => { await page.evaluate(() => globalThis.__game.run.togglePause()); await page.waitForTimeout(4000); },
  },
  {
    name: '05-results',
    go: async () => {
      await page.evaluate(() => {
        const g = globalThis.__game;
        if (g.run.state === 'paused') g.run.togglePause();
        g.run.time = 128.4;
        g.run._finish(g.tricks);
      });
      await page.waitForTimeout(4000);
    },
  },
];

for (const s of shots) {
  await s.go();
  const state = await page.evaluate(() => globalThis.__game.run.state);
  await page.screenshot({ path: `${DIR}/${s.name}.png` });
  console.log(`wrote ${DIR}/${s.name}.png  (run.state=${state})`);
}

if (errors.length) {
  console.error('\n=== PAGE ERRORS ===');
  for (const e of [...new Set(errors)].slice(0, 10)) console.error(e);
}
await browser.close();
process.exit(errors.length ? 1 : 0);
