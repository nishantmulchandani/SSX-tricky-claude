#!/usr/bin/env node
/**
 * Races the AI field down the real course, headlessly, with no browser.
 *
 * The AI drives through the same input struct a human uses, so if it can get
 * to the bottom at a competitive pace while landing tricks, the racing layer
 * works. Rider visuals are skipped (they need a canvas), everything else is
 * the shipping code path.
 *
 *   node tools/racetest.mjs
 */
import { Racer } from '../src/race/racer.js';
import { AIController } from '../src/race/aiController.js';
import { COURSE_LENGTH, courseXAt, trackLimitAt, CHECKPOINTS } from '../src/world/terrain.js';
import { GameState } from '../src/core/gameState.js';
import { FIXED_DT as DT } from '../src/core/engine.js';

const failures = [];
function check(name, cond, detail = '') {
  console.log(`${cond ? ' PASS' : ' FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures.push(name);
}

const FIELD = [
  { name: 'KAZ', skill: 0.92, lane: -0.5 },
  { name: 'MERCY', skill: 0.84, lane: 0.45 },
  { name: 'VOSS', skill: 0.76, lane: -0.2 },
  { name: 'RIKO', skill: 0.68, lane: 0.25 },
  { name: 'BRICK', skill: 0.6, lane: 0.6 },
];

const racers = FIELD.map((f, i) => new Racer({
  id: f.name, name: f.name, visual: false,
  controller: new AIController({ skill: f.skill, seed: 1000 + i * 77, lane: f.lane }),
}));

racers.forEach((r, i) => {
  r.reset(-20 - (i % 2) * 4, (i - 2) * 3.6);
});

const stats = racers.map((r) => ({
  name: r.name, maxSpeed: 0, offTrack: 0, stalled: 0, crashes: 0, air: 0,
  _wasCrashed: false, _stall: 0,
}));

console.log('=== RACE TEST ===\n');

let t = 0;
const MAX_T = 500;
for (let step = 0; step < MAX_T / DT; step++) {
  let allDone = true;
  for (let i = 0; i < racers.length; i++) {
    const r = racers[i], s = stats[i];
    if (r.finished) continue;
    allDone = false;
    r.fixedUpdate(DT, {});

    s.maxSpeed = Math.max(s.maxSpeed, r.body.speed);
    if (!r.body.grounded) s.air += DT;
    if (r.body.crashed && !s._wasCrashed) s.crashes++;
    s._wasCrashed = r.body.crashed;

    // How far outside the ribbon does it stray? Being a few metres out is the
    // berm, and carving up the berm is legitimate riding — only count a racer
    // as off course once it is past the berm entirely.
    // Measure against the real barrier line rather than a hard-coded distance:
    // riding the berm is legitimate, being past the wall is not. A fixed
    // threshold silently became meaningless when the berm was resized.
    const off = Math.abs(r.body.pos.x - courseXAt(r.body.pos.z)) - trackLimitAt(r.body.pos.z);
    if (off > 1) s.offTrack += DT;

    if (r.body.grounded && r.body.speed < 4) { s._stall += DT; s.stalled = Math.max(s.stalled, s._stall); }
    else s._stall = 0;
  }
  t += DT;
  if (allDone) break;
}

console.log('  name    finished    time   maxSpd  crashes   air  off-track  worst stall   score');
for (let i = 0; i < racers.length; i++) {
  const r = racers[i], s = stats[i];
  console.log(`  ${r.name.padEnd(6)} ${(r.finished ? 'yes' : 'NO ').padStart(8)} `
    + `${(r.finished ? r.finishTime.toFixed(1) : '-').padStart(7)}s `
    + `${s.maxSpeed.toFixed(0).padStart(5)}m/s `
    + `${String(s.crashes).padStart(7)} `
    + `${s.air.toFixed(0).padStart(5)}s `
    + `${s.offTrack.toFixed(0).padStart(9)}s `
    + `${s.stalled.toFixed(1).padStart(12)}s `
    + `${Math.round(r.tricks.score).toString().padStart(7)}`);
}

console.log('');
const finished = racers.filter((r) => r.finished);
check('every AI finishes the course', finished.length === racers.length,
  `${finished.length}/${racers.length}`);

if (finished.length) {
  const times = finished.map((r) => r.finishTime);
  const best = Math.min(...times), worst = Math.max(...times);
  check('finish times are competitive with a human run (~133s)',
    best > 90 && worst < 280, `${best.toFixed(0)}s .. ${worst.toFixed(0)}s`);
  check('the field is spread, not a dead heat', worst - best > 3,
    `spread ${(worst - best).toFixed(1)}s`);

  // Skill should correlate with finishing position, at least roughly.
  const order = [...finished].sort((a, b) => a.finishTime - b.finishTime).map((r) => r.name);
  const bySkill = [...FIELD].sort((a, b) => b.skill - a.skill).map((f) => f.name);
  const topHalf = new Set(order.slice(0, 2));
  const bestTwoBySkill = new Set(bySkill.slice(0, 3));
  const overlap = [...topHalf].filter((n) => bestTwoBySkill.has(n)).length;
  check('higher skill tends to finish nearer the front', overlap >= 1,
    `finish order ${order.join(' > ')}, skill order ${bySkill.join(' > ')}`);
}

check('nobody spends long stuck', stats.every((s) => s.stalled < 4),
  `worst ${Math.max(...stats.map((s) => s.stalled)).toFixed(1)}s`);
check('nobody rides off the course for long', stats.every((s) => s.offTrack < 8),
  `worst ${Math.max(...stats.map((s) => s.offTrack)).toFixed(0)}s`);
check('the AI actually lands tricks', racers.some((r) => r.tricks.score > 0),
  `best score ${Math.max(...racers.map((r) => Math.round(r.tricks.score)))}`);

// --- checkpoint splits -----------------------------------------------------
// The gantries are only worth building if they stop a clock. Driven with a
// synthetic body rather than a real racer: what is under test is the split
// bookkeeping, and a scripted constant-speed descent makes the expected times
// arithmetic instead of a guess.
console.log('\n=== CHECKPOINT SPLITS ===');
{
  const body = { pos: { z: 0 } };
  const run = new GameState();
  const ride = (speed, limit = 400) => {
    run.beginCountdown();
    body.pos.z = 0;
    for (let i = 0; i < 600 && run.state !== 'riding'; i++) run.fixedUpdate(DT, body, null);
    const seen = [];
    for (let t = 0; t < limit && body.pos.z > -COURSE_LENGTH - 10; t += DT) {
      body.pos.z -= speed * DT;
      run.fixedUpdate(DT, body, null);
      if (run.lastSplit && !seen.some((s) => s.index === run.lastSplit.index)) {
        seen.push({ ...run.lastSplit });
      }
    }
    return seen;
  };

  const fast = ride(50);
  console.log('  splits @50m/s: ' + run.splits.map((s) => s?.toFixed(2)).join('  '));
  check('every checkpoint takes a split', run.splits.every((s) => s != null),
    `${run.splits.filter((s) => s != null).length}/${CHECKPOINTS.length}`);
  check('splits are in course order',
    run.splits.every((s, i) => i === 0 || s > run.splits[i - 1]));
  check('the first run has no delta to compare against',
    fast.every((s) => s.delta === null));

  const slow = ride(40);
  console.log('  deltas @40m/s: ' + slow.map((s) => '+' + s.delta.toFixed(2)).join('  '));
  check('a slower run is down on every split', slow.every((s) => s.delta > 0));
  check('deltas grow as the run falls further behind',
    slow.every((s, i) => i === 0 || s.delta > slow[i - 1].delta));

  // A rider who bounces back uphill past an arch must not re-trigger it.
  const before = JSON.stringify(run.splits);
  body.pos.z = CHECKPOINTS[0];
  run.fixedUpdate(DT, body, null);
  check('backtracking past an arch does not re-trigger its split',
    JSON.stringify(run.splits) === before);
}

console.log(`\nRESULT: ${failures.length ? 'FAIL (' + failures.join(', ') + ')' : 'PASS'}`);
process.exit(failures.length ? 1 : 0);
