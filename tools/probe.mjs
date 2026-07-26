#!/usr/bin/env node
/** Dumps live engine state — used to debug what the camera is actually seeing. */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
page.on('console', (m) => console.log('CONSOLE', m.type(), m.text()));
await page.goto(process.env.URL || 'http://localhost:5173/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!globalThis.__game, null, { timeout: 30000 });
await page.evaluate((z) => {
  const g = globalThis.__game;
  g.run?.beginCountdown?.();
  if (g.run) { g.run.state = 'riding'; g.run.countdown = 0; }
  g.body.reset(z);
}, +(process.argv[2] || -800));
await page.waitForTimeout(3000);

const info = await page.evaluate(() => {
  const g = globalThis.__game;
  const cam = g.engine.camera;
  const m = g.mountain;
  const pos = m.geometry.attributes.position.array;
  let minY = Infinity, maxY = -Infinity;
  for (let i = 1; i < pos.length; i += 3) { if (pos[i] < minY) minY = pos[i]; if (pos[i] > maxY) maxY = pos[i]; }
  const box = new (g.engine.scene.constructor === Object ? Object : Object)();
  return {
    camPos: cam.position.toArray().map(n => +n.toFixed(1)),
    camFov: +cam.fov.toFixed(1),
    camNearFar: [cam.near, cam.far],
    look: g.chase.look.toArray().map(n => +n.toFixed(1)),
    riderPos: g.body.pos.toArray().map(n => +n.toFixed(1)),
    riderSpeed: +g.body.speed.toFixed(1),
    grounded: g.body.grounded,
    terrainYRange: [+minY.toFixed(1), +maxY.toFixed(1)],
    terrainCenter: m._center ? m._center.toArray().map(n => +n.toFixed(1)) : null,
    meshVisible: m.mesh.visible,
    vertCount: m.geometry.attributes.position.count,
    idxCount: m.geometry.index.count,
    sceneChildren: g.engine.scene.children.map(c => c.name || c.type),
    drawCalls: g.engine.renderer.info.render.calls,
    triangles: g.engine.renderer.info.render.triangles,
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
