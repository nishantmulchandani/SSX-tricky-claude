#!/usr/bin/env node
/**
 * OWNER: agent "character".
 *
 * Close-up capture harness for the rider. The chase camera sits 8-11 m back,
 * which is the right frame for gameplay but far too small to judge a face, a
 * glove or a grab. This drives a free camera parked a couple of metres from
 * the rider instead, and renders the scene DIRECTLY (bypassing the post stack,
 * which belongs to another agent and is sometimes mid-edit).
 *
 *   node tools/charshot.mjs --out shots/char/pose.png --pose ride
 *   node tools/charshot.mjs --turntable --dir shots/char/tt
 *   node tools/charshot.mjs --sheet shots/char/sheet   # every pose, one file each
 *
 * Poses are forced by writing directly into the live body/tricks objects, so
 * what you see is exactly what the rig produces for that state.
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

// name -> mutation applied to { body, tricks } just before the frame is drawn.
const POSES = {
  ride:    { speed: 30 },
  carve:   { speed: 42, edge: 0.95, roll: -0.62 },
  crouch:  { speed: 30, crouch: 1.0 },
  air:     { speed: 40, air: 3.0 },
  tuck:    { speed: 40, air: 3.0, spinRate: 2.6 },
  spin:    { speed: 40, air: 3.0, spinRate: 1.6, yawRev: 0.75 },
  flip:    { speed: 40, air: 3.0, flipRate: 1.2, flipRev: 0.4 },
  indy:    { speed: 40, air: 3.0, grab: 'grab1', dir: 'neutral' },
  melon:   { speed: 40, air: 3.0, grab: 'grab2', dir: 'neutral' },
  method:  { speed: 40, air: 3.0, grab: 'grab2', dir: 'left' },
  mute:    { speed: 40, air: 3.0, grab: 'grab2', dir: 'right' },
  nose:    { speed: 40, air: 3.0, grab: 'grab2', dir: 'up' },
  tail:    { speed: 40, air: 3.0, grab: 'grab1', dir: 'down' },
  stale:   { speed: 40, air: 3.0, grab: 'grab1', dir: 'left' },
  japan:   { speed: 40, air: 3.0, grab: 'grab3', dir: 'neutral' },
  crail:   { speed: 40, air: 3.0, grab: 'grab1', dir: 'up' },
  roast:   { speed: 40, air: 3.0, grab: 'grab1', dir: 'right' },
  switchr: { speed: 32, stance: 1 },
  switchg: { speed: 40, air: 3.0, grab: 'grab2', dir: 'neutral', stance: 1 },
  land:    { speed: 34, impact: 22 },
  crash:   { speed: 26, crashed: true },
  grind:   { speed: 26, grind: true },
};

const setup = async (page, p, opt) => {
  await page.evaluate(([p, opt]) => {
    const g = globalThis.__game;
    const T = g.THREE;
    g.run.beginCountdown?.();
    g.run.state = 'riding'; g.run.countdown = 0;
    g.body.reset(+opt.z);
    g.body.vel.set(0, 0, -(p.speed || 20));
    g.body.speed = p.speed || 20;
    g.tricks.reset();
    // Let the sim settle on the ground first, then force the state we want.
    globalThis.__charForce = () => {
      const b = g.body, t = g.tricks;
      b.speed = p.speed || 20;
      if (p.edge !== undefined) { b.edge = p.edge; b.roll = p.roll ?? 0; }
      if (p.crouch !== undefined) b.crouch = p.crouch;
      if (p.impact !== undefined) { b.lastLandImpact = p.impact; }
      if (p.crashed) { b.crashed = true; b.crashTimer = 1.6; t.phase = 'crash'; }
      if (p.stance !== undefined) t.stance = p.stance;
      if (p.grind) { t.phase = 'grind'; t.grindInfo.active = true; t.grindInfo.balance = 0.3; }
      if (p.air) {
        b.grounded = false; b.airTime = p.air; b.pos.y += 6; b.vel.y = 2;
        t.phase = 'air'; t.airTime = p.air;
        t.rotation.spinRate = p.spinRate || 0;
        t.rotation.flipRate = p.flipRate || 0;
        t.rotation.yaw = b.yaw + (p.yawRev || 0) * Math.PI * 2;
        t.rotation.pitch = (p.flipRev || 0) * Math.PI * 2;
        b.pitch = t.rotation.pitch; b.roll = 0;
        if (p.grab) {
          const tbl = g.tricks.constructor;
          t.grab = { ...(globalThis.__GRABTABLE[p.grab][p.dir || 'neutral']), hold: 0.5, dir: p.dir };
        }
      }
    };
  }, [p, opt]);
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
  const W = +(args.w || 900), H = +(args.h || 900);
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/404/.test(m.text())) errors.push(m.text()); });

  await page.goto(args.url || 'http://localhost:5173/', { waitUntil: 'networkidle' });
  try {
    await page.waitForFunction(() => !!globalThis.__game, null, { timeout: 25000 });
  } catch (e) {
    console.error('\n=== PAGE ERRORS ===');
    for (const m of [...new Set(errors)]) console.error(m);
    await browser.close();
    process.exit(1);
  }
  // The grab table lives in a module; hoist it onto globalThis once.
  await page.evaluate(async () => {
    const m = await import('/src/tricks/trickTable.js');
    globalThis.__GRABTABLE = m.GRAB_TABLE;
  });
  await page.evaluate(() => { document.getElementById('ui-root').style.display = 'none'; });

  const opt = { z: +(args.z ?? -1400) };
  const wait = +(args.wait ?? 2.2);

  const draw = async (out, camCfg) => {
    await page.evaluate((c) => {
      const g = globalThis.__game;
      const T = g.THREE;
      globalThis.__charForce?.();
      g.rider.update(1 / 60, g.body, g.tricks);
      const cam = g.engine.camera;
      const a = c.az * Math.PI / 180, e = c.el * Math.PI / 180;
      const centre = new T.Vector3().copy(g.body.pos).add(new T.Vector3(0, c.h, 0));
      cam.position.set(
        centre.x + Math.sin(a) * Math.cos(e) * c.d,
        centre.y + Math.sin(e) * c.d,
        centre.z + Math.cos(a) * Math.cos(e) * c.d,
      );
      cam.up.set(0, 1, 0);
      cam.fov = c.fov; cam.updateProjectionMatrix();
      cam.lookAt(centre);
      g.mountain.update(cam.position);
      g.engine.renderer.setRenderTarget(null);
      g.engine.renderer.render(g.engine.scene, cam);
    }, camCfg);
    mkdirSync(dirname(out), { recursive: true });
    await page.screenshot({ path: out });
    console.log('wrote', out);
  };

  const cam = {
    d: +(args.dist ?? 3.4),
    az: +(args.az ?? 128),
    el: +(args.el ?? 12),
    h: +(args.h ?? 0.95),
    fov: +(args.fov ?? 34),
  };

  if (args.sheet) {
    for (const [name, p] of Object.entries(POSES)) {
      await setup(page, p, opt);
      await page.waitForTimeout(wait * 1000);
      await draw(`${args.sheet}/${name}.png`, cam);
    }
  } else if (args.turntable) {
    const p = POSES[args.pose || 'ride'];
    await setup(page, p, opt);
    await page.waitForTimeout(wait * 1000);
    for (let i = 0; i < 8; i++) {
      await draw(`${args.dir || 'shots/char/tt'}/${String(i).padStart(2, '0')}.png`, { ...cam, az: i * 45 });
    }
  } else {
    const p = POSES[args.pose || 'ride'] || POSES.ride;
    await setup(page, p, opt);
    await page.waitForTimeout(wait * 1000);
    await draw(args.out || 'shots/char/pose.png', cam);
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
