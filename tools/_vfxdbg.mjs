import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH,
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
p.on('pageerror', e => console.log('PAGEERROR:', String(e)));
await p.goto('http://localhost:5173/', { waitUntil: 'load' });
await p.waitForFunction(() => !!globalThis.__game, null, { timeout: 30000 });
const out = await p.evaluate(async () => {
  const g = globalThis.__game;
  g.run.beginCountdown(); g.run.state='riding'; g.run.countdown=0;
  // Pick a flat-ish stretch and hold a hard ground carve.
  g.body.reset(-2100); g.body.vel.set(0,0,-40); g.chase.snap(g.body);
  const sys = g.engine.systems.find(s => s.fixedUpdate);
  const DT = 1/120;
  const samples = [];
  for (let i=0;i<Math.round(2/DT);i++){
    g.input.actions.right = true;
    g.input.actions.tuck = true;
    sys.fixedUpdate(DT, i*DT);
    if (i % 2 === 0) sys.update(DT*2, 0, i*DT);
    if (i % 120 === 0) samples.push({
      t:+(i*DT).toFixed(1), grounded:g.body.grounded,
      edge:+g.body.edge.toFixed(2), speed:+g.body.speed.toFixed(1),
      phase:g.tricks.phase,
    });
  }
  const v = g.vfx;
  const pools = {};
  for (const k of Object.keys(v)) {
    const o = v[k];
    if (o && typeof o === 'object' && 'head' in o && 'count' in o) {
      pools[k] = { count:o.count, head:o.head, full:!!o._full };
    }
  }
  return { samples, pools, vfxKeys:Object.keys(v), enabled:v.enabled,
           rootChildren: v.root?.children?.length ?? null,
           rootInScene: !!(v.root && v.root.parent) };
});
console.log(JSON.stringify(out,null,2));
await b.close();
