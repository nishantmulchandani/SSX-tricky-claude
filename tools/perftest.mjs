#!/usr/bin/env node
/**
 * CPU cost of the terrain path, measured without a browser.
 *
 * The terrain mesh is rebuilt on the CPU every time the camera crosses a snap
 * cell, and every vertex costs a heightAt(). At speed that can happen every
 * frame, so this is the first place to look for a frame-rate problem.
 *
 *   node tools/perftest.mjs
 */
import * as THREE from 'three';
import { heightAt, courseXAt, courseAt } from '../src/world/terrain.js';
import { Mountain } from '../src/world/mountain.js';

const bench = (name, iters, fn) => {
  fn(0); // warm
  const t0 = performance.now();
  let sink = 0;
  for (let i = 0; i < iters; i++) sink += fn(i);
  const t1 = performance.now();
  const ns = ((t1 - t0) / iters) * 1e6;
  console.log(`  ${name.padEnd(16)} ${ns.toFixed(0).padStart(6)} ns/call   (${(t1 - t0).toFixed(0)}ms / ${iters.toLocaleString()})`);
  return { ns, sink };
};

console.log('=== TERRAIN CPU COST ===\n');
const N = 200000;
const h = bench('heightAt', N, (i) => heightAt((i % 500) - 250, -1400 - (i % 900)));
bench('courseXAt', N, (i) => courseXAt(-1400 - (i % 900)));
bench('courseAt', N, (i) => courseAt((i % 900) / 900).width);

console.log('\n=== MESH: STEADY-STATE COST WHILE RIDING ===\n');
// Rings re-sample at their own rate and the work is capped per call, so the
// only meaningful figure is the average cost per frame while actually moving.
const m = new Mountain();
const c = new THREE.Vector3(0, 0, -1000);
for (let i = 0; i < 900; i++) m.update(c);      // let every ring settle
console.log(`  vertices         ${m.geometry.attributes.position.count.toLocaleString()}`);
console.log(`  per-call budget  ${m.vertexBudget.toLocaleString()} vertices\n`);
console.log('  60 fps budget is 16.7 ms for EVERYTHING.\n');

let worst = 0;
for (const speed of [20, 40, 60]) {
  const dt = 1 / 60, frames = 900;
  const t0 = performance.now();
  for (let f = 0; f < frames; f++) { c.z -= speed * dt; m.update(c); }
  const per = (performance.now() - t0) / frames;
  worst = Math.max(worst, per);
  console.log(`  at ${String(speed).padStart(2)} m/s: ${per.toFixed(2)} ms/frame`
    + `  (${(per / 16.7 * 100).toFixed(0)}% of a 60fps frame)`);
}
console.log(`\n  Worst case ${(worst / 16.7 * 100).toFixed(0)}% of a frame.`);
console.log('  Anything over ~30% here leaves too little for everything else.');
process.exit(worst > 16.7 * 0.35 ? 1 : 0);
