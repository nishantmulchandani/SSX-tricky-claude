/**
 * OWNER: agent "tricks".
 *
 * Scoring + combo chain + boost meter. Kept separate from the rotation sim so
 * the numbers can be tuned (and unit-tested) without touching the feel code.
 *
 * ── The model ──────────────────────────────────────────────────────────────
 *   base    = spin + flip + roll + grabs + airtime
 *   base   *= axisDifficulty        (misty/underflip beat a flat spin)
 *   base   *= landingGrade          (perfect 1.30 / clean 1.00 / sketchy 0.45)
 *   base   *= fallLine bonus        (up to 1.18 for landing straight downhill)
 *   base   *= switchLanding bonus   (1.15)
 *   base   *= REPEAT^n              <- the important one
 *   pending += base ; comboCount++
 *
 * Nothing is banked until the chain ends. `score` only moves when a combo is
 * cashed out, which is what makes a crash mid-chain actually hurt.
 *
 *   banked = pending * comboMultiplier,  comboMultiplier = 1 + 0.5*(count-1)
 *
 * ── Repeat penalty ─────────────────────────────────────────────────────────
 * Every trick reduces to a "signature": axis family + snapped degrees + the
 * set of grabs. Doing the same signature again inside one chain multiplies by
 * REPEAT_FALLOFF^n — 45%, 20%, 9%... You cannot farm one trick.
 */

import { clamp } from './trickTable.js';

export const TUNING = {
  SPIN_POINTS: 260,       // points at exactly one full revolution
  SPIN_EXP: 1.55,
  FLIP_POINTS: 420,
  FLIP_EXP: 1.40,
  ROLL_POINTS: 300,
  ROLL_EXP: 1.35,
  GRAB_POINTS: 180,       // per grab, x difficulty x (0.4 + hold seconds)
  GRAB_HOLD_CAP: 1.6,
  GRAB_VARIETY: 0.35,     // extra per distinct additional grab in one air
  AIRTIME_POINTS: 120,    // per second airborne
  GRIND_POINTS: 150,      // per second on a rail, x difficulty
  REPEAT_FALLOFF: 0.45,
  COMBO_STEP: 0.5,        // multiplier gained per extra trick in the chain
  COMBO_CAP: 8.0,
  COMBO_WINDOW: 3.6,      // seconds on the ground before the chain banks
  BOOST_PER_POINT: 1 / 7000,
  BOOST_DECAY: 0.012,     // per second while grounded and idle
  UBER_BASE: 12000,
};

/** Trick "signature" used for the repeat penalty. */
export function signatureOf(entry) {
  const grabs = (entry.grabNames || []).slice().sort().join('+');
  return `${entry.axis}:${entry.deg}:${entry.flips}:${grabs}`;
}

export class ComboScorer {
  constructor(tuning = TUNING) {
    this.T = { ...TUNING, ...tuning };
    this.reset();
  }

  reset() {
    this.score = 0;
    this.pending = 0;
    this.count = 0;
    this.multiplier = 1;
    this.timer = 0;
    this.boost = 0;
    this.best = 0;
    this.banked = 0;          // last cashed-out chain, for the HUD flash
    this.bankedCount = 0;
    this.bankedAt = -99;
    this._seen = new Map();
  }

  get active() { return this.count > 0; }

  /** Raw base points for one landed air trick. */
  airBase(t) {
    const T = this.T;
    const yr = Math.abs(t.rev.yaw), fr = Math.abs(t.rev.flip), rr = Math.abs(t.rev.roll);
    let base = 0;
    if (yr > 0.2) base += T.SPIN_POINTS * Math.pow(yr, T.SPIN_EXP);
    if (fr > 0.3) base += T.FLIP_POINTS * Math.pow(fr, T.FLIP_EXP);
    if (rr > 0.3) base += T.ROLL_POINTS * Math.pow(rr, T.ROLL_EXP);

    const grabs = t.grabs || [];
    const distinct = new Set();
    for (const g of grabs) {
      const hold = clamp(g.hold ?? 0, 0, T.GRAB_HOLD_CAP);
      base += T.GRAB_POINTS * (g.diff ?? 1) * (0.4 + hold);
      distinct.add(g.name);
    }
    if (distinct.size > 1) base *= 1 + T.GRAB_VARIETY * (distinct.size - 1);

    base += T.AIRTIME_POINTS * (t.airTime || 0);
    return base;
  }

  /**
   * Submit a landed trick. Returns the enriched entry (already pushed by the
   * caller into `tricks`).
   */
  submit(t) {
    const T = this.T;
    const base = t.base ?? this.airBase(t);
    const sig = t.signature ?? signatureOf(t);
    const repeats = this._seen.get(sig) ?? 0;
    const repeatMult = Math.pow(T.REPEAT_FALLOFF, repeats);

    const points = Math.round(
      base *
      (t.axisMult ?? 1) *
      (t.landingMult ?? 1) *
      (t.fallLineMult ?? 1) *
      (t.switchMult ?? 1) *
      repeatMult,
    );

    this._seen.set(sig, repeats + 1);
    this.pending += points;
    this.count += 1;
    this.multiplier = Math.min(T.COMBO_CAP, 1 + T.COMBO_STEP * (this.count - 1));
    this.timer = T.COMBO_WINDOW;
    this.boost = clamp(this.boost + points * T.BOOST_PER_POINT + (t.landingBoost ?? 0), 0, 1);

    return { points, base, repeats, repeatMult, signature: sig };
  }

  /** Cash the chain out into `score`. */
  bank(now = 0) {
    if (this.count === 0) { this.timer = 0; return 0; }
    const total = Math.round(this.pending * this.multiplier);
    this.score += total;
    this.best = Math.max(this.best, total);
    this.banked = total;
    this.bankedCount = this.count;
    this.bankedAt = now;
    this.pending = 0;
    this.count = 0;
    this.multiplier = 1;
    this.timer = 0;
    this._seen.clear();
    return total;
  }

  /** Chain lost — nothing is banked. */
  drop() {
    const lost = this.pending;
    this.pending = 0;
    this.count = 0;
    this.multiplier = 1;
    this.timer = 0;
    this._seen.clear();
    this.boost = clamp(this.boost * 0.4, 0, 1);
    return lost;
  }

  /**
   * @param grounded  true while the rider is on the snow and not tricking
   * @returns the banked amount if the window expired this step, else 0
   */
  update(dt, grounded, now = 0) {
    if (this.count > 0) {
      if (grounded) {
        this.timer -= dt;
        if (this.timer <= 0) return this.bank(now);
      }
    } else if (grounded) {
      this.boost = clamp(this.boost - this.T.BOOST_DECAY * dt, 0, 1);
    }
    return 0;
  }
}
