#!/usr/bin/env node
/**
 * Simulates a full run down the course with the real physics and terrain, with
 * no browser. Reports the speed/air-time profile and flags anything that would
 * ruin the ride: dead stops, absurd launches, walls in the fall line.
 *
 *   node tools/ridetest.mjs [--steer auto|0] [--verbose]
 */
import { BoardPhysics } from '../src/physics/board.js';
import { heightAt, courseXAt, courseWidthAt, COURSE_LENGTH, courseFeatures } from '../src/world/terrain.js';
import { FIXED_DT } from '../src/core/engine.js';

const verbose = process.argv.includes('--verbose');

const body = new BoardPhysics();
body.reset(-20);

const samples = [];
let airEvents = [];
let currentAir = null;
let maxSpeed = 0, maxSpeedAt = null, minMovingSpeed = Infinity;
let stuckFor = 0, worstStuck = 0, worstStuckAt = null;
let t = 0;

for (let i = 0; i < 120 * 400; i++) { // up to 400 simulated seconds
  // Steer back towards the course centre like a competent player. Correction
  // is scaled to the track width, so a narrow section does not make this
  // oversteer and scrub away all its speed.
  const cx = courseXAt(body.pos.z);
  const half = Math.max(8, courseWidthAt(body.pos.z) * 0.5);
  const err = (body.pos.x - cx) / half;
  const steer = Math.max(-0.6, Math.min(0.6, err * 0.9 + body.vel.x * 0.05));

  body.step(FIXED_DT, {
    steer,
    pitch: -1,              // held in a tuck
    jumpHeld: false,
    jumpReleased: false,
    brake: false,
  });
  t += FIXED_DT;

  if (!body.grounded && !currentAir) currentAir = { z: body.pos.z, start: t, peak: body.pos.y };
  if (!body.grounded && currentAir) currentAir.peak = Math.max(currentAir.peak, body.pos.y);
  if (body.grounded && currentAir) {
    currentAir.dur = t - currentAir.start;
    if (currentAir.dur > 0.25) airEvents.push(currentAir);
    currentAir = null;
  }

  if (body.speed > maxSpeed) { maxSpeed = body.speed; maxSpeedAt = { z: body.pos.z, air: !body.grounded }; }
  if (body.grounded) {
    if (body.speed < 4) {
      stuckFor += FIXED_DT;
      if (stuckFor > worstStuck) { worstStuck = stuckFor; worstStuckAt = { z: body.pos.z, x: body.pos.x, cx }; }
    }
    else { stuckFor = 0; minMovingSpeed = Math.min(minMovingSpeed, body.speed); }
  }

  if (i % 120 === 0) {
    samples.push({ t: +t.toFixed(1), z: Math.round(body.pos.z), y: Math.round(body.pos.y), spd: +body.speed.toFixed(1), air: !body.grounded });
  }
  if (body.pos.z <= -COURSE_LENGTH) break;
}

const finished = body.pos.z <= -COURSE_LENGTH;
console.log('=== RIDE TEST ===');
console.log(`finished:        ${finished ? 'yes' : 'NO — stalled at z=' + Math.round(body.pos.z)}`);
console.log(`run time:        ${t.toFixed(1)}s`);
console.log(`max speed:       ${maxSpeed.toFixed(1)} m/s  (${(maxSpeed * 3.6).toFixed(0)} km/h) at z=${Math.round(maxSpeedAt.z)} ${maxSpeedAt.air ? '(airborne)' : '(on snow)'}`);
console.log(`min moving spd:  ${minMovingSpeed === Infinity ? 'n/a' : minMovingSpeed.toFixed(1)} m/s`);
console.log(`longest stall:   ${worstStuck.toFixed(2)}s`
  + (worstStuckAt ? ` at z=${Math.round(worstStuckAt.z)} x=${worstStuckAt.x.toFixed(1)} (course centre ${worstStuckAt.cx.toFixed(1)}, offset ${(worstStuckAt.x - worstStuckAt.cx).toFixed(1)}m)` : ''));
console.log(`air events:      ${airEvents.length}`);

const big = airEvents.filter((a) => a.dur > 0.6).sort((a, b) => b.dur - a.dur);
console.log(`  airs > 0.6s:   ${big.length}`);
for (const a of big.slice(0, 12)) {
  console.log(`   z=${Math.round(a.z).toString().padStart(6)}  ${a.dur.toFixed(2)}s`);
}
const insane = airEvents.filter((a) => a.dur > 6);
if (insane.length) console.log(`  !! ${insane.length} airs longer than 6s — launch ramps are too aggressive`);

if (verbose) {
  console.log('\n t     z      y     spd  air');
  for (const s of samples) console.log(`${String(s.t).padStart(5)} ${String(s.z).padStart(6)} ${String(s.y).padStart(5)} ${String(s.spd).padStart(6)} ${s.air ? 'AIR' : ''}`);
}

// --- static check: does any authored feature present an unrideable wall? ----
console.log('\n=== FEATURE GRADIENT CHECK ===');
let bad = 0;
for (const f of courseFeatures()) {
  const cx = courseXAt(f.z);
  let steepest = 0, at = 0;
  for (let s = -20; s <= f.len + 20; s += 0.5) {
    const z = f.z + s;
    const g = (heightAt(cx + (f.off || 0), z - 0.5) - heightAt(cx + (f.off || 0), z + 0.5)) / 1.0;
    // Positive g = ground rising as the rider advances (into the hill).
    if (g > steepest) { steepest = g; at = s; }
  }
  const deg = (Math.atan(steepest) * 180) / Math.PI;
  const flag = deg > 45 ? '  <-- TOO STEEP, rider will slam into it' : '';
  if (deg > 45) bad++;
  console.log(`${f.type.padEnd(8)} z=${String(f.z).padStart(6)}  max uphill grade ${deg.toFixed(0)}deg at s=${at.toFixed(1)}${flag}`);
}
console.log(bad ? `\n${bad} feature(s) need flattening.` : '\nAll features rideable.');

const ok = finished && worstStuck < 1.5 && !insane.length && !bad;
console.log(`\nRESULT: ${ok ? 'PASS' : 'FAIL'}`);
process.exit(ok ? 0 : 1);
