#!/usr/bin/env node
/**
 * Asserts how the game FEELS, headlessly. These are the things that make a
 * build unplayable while every other test still passes.
 *
 *   - the camera must hold its distance at any speed (POV drift)
 *   - steering must be stable: hands off, the rider tracks the fall line
 *   - steering must not get more twitchy the faster you go
 *   - a plain jump-and-hold-a-direction must produce a named, scored trick
 *
 *   node tools/feeltest.mjs
 */
import * as THREE from 'three';
import { BoardPhysics } from '../src/physics/board.js';
import { TrickSystem } from '../src/tricks/trickSystem.js';
import { ChaseCamera } from '../src/core/camera.js';
import { courseXAt, courseWidthAt } from '../src/world/terrain.js';
import { FIXED_DT as DT } from '../src/core/engine.js';

const failures = [];
function check(name, cond, detail = '') {
  console.log(`${cond ? ' PASS' : ' FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures.push(name);
}

/** Minimal input stand-in matching what TrickSystem reads. */
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

console.log('=== FEEL TEST ===\n');

// ---------------------------------------------------------------------------
// 1. Camera must not drift away from the rider as speed rises.
// ---------------------------------------------------------------------------
{
  const cam = new THREE.PerspectiveCamera(56, 16 / 9, 0.1, 12000);
  const chase = new ChaseCamera(cam);
  const body = new BoardPhysics();
  body.reset(-1200);
  chase.snap(body);

  const samples = [];
  for (const target of [12, 30, 50, 64]) {
    // Settle at this speed, then measure how far the camera sits behind.
    for (let i = 0; i < 600; i++) {
      body.vel.setLength(target);
      body.step(DT, { steer: 0, pitch: -1, jumpHeld: false, jumpReleased: false, brake: false });
      chase.update(DT, body);
    }
    samples.push({ speed: target, dist: chase.pos.distanceTo(body.pos) });
  }
  for (const s of samples) console.log(`   at ${String(s.speed).padStart(2)} m/s: camera ${s.dist.toFixed(2)}m from rider`);

  const dists = samples.map((s) => s.dist);
  const spread = Math.max(...dists) - Math.min(...dists);
  check('camera holds its distance as speed rises', spread < 2.5,
    `spread ${spread.toFixed(2)}m across 12-64 m/s`);
  check('camera never falls a long way behind', Math.max(...dists) < 9,
    `worst ${Math.max(...dists).toFixed(2)}m`);
}

// ---------------------------------------------------------------------------
// 2. Hands off, the rider should track roughly straight down the course.
// ---------------------------------------------------------------------------
// Measuring raw lateral drift here is wrong: the course itself meanders tens of
// metres, so a hands-off rider travelling straight legitimately leaves it. What
// "it drives itself in a different direction" actually means is the board
// turning when you are not asking it to — so assert on heading, not position.
{
  const body = new BoardPhysics();
  body.reset(-1200);
  body.vel.set(0, 0, -40);
  let worstYawErr = 0;
  for (let i = 0; i < 120 * 10; i++) {
    body.step(DT, { steer: 0, pitch: -1, jumpHeld: false, jumpReleased: false, brake: false });
    if (!body.grounded) continue;
    // Heading vs the direction the rider is actually travelling.
    const velYaw = Math.atan2(body.vel.x, -body.vel.z);
    let err = body.yaw - velYaw;
    while (err > Math.PI) err -= Math.PI * 2;
    while (err < -Math.PI) err += Math.PI * 2;
    worstYawErr = Math.max(worstYawErr, Math.abs(err) * (180 / Math.PI));
  }
  check('hands off, the board does not turn itself', worstYawErr < 25,
    `worst heading vs travel ${worstYawErr.toFixed(0)} deg`);
}

// And with a novice-level corrective input, the rider must hold the course.
{
  const body = new BoardPhysics();
  body.reset(-1200);
  body.vel.set(0, 0, -40);
  let worst = 0;
  for (let i = 0; i < 120 * 20; i++) {
    const cx = courseXAt(body.pos.z);
    const half = Math.max(8, courseWidthAt(body.pos.z) * 0.5);
    const lat = (body.pos.x - cx) / half;
    // An ordinary player's correction: proportional to how far off line you
    // are, damped by how fast you are already closing. Pure proportional with
    // no damping is not "clumsy", it is an unstable controller — it saturates,
    // overshoots the far bank and parks there, which tests the controller
    // rather than the game.
    const closing = body.vel.x / Math.max(1, body.speed);
    const steer = Math.max(-0.6, Math.min(0.6, -lat * 0.9 - closing * 0.5));
    body.step(DT, { steer, pitch: -1, jumpHeld: false, jumpReleased: false, brake: false });
    worst = Math.max(worst, Math.abs(body.pos.x - courseXAt(body.pos.z)));
  }
  const half = courseWidthAt(body.pos.z) * 0.5;
  check('a clumsy corrective input is enough to hold the course', worst < half + 12,
    `worst ${worst.toFixed(1)}m off centre, half-width ${half.toFixed(1)}m`);
}

// ---------------------------------------------------------------------------
// 3. Steering authority must FALL with speed, not rise.
// ---------------------------------------------------------------------------
{
  const rates = [];
  for (const speed of [15, 35, 60]) {
    const body = new BoardPhysics();
    body.reset(-1200);
    body.vel.set(0, 0, -speed);

    // Settle onto the snow first. reset() drops the rider from a metre up, and
    // `grounded` is initialised true, so a "wait until grounded" loop exits
    // immediately and the entire measurement window is the rider still
    // falling — which reads as steering doing nothing at all.
    for (let i = 0; i < 200; i++) {
      body.step(DT, { steer: 0, pitch: -1, jumpHeld: false, jumpReleased: false, brake: false });
      if (body.speed > 0.1) body.vel.setLength(speed);
    }

    // Measure the INITIAL response: how sharply the board bites when the
    // player first asks for a turn. Averaging over a long window instead just
    // measures the carve-angle clamp, which reports its lowest number exactly
    // when steering is most responsive.
    let turned = 0, groundTime = 0, prevYaw = body.yaw;
    for (let i = 0; i < 48 && groundTime < 0.2; i++) {
      body.step(DT, { steer: 1, pitch: -1, jumpHeld: false, jumpReleased: false, brake: false });
      if (body.grounded) { turned += Math.abs(body.yaw - prevYaw); groundTime += DT; }
      prevYaw = body.yaw;
      if (body.speed > 0.1) body.vel.setLength(speed);
    }
    rates.push({ speed, rate: groundTime > 0.02 ? (turned / groundTime) * (180 / Math.PI) : 0 });
  }
  for (const r of rates) console.log(`   at ${String(r.speed).padStart(2)} m/s: ${r.rate.toFixed(0)} deg/s at full lock`);
  check('steering gets calmer at speed, not twitchier',
    rates[2].rate < rates[0].rate,
    `${rates[0].rate.toFixed(0)} deg/s at 15 m/s vs ${rates[2].rate.toFixed(0)} at 60`);
  check('high-speed steering is not violent', rates[2].rate < 70,
    `${rates[2].rate.toFixed(0)} deg/s at 60 m/s`);
}

// ---------------------------------------------------------------------------
// 4. The simplest possible trick input must produce a scored, named trick.
//    Jump off a kicker, hold a direction, let go before landing. Nothing else.
// ---------------------------------------------------------------------------
{
  const body = new BoardPhysics();
  const tricks = new TrickSystem();
  const input = new FakeInput();
  body.reset(-440);
  body.vel.set(0, 0, -40);

  const names = [];
  let charged = false;
  for (let i = 0; i < 120 * 14; i++) {
    input.axis.pitch = -1;
    input.axis.steer = 0;

    // Hold jump on the approach, release at the lip — the ollie the HUD asks
    // for — then hold a direction in the air and let go to land.
    if (body.grounded) {
      input.set('jump', true);
      charged = true;
    } else if (charged) {
      input.set('jump', false);
      const alt = body.pos.y - (body.pos.y - 0);
      input.axis.steer = 0.9;                    // stick held = spin
      if (body.vel.y < 0 && body.airTime > 0.55) input.axis.steer = 0;  // spot the landing
    }

    const intent = tricks.fixedUpdate(DT, input, body);
    body.step(DT, {
      steer: intent.steer, pitch: intent.pitch,
      jumpHeld: input.down('jump'), jumpReleased: input.justReleased('jump'), brake: false,
    });
    input.endFrame();
    if (tricks.current && !names.includes(tricks.current)) names.push(tricks.current);
  }
  tricks.bankAll();

  check('holding a direction in the air names a rotation trick',
    names.some((n) => /\d{3,4}|flip|misty|cork|rodeo/i.test(n)),
    names.slice(0, 5).join(' | ') || 'nothing');
  check('that trick actually scores', tricks.score > 0, `score=${Math.round(tricks.score)}`);
}

console.log(`\nRESULT: ${failures.length ? 'FAIL (' + failures.join(', ') + ')' : 'PASS'}`);
process.exit(failures.length ? 1 : 0);
