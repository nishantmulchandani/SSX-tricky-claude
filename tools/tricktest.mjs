#!/usr/bin/env node
/**
 * Exercises the trick system against the real physics, headlessly.
 *
 * The trick system was written by an agent that was cut off before it could
 * test anything, so this asserts the basics actually work end to end: airs are
 * detected, spins are counted and named, grabs register, landings are judged,
 * combos accumulate and the boost meter fills.
 *
 *   node tools/tricktest.mjs
 */
import { BoardPhysics } from '../src/physics/board.js';
import { TrickSystem } from '../src/tricks/trickSystem.js';
import { heightAt, courseXAt, courseWidthAt, courseFeatures } from '../src/world/terrain.js';

const JUMPS = courseFeatures()
  .filter((f) => f.type === 'kicker' || f.type === 'table' || f.type === 'hip')
  .sort((a, b) => b.z - a.z);

/** Distance to the next takeoff lip ahead, or Infinity. */
function toNextLip(z) {
  for (const f of JUMPS) if (f.z < z - 2) return z - f.z;
  return Infinity;
}

/**
 * How far the rider is above the snow. Used by the scripted "player" to spot
 * the landing — holding a grab or a spin all the way to touchdown is an
 * intentional bail in this trick system, so a test that never lets go is
 * testing a bad player, not the system.
 */
function altitude(body) {
  return body.pos.y - heightAt(body.pos.x, body.pos.z);
}
import { FIXED_DT as DT } from '../src/core/engine.js';

/** Minimal stand-in for src/core/input.js with scriptable actions. */
class FakeInput {
  constructor() { this.actions = {}; this.pressed = {}; this.released = {}; this.axis = { steer: 0, pitch: 0 }; }
  down(a) { return !!this.actions[a]; }
  justPressed(a) { return !!this.pressed[a]; }
  justReleased(a) { return !!this.released[a]; }
  set(a, v) {
    if (v && !this.actions[a]) this.pressed[a] = true;
    if (!v && this.actions[a]) this.released[a] = true;
    this.actions[a] = v;
  }
  endFrame() { this.pressed = {}; this.released = {}; }
}

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? ' PASS' : ' FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

/**
 * Drive the rider off a known kicker.
 * @param script called every step with (t, ctx) to set inputs
 */
function run({ startZ = -440, seconds = 12, script = () => {}, stopWhen = null }) {
  const body = new BoardPhysics();
  const tricks = new TrickSystem();
  const input = new FakeInput();
  body.reset(startZ);
  body.vel.set(0, 0, -42);           // arrive with real speed

  const log = { maxAir: 0, airStart: null, airs: [], landed: false, names: [], events: [], maxYaw: 0, maxBoost: 0, phases: new Set() };
  let t = 0;

  for (let i = 0; i < Math.round(seconds / DT); i++) {
    // Hold the racing line. Negative because positive steer turns right:
    // sitting right of the centre line means steering left to get back.
    // Normalised by the track half-width so this stays correct if the course
    // is ever re-tuned — a fixed per-metre gain silently became too weak to
    // hold the line when the ribbon was narrowed.
    const cx = courseXAt(body.pos.z);
    const half = Math.max(8, courseWidthAt(body.pos.z) * 0.5);
    const lat = (body.pos.x - cx) / half;
    // Clamped fairly tight. Takeoff samples the stick to decide spin, so a
    // scripted rider holding a hard corrective carve into every lip launches
    // into an unplanned rotation and bails — which is correct behaviour, but
    // it means the test would be measuring a bad player rather than the
    // trick system.
    // Hold the line firmly, but settle the stick on the approach to a lip.
    // Takeoff samples the stick to decide spin, so a rider still hauling on a
    // corrective carve as they leave the ramp launches into an unplanned
    // rotation and bails. Real players straighten up before a jump; a test
    // driver that does not is measuring itself, not the trick system.
    const lip = toNextLip(body.pos.z);
    const settle = lip < 26 ? 0.18 : 1.0;
    input.axis.steer = Math.max(-0.6, Math.min(0.6,
      -(lat * 0.9 + body.vel.x * 0.05))) * settle;
    input.axis.pitch = -1;
    script(t, { body, tricks, input });

    const intent = tricks.fixedUpdate(DT, input, body);
    body.step(DT, {
      steer: intent.steer, pitch: intent.pitch,
      jumpHeld: input.down('jump'), jumpReleased: input.justReleased('jump'), brake: false,
    });
    input.endFrame();

    // Track each air segment separately — carrying airStart across a landing
    // would report the whole run as one enormous air.
    if (!body.grounded) {
      if (log.airStart === null) log.airStart = t;
      log.maxAir = Math.max(log.maxAir, t - log.airStart);
    } else if (log.airStart !== null) {
      log.airs.push(t - log.airStart);
      log.airStart = null;
      log.landed = true;
    }
    log.maxYaw = Math.max(log.maxYaw, Math.abs(tricks.rotation?.yaw ?? 0));
    log.maxBoost = Math.max(log.maxBoost, tricks.scorer?.boost ?? 0);
    log.phases.add(tricks.phase);
    if (tricks.current && !log.names.includes(tricks.current)) log.names.push(tricks.current);
    for (const e of tricks.events || []) {
      const k = JSON.stringify(e);
      if (!log.events.includes(k)) log.events.push(k);
    }
    t += DT;
    if (stopWhen && stopWhen(tricks, body)) break;
  }
  return { body, tricks, log };
}

console.log('=== TRICK SYSTEM TEST ===\n');

// 0. Control polarity. This is worth asserting on its own: the steer sign was
//    inverted for a long time — pressing right turned the rider left — and it
//    went unnoticed because the AI and every test driver were written against
//    the inverted convention and silently cancelled it out.
{
  const b = new BoardPhysics();
  b.reset(-1000);
  b.vel.set(0, 0, -30);
  const x0 = b.pos.x;
  for (let i = 0; i < 180; i++) {
    b.step(DT, { steer: 1, pitch: -1, jumpHeld: false, jumpReleased: false, brake: false });
  }
  const drift = b.pos.x - x0;
  check('steering right moves the rider right (+X)', drift > 1, `drift ${drift.toFixed(1)}m`);

  const b2 = new BoardPhysics();
  b2.reset(-1000);
  b2.vel.set(0, 0, -30);
  const x1 = b2.pos.x;
  for (let i = 0; i < 180; i++) {
    b2.step(DT, { steer: -1, pitch: -1, jumpHeld: false, jumpReleased: false, brake: false });
  }
  const drift2 = b2.pos.x - x1;
  check('steering left moves the rider left (-X)', drift2 < -1, `drift ${drift2.toFixed(1)}m`);
}

// 1. Baseline: a straight run off a kicker should produce air and land clean.
{
  const { tricks, log } = run({ startZ: -440, seconds: 10 });
  check('rider gets airborne off the z=-520 kicker', log.maxAir > 0.4, `max air ${log.maxAir.toFixed(2)}s over ${log.airs.length} airs`);
  check('system survives a full air/land cycle without throwing', true);
  check('landing resolves (not stuck in air phase)', tricks.phase !== 'air', `phase=${tricks.phase}`);
}

// 2. Spin: wind up on the ground, hold the spin through the air, spot the
//    landing. Run it over the section with real kickers — one small lip gives
//    too little air to accumulate a countable rotation, and the wind-up needs a
//    definite stick direction or it latches no spin direction at all.
{
  const { tricks, log } = run({
    startZ: -960, seconds: 25,
    script: (t, { body, input }) => {
      const spotting = body.vel.y < 0 && altitude(body) < 6;
      if (body.grounded) {
        input.set('prewind', true);
        input.axis.steer = 0.85;          // wind-up needs a direction
      } else {
        input.set('prewind', false);
        input.set('spinR', !spotting);
      }
    },
  });
  // rotation.yaw is cleared when the trick resolves, so assert on the peak.
  const spun = log.maxYaw * (180 / Math.PI);
  check('spin input produces yaw rotation', spun > 90, `peak ${spun.toFixed(0)} deg`);
  const named = log.names.filter((n) => /\d{3,4}/.test(n));
  check('a rotation trick gets named with a degree count', named.length > 0, named.slice(0, 3).join(', ') || 'none');
}

// 3. Grab: hold a grab through the air and let go to land it.
{
  const { tricks, log } = run({
    startZ: -960, seconds: 25,
    script: (t, { body, input }) => {
      const spotting = body.vel.y < 0 && altitude(body) < 6;
      input.set('grab1', !body.grounded && body.airTime > 0.15 && !spotting);
    },
  });
  const grabNames = log.names.filter((n) => n && n !== 'Straight Air');
  check('grab input registers a named grab trick', grabNames.length > 0, grabNames.slice(0, 3).join(', ') || 'none');
}

// 4. Scoring and combo across several features.
{
  const { tricks, log } = run({
    startZ: -960, seconds: 40,
    script: (t, { body, input }) => {
      // Spot the landing: stop spinning and let go of the grab on the way down.
      const spotting = body.vel.y < 0 && altitude(body) < 6;
      input.set('prewind', body.grounded);
      input.set('spinR', !body.grounded && !spotting);
      input.set('grab2', !body.grounded && body.airTime > 0.25 && !spotting);
    },
  });
  // Cash the chain first — the same thing the finish line does. Points sit in
  // `pending` until a chain ends, so asserting on `score` mid-combo is testing
  // the wrong number.
  tricks.bankAll();
  check('score accumulates over a multi-feature run', tricks.score > 0, `score=${Math.round(tricks.score)}`);
  // Assert on the PEAK, not the final value: the meter drains continuously, so
  // a long run with one early trick legitimately ends at zero.
  const landed = (tricks.tricks?.length ?? 0) > 0;
  check('boost meter fills from landed tricks',
    !landed || log.maxBoost > 0,
    `landed=${tricks.tricks?.length ?? 0} peak boost=${log.maxBoost.toFixed(3)}`);
  check('tricks are recorded in the log', (tricks.tricks?.length ?? 0) > 0, `${tricks.tricks?.length ?? 0} entries`);
  check('combo multiplier is at least 1', tricks.combo >= 1, `x${tricks.combo}`);
  console.log('\n  [diag] phases seen:', [...log.phases].join(', '));
  console.log('  [diag] peak yaw:', (log.maxYaw * 180 / Math.PI).toFixed(0), 'deg');
  console.log('  [diag] names:', log.names.slice(0, 8).join(' | ') || 'none');
  console.log('  [diag] events:', log.events.slice(0, 8).join(' ') || 'none');
  console.log('  [diag] scorer:', JSON.stringify({ score: tricks.scorer?.score, banked: tricks.scorer?.bankedCount, mult: tricks.scorer?.multiplier, boost: tricks.scorer?.boost }));
}

// 5. Finishing a run must bank the chain still in progress.
{
  // Stop the run the instant a landed trick is sitting in the chain, which is
  // exactly the state a player is in when they cross the finish line.
  const { tricks } = run({
    startZ: -960, seconds: 40,
    stopWhen: (tr) => (tr.scorer?.pending ?? 0) > 0,
    script: (t, { body, input }) => {
      const spotting = body.vel.y < 0 && altitude(body) < 6;
      input.set('prewind', body.grounded);
      input.set('spinR', !body.grounded && !spotting);
      input.set('grab2', !body.grounded && body.airTime > 0.25 && !spotting);
    },
  });
  const pendingBefore = tricks.scorer?.pending ?? 0;
  check('a chain is actually pending when the run is cut short', pendingBefore > 0,
    `pending=${Math.round(pendingBefore)}`);
  const scoreBefore = tricks.score;
  const banked = tricks.bankAll();
  check('bankAll() cashes an in-progress chain', banked > 0,
    `pending=${Math.round(pendingBefore)} banked=${Math.round(banked)}`);
  check('score never decreases when a run is banked', tricks.score >= scoreBefore,
    `${Math.round(scoreBefore)} -> ${Math.round(tricks.score)}`);
  check('nothing is left pending after banking', (tricks.scorer?.pending ?? 0) === 0);
}

// 6. Reset must fully clear state.
{
  const { tricks } = run({ startZ: -960, seconds: 20, script: (t, { body, input }) => {
    const spotting = body.vel.y < 0 && altitude(body) < 6;
    input.set('prewind', body.grounded);
    input.set('spinR', !body.grounded && !spotting);
  } });
  tricks.reset();
  check('reset clears score', tricks.score === 0, `score=${tricks.score}`);
  check('reset clears boost', tricks.boost === 0, `boost=${tricks.boost}`);
  check('reset clears the trick log', (tricks.tricks?.length ?? 0) === 0);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log(`RESULT: ${failed.length ? 'FAIL' : 'PASS'}`);
process.exit(failed.length ? 1 : 0);
