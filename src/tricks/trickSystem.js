/**
 * OWNER: agent "tricks".
 *
 * The trick system. It owns everything that happens between the lip and the
 * landing: angular momentum, grabs, naming, landing judgement, combos, the
 * boost meter, uber tricks and grinds.
 *
 * main.js calls `fixedUpdate(dt, input, body)` every fixed step BEFORE
 * `body.step`, and feeds the returned `{ steer, pitch }` into the physics.
 * That ordering is the whole design: it means this module gets to look one
 * step into the future, decide what the landing is going to be, and set
 * `body.yaw` before board.js consumes it. Landings are *judged*, not emergent.
 *
 * ── Air control scheme ─────────────────────────────────────────────────────
 *   stick X                 yaw spin torque
 *   stick Y                 flip torque (up/tuck = frontflip)
 *   prewind (held, ground)  wind up: charges spin/flip rate for the pop
 *   prewind (held, air)     TUCK — spins up what you already have;
 *                           + stick X = tilt the rotation axis (cork/misty)
 *   spinL / spinR           dedicated yaw torque (leaves the stick for grabs)
 *   grab1..grab4 + stick    the grab table (see trickTable.js)
 *   uber                    burn a full meter on an uber trick
 *
 * ── What board.js gets from us ─────────────────────────────────────────────
 *   body.yaw    written every air step (board.js derives `forward` from it)
 *   body.pitch  written every air step (board.js never touches it)
 *   body.roll   written every air step (board.js lerps it back on the ground)
 *   body.crash() called on a bad landing or a rail bail
 */

import { heightAt, normalInto } from '../world/terrain.js';
import * as THREE from 'three';
import {
  GRAB_BUTTONS, grabDirection, resolveGrab, composeTrickName, classifyAxis,
  AXIS, AXIS_DIFFICULTY, LANDING, TAU, wrapPi, clamp, deg, rad,
} from './trickTable.js';
import { ComboScorer, TUNING, signatureOf } from './comboScorer.js';
import { pickUber, UberRun } from './uberTricks.js';
import { RailAdapter, GrindState } from './rails.js';

const GRAVITY = 22.0;          // must match physics/board.js
const RIDE_HEIGHT = 0.09;

export const FEEL = {
  // Prewind
  PREWIND_TIME: 0.70,          // seconds to a full wind-up
  PREWIND_STEER_RATE: 3.2,     // how fast the wind-up latches a direction
  PREWIND_STEER_AUTHORITY: 0.45, // ground steering left while winding up

  // Takeoff angular momentum (revolutions / second)
  SPIN_FROM_STICK: 0.55,
  SPIN_FROM_PREWIND: 1.45,
  FLIP_FROM_STICK: 0.30,
  FLIP_FROM_PREWIND: 0.95,

  // In-air angular dynamics
  SPIN_ACCEL: 1.15,            // rev/s^2 pushing the way you already spin
  SPIN_DECEL: 1.55,            // rev/s^2 fighting your own momentum
  SPIN_DAMP: 0.10,             // rev/s^2 passive — near zero on purpose
  SPIN_MAX: 2.60,
  SPIN_MAX_TUCKED: 3.30,
  TUCK_SPINUP: 0.55,           // per second multiplicative, arms-in
  GRAB_SPIN_DRAG: 0.32,        // rev/s^2 — grabbing costs you rotation
  FLIP_ACCEL: 0.95,
  FLIP_DECEL: 1.40,
  FLIP_MAX: 1.75,
  TILT_LAG: 4.5,
  ROLL_BASE: 0.55,             // rev/s of roll from a full axis tilt alone
  ROLL_FROM_SPIN: 0.30,
  ROLL_FROM_FLIP: 0.25,

  // Landing
  CHECKOUT_TIME: 0.30,         // spotting the landing: rotation settles
  CHECKOUT_DAMP: 3.5,
  ASSIST_DEG: 22,              // total yaw the checkout may steal for you
  ASSIST_DEG_UBER: 60,
  PERFECT_ERR: 14,
  CLEAN_ERR: 34,
  SLOPPY_ERR: 62,
  INVERT_PITCH: 72,
  INVERT_ROLL: 78,
  GRAB_CRASH_HOLD: 0.35,       // grab still held this long at touchdown = bail
  WOBBLE_TIME: 0.75,
};

const bias = (v, k) => v * k;

export class TrickSystem {
  constructor() {
    this.scorer = new ComboScorer();
    this.railAdapter = new RailAdapter();
    this.grind = new GrindState(this.railAdapter);
    this._n = new THREE.Vector3();
    this._out = { steer: 0, pitch: 0 };
    this.reset();
  }

  // ─────────────────────────────────────────────────────────────────────────
  reset() {
    this.scorer.reset();

    // Public interface (docs/INTERFACES.md)
    this.score = 0;
    this.combo = 1;
    this.boost = 0;
    this.current = null;
    this.tricks = [];

    // Public extras — read-only for character / vfx / audio / ui.
    this.phase = 'ground';            // ground | air | landing | grind | crash
    this.stance = 0;                  // 0 regular, 1 switch
    this.rotation = { yaw: 0, pitch: 0, roll: 0, spinRate: 0, flipRate: 0, rollRate: 0, axis: AXIS.AIR };
    this.rev = { yaw: 0, flip: 0, roll: 0 };
    this.grab = null;                 // { name, diff, dir, hold, hand, tweak }
    this.grabs = [];
    this.uber = null;                 // { name, id, u, pose, vfx, duration }
    this.tricky = false;              // meter full — "It's Tricky!"
    this.wobble = 0;
    this.prewind = 0;
    this.airTime = 0;
    this.airLeft = 0;
    this.pending = 0;
    this.comboCount = 0;
    this.comboTimer = 0;
    this.lastLanding = null;
    this.lastTrick = null;
    this.events = [];
    this.grindInfo = { active: false, name: '', balance: 0, time: 0, points: 0, available: false };

    // Internals
    this.time = 0;
    this._prewindSteer = 0;
    this._prewindPitch = 0;
    this._tilt = 0;
    this._startYaw = 0;
    this._stanceAtTakeoff = 0;
    this._resolved = false;
    this._resolveTimer = 0;
    this._assistUsed = 0;
    this._wobbleTimer = 0;
    this._wasCrashed = false;
    this._uberRun = null;
    this._uberDenied = 0;
    this._grabKey = '';
    this._landLock = 0;
  }

  // ─────────────────────────────────────────────────────────────────────────
  fixedUpdate(dt, input, body) {
    this.time += dt;
    this.railAdapter.probe(this.time);
    this.grindInfo.available = this.grind.available();
    if (this._uberDenied > 0) this._uberDenied -= dt;

    let steer = input.axis.steer;
    let pitch = input.axis.pitch;

    // ---- crash --------------------------------------------------------------
    if (body.crashed) {
      if (!this._wasCrashed) this._onCrash('physics');
      this._wasCrashed = true;
      this.phase = 'crash';
      this._syncPublic();
      return this._emit(0, 0);
    }
    if (this._wasCrashed) {
      this._wasCrashed = false;
      this.phase = 'ground';
      this._syncGroundRotation(body);
    }

    // ---- grinds -------------------------------------------------------------
    if (this.grind.active) {
      const res = this.grind.step(dt, input, body, this.stance);
      this.phase = 'grind';
      this.rotation.yaw = body.yaw;
      this._pushGrindInfo();
      if (res) this._onGrindEnd(res, body);
      else { this._liveName(); this._syncPublic(); return this._emit(0, 0); }
    } else if (this.grind.available() && !body.crashed) {
      if (this.grind.tryEnter(body, this.stance)) {
        if (this.phase === 'air' || this.phase === 'landing') this._abortAir();
        this.phase = 'grind';
        this._pushEvent('grindStart', { name: this.grind.name });
        this._pushGrindInfo();
        this._syncPublic();
        return this._emit(0, 0);
      }
    }

    // ---- air / ground state machine -----------------------------------------
    const airborne = !body.grounded;
    if (this._landLock > 0) this._landLock -= dt;

    if (airborne && (this.phase === 'ground' || this.phase === 'grind') && this._landLock <= 0) {
      this._beginAir(body, input);
    } else if (!airborne && (this.phase === 'air' || this.phase === 'landing')) {
      if (!this._resolved) this._resolveLanding(body, /*forced*/ true);
      this._commitLanding(body);
    }

    if (this.phase === 'air') {
      this._airStep(dt, input, body);
      steer = 0; pitch = 0;
    } else if (this.phase === 'landing') {
      this._landingStep(dt, body);
      steer = this._wobbleSteer(0);
      pitch = 0;
    } else {
      this._groundStep(dt, input, body);
      steer = this._wobbleSteer(steer * (1 - FEEL.PREWIND_STEER_AUTHORITY * this.prewind));
    }

    this._liveName();
    this._syncPublic();
    return this._emit(steer, pitch);
  }

  _emit(steer, pitch) {
    this._out.steer = clamp(steer, -1, 1);
    this._out.pitch = clamp(pitch, -1, 1);
    return this._out;
  }

  _syncPublic() {
    this.score = this.scorer.score;
    this.combo = this.scorer.multiplier;
    this.pending = this.scorer.pending;
    this.comboCount = this.scorer.count;
    this.comboTimer = this.scorer.timer;
    this.boost = this.scorer.boost;
    this.tricky = this.scorer.boost >= 1;
  }

  _pushEvent(type, data = {}) {
    const ev = { t: this.time, type, ...data };
    this.events.push(ev);
    if (this.events.length > 24) this.events.shift();
    this.lastEvent = ev;
    return ev;
  }

  // ── ground ───────────────────────────────────────────────────────────────
  _groundStep(dt, input, body) {
    this.phase = 'ground';
    this.airTime = 0;
    this.airLeft = 0;
    this._syncGroundRotation(body);

    // Prewind: charge, and latch a direction from the stick.
    if (input.down('prewind')) {
      this.prewind = Math.min(1, this.prewind + dt / FEEL.PREWIND_TIME);
      this._prewindSteer = clamp(this._prewindSteer + input.axis.steer * dt * FEEL.PREWIND_STEER_RATE, -1, 1);
      this._prewindPitch = clamp(this._prewindPitch + input.axis.pitch * dt * FEEL.PREWIND_STEER_RATE, -1, 1);
    } else {
      this.prewind *= Math.exp(-3.0 * dt);
      if (this.prewind < 0.02) { this.prewind = 0; this._prewindSteer = 0; this._prewindPitch = 0; }
    }

    if (this._wobbleTimer > 0) this._wobbleTimer -= dt;
    this.wobble = Math.max(0, this._wobbleTimer / FEEL.WOBBLE_TIME);

    const banked = this.scorer.update(dt, true, this.time);
    if (banked > 0) this._pushEvent('combo', { points: banked, count: this.scorer.bankedCount });
  }

  _syncGroundRotation(body) {
    this.rotation.yaw = body.yaw;
    this.rotation.pitch = 0;
    this.rotation.roll = body.roll;
    this.rotation.spinRate = 0;
    this.rotation.flipRate = 0;
    this.rotation.rollRate = 0;
    this.rotation.axis = AXIS.AIR;
    this.rev.yaw = 0; this.rev.flip = 0; this.rev.roll = 0;
  }

  _wobbleSteer(base) {
    if (this._wobbleTimer <= 0) return base;
    const w = this._wobbleTimer / FEEL.WOBBLE_TIME;
    return clamp(base + Math.sin(this.time * 26) * 0.34 * w, -1, 1);
  }

  // ── takeoff ──────────────────────────────────────────────────────────────
  _beginAir(body, input) {
    this.phase = 'air';
    this.airTime = 0;
    this._startYaw = body.yaw;
    this._stanceAtTakeoff = this.stance;
    this.rev.yaw = 0; this.rev.flip = 0; this.rev.roll = 0;
    this.rotation.yaw = body.yaw;
    this.rotation.pitch = 0;
    this.rotation.roll = 0;
    this.grabs = [];
    this.grab = null;
    this._grabKey = '';
    this._resolved = false;
    this._resolveTimer = 0;
    this._assistUsed = 0;
    this._uberRun = null;
    this.uber = null;

    // Angular momentum off the lip. Sign convention: stick right => yaw down.
    const stick = -input.axis.steer;
    const pre = -this._prewindSteer * this.prewind;
    this.rotation.spinRate = clamp(
      stick * FEEL.SPIN_FROM_STICK + pre * FEEL.SPIN_FROM_PREWIND,
      -FEEL.SPIN_MAX, FEEL.SPIN_MAX);

    const pStick = -input.axis.pitch;
    const pPre = -this._prewindPitch * this.prewind;
    this.rotation.flipRate = clamp(
      pStick * FEEL.FLIP_FROM_STICK + pPre * FEEL.FLIP_FROM_PREWIND,
      -FEEL.FLIP_MAX, FEEL.FLIP_MAX);

    this.rotation.rollRate = 0;
    this._tilt = 0;
    this.prewind = 0;
    this._prewindSteer = 0;
    this._prewindPitch = 0;

    this._pushEvent('takeoff', { spinRate: this.rotation.spinRate, flipRate: this.rotation.flipRate });
  }

  _abortAir() {
    this.phase = 'ground';
    this._resolved = false;
    this._uberRun = null;
    this.uber = null;
    this.grab = null;
    this.grabs = [];
  }

  // ── airborne ─────────────────────────────────────────────────────────────
  _airStep(dt, input, body) {
    this.airTime += dt;
    const ttl = this._timeToLand(body);
    this.airLeft = ttl;

    // ---- uber ---------------------------------------------------------------
    if (this._uberRun) {
      this._uberStep(dt, body);
    } else {
      if (input.justPressed('uber') && this.scorer.boost >= 1) this._tryUber(input, body, ttl);
      if (!this._uberRun) this._freeRotationStep(dt, input, body);
    }

    this._grabStep(dt, input);

    // ---- checkout: spot the landing -----------------------------------------
    const checkout = ttl > 0 && ttl < FEEL.CHECKOUT_TIME;
    if (checkout) this._checkout(dt, body);

    this._applyRotation(body);
    this.rotation.axis = classifyAxis(this.rev);

    // ---- landing prediction --------------------------------------------------
    if (!this._resolved && this._willLand(body, dt)) this._resolveLanding(body, false);
  }

  _freeRotationStep(dt, input, body) {
    const R = this.rotation;
    const tuck = input.down('prewind');
    const spinBtn = (input.down('spinR') ? 1 : 0) - (input.down('spinL') ? 1 : 0);
    const stickSpin = tuck ? 0 : input.axis.steer;
    const spinIn = clamp(spinBtn + stickSpin, -1, 1);
    const want = -spinIn;                      // desired yaw-rate sign
    const maxSpin = tuck ? FEEL.SPIN_MAX_TUCKED : FEEL.SPIN_MAX;

    if (spinIn !== 0) {
      const dir = Math.sign(want);
      const opposing = R.spinRate !== 0 && Math.sign(R.spinRate) !== dir;
      const a = opposing ? FEEL.SPIN_DECEL : FEEL.SPIN_ACCEL;
      R.spinRate += dir * a * Math.abs(spinIn) * dt;
    } else {
      const d = Math.min(Math.abs(R.spinRate), FEEL.SPIN_DAMP * dt);
      R.spinRate -= Math.sign(R.spinRate) * d;
    }

    // Arms in — angular momentum conserved, rate goes up.
    if (tuck) {
      const k = 1 + FEEL.TUCK_SPINUP * dt * (1 - Math.abs(input.axis.steer));
      R.spinRate *= k;
      R.flipRate *= k;
    }
    if (this.grab) {
      const d = Math.min(Math.abs(R.spinRate), FEEL.GRAB_SPIN_DRAG * dt);
      R.spinRate -= Math.sign(R.spinRate) * d;
    }
    R.spinRate = clamp(R.spinRate, -maxSpin, maxSpin);

    // Flips
    const flipIn = -input.axis.pitch;
    if (Math.abs(flipIn) > 0.05) {
      const dir = Math.sign(flipIn);
      const opposing = R.flipRate !== 0 && Math.sign(R.flipRate) !== dir;
      const a = opposing ? FEEL.FLIP_DECEL : FEEL.FLIP_ACCEL;
      R.flipRate += dir * a * Math.abs(flipIn) * dt;
    } else {
      const d = Math.min(Math.abs(R.flipRate), FEEL.SPIN_DAMP * dt);
      R.flipRate -= Math.sign(R.flipRate) * d;
    }
    R.flipRate = clamp(R.flipRate, -FEEL.FLIP_MAX, FEEL.FLIP_MAX);

    // Off-axis: tuck + stick tilts the rotation axis.
    const tiltIn = tuck ? input.axis.steer : 0;
    this._tilt += (tiltIn - this._tilt) * (1 - Math.exp(-FEEL.TILT_LAG * dt));
    R.rollRate = this._tilt * (FEEL.ROLL_BASE
      + FEEL.ROLL_FROM_SPIN * Math.abs(R.spinRate)
      + FEEL.ROLL_FROM_FLIP * Math.abs(R.flipRate));

    this.rev.yaw += R.spinRate * dt;
    this.rev.flip += R.flipRate * dt;
    this.rev.roll += R.rollRate * dt;
  }

  _applyRotation(body) {
    const R = this.rotation;
    R.yaw = this._startYaw + this.rev.yaw * TAU;
    R.pitch = this.rev.flip * TAU;
    R.roll = this.rev.roll * TAU;
    body.yaw = R.yaw;
    body.pitch = wrapPi(R.pitch);
    body.roll = wrapPi(R.roll);
  }

  // ── grabs ────────────────────────────────────────────────────────────────
  _grabStep(dt, input) {
    if (this._uberRun) { this._closeGrab(); return; }
    const held = GRAB_BUTTONS.filter((b) => input.down(b));
    if (held.length === 0) { this._closeGrab(); return; }

    const key = held.join('|');
    if (key !== this._grabKey) {
      const dir = grabDirection(input.axis.steer, input.axis.pitch);
      const g = resolveGrab(held, dir);
      if (g && g.name !== this.grab?.name) {
        this._closeGrab();
        this.grab = { ...g, hold: 0, start: this.airTime };
      }
      this._grabKey = key;
    }
    if (this.grab) this.grab.hold += dt;
  }

  _closeGrab() {
    if (this.grab) {
      if (this.grab.hold > 0.06) this.grabs.push({ ...this.grab });
      this._lastGrabRelease = this.airTime;
      this.grab = null;
    }
    this._grabKey = '';
  }

  // ── uber ─────────────────────────────────────────────────────────────────
  _tryUber(input, body, ttl) {
    const held = GRAB_BUTTONS.filter((b) => input.down(b));
    const def = pickUber(held, this.scorer.count, ttl);
    if (!def) { this._uberDenied = 0.8; this._pushEvent('uberDenied', { airLeft: ttl }); return; }
    const duration = clamp(ttl * 0.92, 0.5, 3.0);
    this._uberRun = new UberRun(def, duration, this.stance);
    this.scorer.boost = 0;
    this._closeGrab();
    this.grabs = [];
    this.uber = { id: def.id, name: def.name, pose: def.pose, vfx: def.vfx, u: 0, duration, blurb: def.blurb };
    this._pushEvent('uber', { name: def.name, id: def.id, duration });
  }

  _uberStep(dt, body) {
    const d = this._uberRun.step(dt);
    this.rev.yaw += d.yaw;
    this.rev.flip += d.flip;
    this.rev.roll += d.roll;
    const R = this.rotation;
    R.spinRate = d.yaw / dt;
    R.flipRate = d.flip / dt;
    R.rollRate = d.roll / dt;
    this.uber.u = this._uberRun.u;
    this.uber.completion = this._uberRun.completion;
  }

  // ── landing ──────────────────────────────────────────────────────────────
  /** Seconds until the board reaches the snow, ballistic, local ground. */
  _timeToLand(body) {
    const look = 0.18;
    const gx = body.pos.x + body.vel.x * look;
    const gz = body.pos.z + body.vel.z * look;
    const h = body.pos.y - heightAt(gx, gz) - RIDE_HEIGHT;
    if (h <= 0) return 0;
    const vy = body.vel.y;
    const disc = vy * vy + 2 * GRAVITY * h;
    if (disc <= 0) return 0;
    return (vy + Math.sqrt(disc)) / GRAVITY;
  }

  _willLand(body, dt) {
    const k = dt * 2.5;
    const nx = body.pos.x + body.vel.x * k;
    const nz = body.pos.z + body.vel.z * k;
    const ny = body.pos.y + body.vel.y * k;
    return (ny - heightAt(nx, nz)) <= RIDE_HEIGHT + 0.02 && body.vel.y <= 2.0;
  }

  /**
   * The checkout window. The rider spots the landing: rotation settles and a
   * strictly bounded amount of yaw is stolen to square the board up. The budget
   * (22 degrees, 60 for an uber) is what stops this from being an auto-lander.
   */
  _checkout(dt, body) {
    const R = this.rotation;
    const damp = Math.exp(-FEEL.CHECKOUT_DAMP * dt);
    R.spinRate *= damp;
    R.flipRate *= damp;
    R.rollRate *= damp;
    if (this._uberRun) return;   // the uber script owns its own resolve

    const budget = rad(this._uberRun ? FEEL.ASSIST_DEG_UBER : FEEL.ASSIST_DEG);
    const remaining = budget - this._assistUsed;
    if (remaining <= 0) return;

    const velYaw = Math.atan2(body.vel.x, -body.vel.z);
    const yaw = this._startYaw + this.rev.yaw * TAU;
    const off = wrapPi(yaw - velYaw);
    const target = off - Math.round(off / Math.PI) * Math.PI;   // signed error to nearest legal
    const stepAmt = clamp(-target * (1 - Math.exp(-9 * dt)), -remaining, remaining);
    this._assistUsed += Math.abs(stepAmt);
    this.rev.yaw += stepAmt / TAU;

    // Flat the board out too — same idea, smaller budget.
    this.rev.flip -= clamp(wrapPi(this.rev.flip * TAU) / TAU, -0.02, 0.02) * (1 - Math.exp(-7 * dt)) * 4;
    this.rev.roll -= clamp(wrapPi(this.rev.roll * TAU) / TAU, -0.02, 0.02) * (1 - Math.exp(-7 * dt)) * 4;
  }

  /**
   * Judge the landing, score the trick, and set the board up for the physics
   * step that is about to run. This is where SSX lives or dies.
   */
  _resolveLanding(body, forced) {
    this._resolved = true;
    this._resolveTimer = 0;
    this._closeGrab();

    const R = this.rotation;
    const vx = body.vel.x, vz = body.vel.z;
    const hSpeed = Math.hypot(vx, vz);
    const velYaw = hSpeed > 0.4 ? Math.atan2(vx, -vz) : R.yaw;

    // Board vs travel direction. A twin-tip lands nose-first OR tail-first;
    // tail-first is a switch landing, which is legal and worth more.
    const off = wrapPi(R.yaw - velYaw);
    const errFwd = Math.abs(off);
    const errSw = Math.abs(wrapPi(off - Math.PI));
    const toSwitch = errSw < errFwd;
    const yawErrDeg = deg(Math.min(errFwd, errSw));

    const pitchErr = Math.abs(deg(wrapPi(R.pitch)));
    const rollErr = Math.abs(deg(wrapPi(R.roll)));
    const rateErr = Math.abs(R.spinRate) * 6 + Math.abs(R.flipRate) * 9 + Math.abs(R.rollRate) * 7;
    const grabHold = this.grabs.length ? 0 : 0;
    const stillGrabbing = this._lastGrabRelease != null && (this.airTime - this._lastGrabRelease) < 0.02;
    const lastGrab = this.grabs[this.grabs.length - 1];
    const grabPenalty = stillGrabbing && lastGrab ? 10 + lastGrab.hold * 38 : 0;

    const err = yawErrDeg + 0.62 * pitchErr + 0.50 * rollErr + rateErr + grabPenalty + grabHold;

    const inverted = pitchErr > FEEL.INVERT_PITCH || rollErr > FEEL.INVERT_ROLL;
    const grabBail = stillGrabbing && lastGrab && lastGrab.hold > FEEL.GRAB_CRASH_HOLD;

    let grade;
    if (inverted || grabBail || err > FEEL.SLOPPY_ERR) grade = LANDING.CRASH;
    else if (err <= FEEL.PERFECT_ERR) grade = LANDING.PERFECT;
    else if (err <= FEEL.CLEAN_ERR) grade = LANDING.CLEAN;
    else grade = LANDING.SLOPPY;
    if (grade === LANDING.PERFECT && stillGrabbing) grade = LANDING.CLEAN;

    // Fall line reward.
    const n = normalInto(this._n, body.pos.x, body.pos.z, 1.0);
    const fallYaw = Math.atan2(n.x, -n.z);
    const align = Math.cos(wrapPi(velYaw - fallYaw));
    const fallLineMult = 1 + 0.18 * Math.max(0, align);

    const info = {
      grade: grade.key, label: grade.label, yawErr: yawErrDeg, pitchErr, rollErr,
      err, toSwitch, align, forced, uber: this.uber?.name ?? null,
    };
    this.lastLanding = info;

    if (grade === LANDING.CRASH) {
      this._onCrash('landing', info);
      return;
    }

    // Square the board to travel. On a switch landing the board yaw still
    // aligns with velocity (a twin tip is symmetric) — the *rider* is what
    // flips, so we flip `stance` and let the character rig mirror the pose.
    const residual = grade === LANDING.SLOPPY ? wrapPi(off - (toSwitch ? Math.PI : 0)) * 0.45 : 0;
    body.yaw = velYaw + residual;
    body.pitch = 0;
    body.roll *= 0.25;
    R.yaw = body.yaw; R.pitch = 0; R.roll = body.roll;
    if (toSwitch) this.stance ^= 1;

    if (grade === LANDING.SLOPPY) {
      body.vel.multiplyScalar(grade.speed);
      this._wobbleTimer = FEEL.WOBBLE_TIME;
    } else if (grade === LANDING.PERFECT) {
      body.vel.multiplyScalar(grade.speed);
    }

    this._award(grade, info, fallLineMult, toSwitch, body);
    this.phase = 'landing';
    this._landLock = 0.10;
  }

  _award(grade, info, fallLineMult, toSwitch, body) {
    const uberDef = this._uberRun?.def ?? null;
    const composed = uberDef
      ? { name: uberDef.name, axis: AXIS.SPIN, deg: 0, flips: 0, rolls: 0, grabNames: [] }
      : composeTrickName(this.rev, this.grabs, this._stanceAtTakeoff, toSwitch);

    const isTrick = !!uberDef
      || composed.axis !== AXIS.AIR
      || this.grabs.length > 0;

    if (!isTrick) {
      this._pushEvent('land', { ...info, name: 'Straight Air', points: 0 });
      this.current = null;
      return;
    }

    let base;
    let signature;
    if (uberDef) {
      base = TUNING.UBER_BASE * uberDef.diff * this._uberRun.completion
        + TUNING.AIRTIME_POINTS * this.airTime;
      signature = `uber:${uberDef.id}`;
    } else {
      base = this.scorer.airBase({ rev: this.rev, grabs: this.grabs, airTime: this.airTime });
      signature = signatureOf({ ...composed, grabNames: composed.grabNames });
    }

    const entry = {
      name: composed.name + (uberDef && toSwitch ? ' to Switch' : ''),
      axis: uberDef ? 'uber' : composed.axis,
      deg: composed.deg,
      flips: composed.flips,
      rolls: composed.rolls,
      grabNames: composed.grabNames,
      grabs: this.grabs.map((g) => ({ name: g.name, hold: +g.hold.toFixed(2), diff: g.diff })),
      rev: { yaw: +this.rev.yaw.toFixed(3), flip: +this.rev.flip.toFixed(3), roll: +this.rev.roll.toFixed(3) },
      airTime: +this.airTime.toFixed(2),
      landing: grade.key,
      toSwitch,
      uber: uberDef?.id ?? null,
      base,
      signature,
      axisMult: uberDef ? 1 : (AXIS_DIFFICULTY[composed.axis] ?? 1),
      landingMult: grade.mult,
      fallLineMult,
      switchMult: toSwitch ? 1.15 : 1,
      landingBoost: grade.boost,
      t: this.time,
    };

    const res = this.scorer.submit(entry);
    entry.points = res.points;
    entry.repeats = res.repeats;
    entry.multiplier = this.scorer.multiplier;

    this.tricks.push(entry);
    if (this.tricks.length > 64) this.tricks.shift();
    this.lastTrick = entry;
    this.current = entry.name;
    this._pushEvent('trick', { name: entry.name, points: entry.points, landing: grade.key, repeats: res.repeats });
    this._pushEvent('land', { ...info, name: entry.name, points: entry.points });
  }

  _landingStep(dt, body) {
    this._resolveTimer += dt;
    // Hold the resolved pose. If the predicted landing never actually happens
    // (a lip that drops away), give the air back to the player.
    body.yaw = this.rotation.yaw;
    body.pitch = 0;
    if (this._resolveTimer > 0.6 && !body.grounded) {
      this._beginAir(body, { axis: { steer: 0, pitch: 0 }, down: () => false });
    }
  }

  _commitLanding(body) {
    this.phase = 'ground';
    this._resolved = false;
    this._uberRun = null;
    this.uber = null;
    this.grab = null;
    this.grabs = [];
    this.airTime = 0;
    this._syncGroundRotation(body);
  }

  // ── crash ────────────────────────────────────────────────────────────────
  _onCrash(reason, info) {
    const lost = this.scorer.drop();
    this.current = null;
    this.phase = 'crash';
    this._resolved = true;
    this._uberRun = null;
    this.uber = null;
    this.grab = null;
    this.grabs = [];
    this._wobbleTimer = 0;
    this.stance = 0;
    this._pushEvent('crash', { reason, lost, ...(info || {}) });
    if (reason !== 'physics') {
      this.lastLanding = info ?? this.lastLanding;
      // board.js owns the crash animation / recovery.
      this._pendingCrash = true;
    }
  }

  // ── grinds ───────────────────────────────────────────────────────────────
  _pushGrindInfo() {
    const g = this.grind;
    this.grindInfo.active = g.active;
    this.grindInfo.name = g.name;
    this.grindInfo.balance = g.balance;
    this.grindInfo.time = g.time;
    this.grindInfo.points = g.points;
  }

  _onGrindEnd(res, body) {
    this._pushGrindInfo();
    this.phase = body.grounded ? 'ground' : 'air';
    if (res.reason === 'bail') {
      this._onCrash('grindBail', { name: res.name });
      body.crash(1.4);
      return;
    }
    if (res.points > 8) {
      const entry = {
        name: res.name,
        axis: 'grind',
        deg: 0, flips: 0, rolls: 0,
        grabNames: [],
        grinds: [{ name: res.name, time: +res.time.toFixed(2) }],
        airTime: 0,
        landing: 'clean',
        toSwitch: false,
        uber: null,
        base: res.points,
        signature: `grind:${res.name}`,
        axisMult: 1,
        landingMult: 1,
        fallLineMult: 1,
        switchMult: 1,
        landingBoost: 0.04,
        grindTime: +res.time.toFixed(2),
        t: this.time,
      };
      const sub = this.scorer.submit(entry);
      entry.points = sub.points;
      entry.repeats = sub.repeats;
      entry.multiplier = this.scorer.multiplier;
      this.tricks.push(entry);
      if (this.tricks.length > 64) this.tricks.shift();
      this.lastTrick = entry;
      this._pushEvent('trick', { name: entry.name, points: entry.points, landing: 'grind' });
    }
    this._pushEvent('grindEnd', { name: res.name, reason: res.reason, time: res.time });
    if (!body.grounded) this._beginAir(body, { axis: { steer: 0, pitch: 0 }, down: () => false });
  }

  // ── live name ────────────────────────────────────────────────────────────
  _liveName() {
    if (this.phase === 'grind' && this.grind.active) {
      this.current = this.grind.name;
      return;
    }
    if (this.phase !== 'air') return;
    if (this.uber) { this.current = this.uber.name; return; }
    // Bias the displayed degrees down slightly so the HUD never promises a
    // rotation the rider has not nearly finished.
    const live = { yaw: bias(this.rev.yaw, 0.88), flip: this.rev.flip, roll: this.rev.roll };
    const grabs = this.grab ? [...this.grabs, this.grab] : this.grabs;
    const c = composeTrickName(live, grabs, this._stanceAtTakeoff, false);
    this.current = c.name === 'Straight Air' && this.airTime < 0.25 ? null : c.name;
  }
}

export default TrickSystem;
