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
import { heightAt, courseXAt } from '../src/world/terrain.js';

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
function run({ startZ = -440, seconds = 12, script = () => {} }) {
  const body = new BoardPhysics();
  const tricks = new TrickSystem();
  const input = new FakeInput();
  body.reset(startZ);
  body.vel.set(0, 0, -42);           // arrive with real speed

  const log = { maxAir: 0, airStart: null, airs: [], landed: false, names: [], events: [], maxYaw: 0, phases: new Set() };
  let t = 0;

  for (let i = 0; i < Math.round(seconds / DT); i++) {
    const cx = courseXAt(body.pos.z);
    input.axis.steer = Math.max(-1, Math.min(1, (body.pos.x - cx) * 0.02 + body.vel.x * 0.05));
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
    log.phases.add(tricks.phase);
    if (tricks.current && !log.names.includes(tricks.current)) log.names.push(tricks.current);
    for (const e of tricks.events || []) {
      const k = JSON.stringify(e);
      if (!log.events.includes(k)) log.events.push(k);
    }
    t += DT;
  }
  return { body, tricks, log };
}

console.log('=== TRICK SYSTEM TEST ===\n');

// 1. Baseline: a straight run off a kicker should produce air and land clean.
{
  const { tricks, log } = run({ startZ: -440, seconds: 10 });
  check('rider gets airborne off the z=-520 kicker', log.maxAir > 0.4, `max air ${log.maxAir.toFixed(2)}s over ${log.airs.length} airs`);
  check('system survives a full air/land cycle without throwing', true);
  check('landing resolves (not stuck in air phase)', tricks.phase !== 'air', `phase=${tricks.phase}`);
}

// 2. Spin: hold a spin input through the air and expect a named rotation trick.
{
  const { tricks, log } = run({
    startZ: -440, seconds: 10,
    script: (t, { body, input }) => {
      input.set('prewind', body.grounded && body.pos.z > -530);
      input.set('spinR', !body.grounded);
    },
  });
  // rotation.yaw is cleared when the trick resolves, so assert on the peak.
  const spun = log.maxYaw * (180 / Math.PI);
  check('spin input produces yaw rotation', spun > 90, `peak ${spun.toFixed(0)} deg`);
  const named = log.names.filter((n) => /\d{3,4}/.test(n));
  check('a rotation trick gets named with a degree count', named.length > 0, named.slice(0, 3).join(', ') || 'none');
}

// 3. Grab: hold a grab through the air.
{
  const { tricks, log } = run({
    startZ: -440, seconds: 10,
    script: (t, { body, input }) => { input.set('grab1', !body.grounded); },
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
  check('score accumulates over a multi-feature run', tricks.score > 0, `score=${Math.round(tricks.score)}`);
  check('boost meter fills from landed tricks', tricks.boost > 0, `boost=${tricks.boost.toFixed(2)}`);
  check('tricks are recorded in the log', (tricks.tricks?.length ?? 0) > 0, `${tricks.tricks?.length ?? 0} entries`);
  check('combo multiplier is at least 1', tricks.combo >= 1, `x${tricks.combo}`);
  console.log('\n  [diag] phases seen:', [...log.phases].join(', '));
  console.log('  [diag] peak yaw:', (log.maxYaw * 180 / Math.PI).toFixed(0), 'deg');
  console.log('  [diag] names:', log.names.slice(0, 8).join(' | ') || 'none');
  console.log('  [diag] events:', log.events.slice(0, 8).join(' ') || 'none');
  console.log('  [diag] scorer:', JSON.stringify({ score: tricks.scorer?.score, banked: tricks.scorer?.bankedCount, mult: tricks.scorer?.multiplier, boost: tricks.scorer?.boost }));
}

// 5. Reset must fully clear state.
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
