/**
 * OWNER: agent "tricks".
 *
 * UBER TRICKS — the signature over-the-top moves. When the boost meter fills
 * the rider goes "TRICKY" and `uber` becomes available in the air.
 *
 * An uber is a *scripted* rotation, not a physical one: it declares exact
 * total revolutions and an easing curve, so the rotation is guaranteed to end
 * on a legal landing angle. That is deliberate — the uber is the payoff, it
 * should never be the thing that bails you. The cost is the meter and the
 * commitment (you need the air time; you cannot cancel once it starts).
 *
 * Which uber you get is chosen by the grab button held when you hit `uber`,
 * and a long combo upgrades you to the super. See docs/REQUESTS-tricks.md for
 * the pose/VFX contract with the character + vfx owners.
 */

import { clamp } from './trickTable.js';

const EASES = {
  /** Wind-up, violent middle, held landing pose. The default uber shape. */
  drama(u) {
    const t = clamp((u - 0.12) / 0.74, 0, 1);
    return t * t * t * (t * (t * 6 - 15) + 10);
  },
  /** Long hang, then a whip. For the flip-heavy ones. */
  whip(u) {
    const t = clamp((u - 0.26) / 0.60, 0, 1);
    return Math.pow(t, 1.8) * (3 - 2 * Math.min(t, 1)) / 1.0 * 0.5 + 0.5 * (t * t * (3 - 2 * t));
  },
  /** Constant-rate blur — for the big flat spins. */
  blur(u) {
    const t = clamp((u - 0.08) / 0.80, 0, 1);
    return t * t * (3 - 2 * t);
  },
};

/**
 * rev: signed TOTAL revolutions the script will deliver.
 *      yaw must be a multiple of 0.5, flip/roll multiples of 1.0, so the rider
 *      always resolves square to the fall line.
 * minAir: seconds of remaining air time required to even start it.
 * pose:   character rig hint (see docs/REQUESTS-tricks.md).
 * vfx:    vfx hint.
 */
export const UBERS = [
  {
    id: 'skyhook', name: 'Sky Hook', diff: 1.00, minAir: 1.05,
    rev: { yaw: 1.0, flip: 2.0, roll: 0.0 }, ease: 'whip',
    pose: 'hook', vfx: 'goldTrail',
    blurb: 'Double backflip with the board hooked overhead, one hand on the tail.',
  },
  {
    id: 'wormroll', name: 'Worm Roll', diff: 1.15, minAir: 1.00,
    rev: { yaw: 0.5, flip: 0.0, roll: 3.0 }, ease: 'blur',
    pose: 'worm', vfx: 'spiralRibbon',
    blurb: 'Three horizontal barrel rolls, body flat and undulating like a worm.',
  },
  {
    id: 'sledgehammer', name: 'Sledgehammer', diff: 1.10, minAir: 1.25,
    rev: { yaw: 0.0, flip: 3.0, roll: 0.0 }, ease: 'whip',
    pose: 'hammer', vfx: 'impactRings',
    blurb: 'Triple frontflip, knees to chest, board swung like a hammer head.',
  },
  {
    id: 'kaleidoscope', name: 'Kaleidoscope', diff: 1.30, minAir: 1.45,
    rev: { yaw: -4.0, flip: 0.0, roll: 1.0 }, ease: 'blur',
    pose: 'kaleido', vfx: 'prismEcho',
    blurb: '1440 flat spin with a slow axis roll — the rider smears into echoes.',
  },
  {
    id: 'rocketwrangler', name: 'Rocket Wrangler', diff: 1.20, minAir: 1.15,
    rev: { yaw: 2.0, flip: 1.0, roll: 1.0 }, ease: 'drama',
    pose: 'rocket', vfx: 'jetPlume',
    blurb: 'Board off the feet, held overhead like a rodeo rope, 720 cork out.',
  },
  {
    id: 'supernova', name: 'Tricky Supernova', diff: 1.85, minAir: 1.70, super: true,
    rev: { yaw: -3.0, flip: 2.0, roll: 2.0 }, ease: 'drama',
    pose: 'supernova', vfx: 'supernova',
    blurb: 'Everything at once: 1080 double cork double flip, board detonating light.',
  },
];

export const UBER_BY_ID = Object.fromEntries(UBERS.map((u) => [u.id, u]));

const BUTTON_PICK = { grab1: 'skyhook', grab2: 'wormroll', grab3: 'sledgehammer', grab4: 'kaleidoscope' };
const DEFAULT_PICK = 'rocketwrangler';

/**
 * @param heldButtons array of held grab buttons
 * @param comboCount  tricks already in the current chain
 * @param airLeft     predicted seconds of air remaining
 * @returns an uber definition, or null when there simply is not enough air.
 */
export function pickUber(heldButtons, comboCount, airLeft) {
  const base = UBER_BY_ID[BUTTON_PICK[heldButtons?.[0]] ?? DEFAULT_PICK];
  const sup = UBER_BY_ID.supernova;
  if (comboCount >= 4 && airLeft >= sup.minAir) return sup;
  if (base && airLeft >= base.minAir) return base;
  // Fall back to anything that fits — never waste a full meter on a technicality.
  const fits = UBERS.filter((u) => !u.super && airLeft >= u.minAir)
    .sort((a, b) => b.diff - a.diff);
  return fits[0] ?? null;
}

/** Live uber playback. Owns nothing but its own phase. */
export class UberRun {
  constructor(def, duration, stance) {
    this.def = def;
    this.duration = Math.max(0.5, duration);
    this.t = 0;
    this.u = 0;
    this.stance = stance;
    this.ease = EASES[def.ease] ?? EASES.drama;
    this.applied = { yaw: 0, flip: 0, roll: 0 };
    this.done = false;
  }

  /** @returns delta revolutions to add this step. */
  step(dt) {
    this.t = Math.min(this.duration, this.t + dt);
    this.u = this.t / this.duration;
    const e = clamp(this.ease(this.u), 0, 1);
    const r = this.def.rev;
    const want = { yaw: r.yaw * e, flip: r.flip * e, roll: r.roll * e };
    const d = {
      yaw: want.yaw - this.applied.yaw,
      flip: want.flip - this.applied.flip,
      roll: want.roll - this.applied.roll,
    };
    this.applied = want;
    if (this.t >= this.duration) this.done = true;
    return d;
  }

  /** 0..1 — how much of the scripted rotation has actually been delivered. */
  get completion() {
    const r = this.def.rev;
    const total = Math.abs(r.yaw) + Math.abs(r.flip) + Math.abs(r.roll);
    if (total < 1e-6) return 1;
    const got = Math.abs(this.applied.yaw) + Math.abs(this.applied.flip) + Math.abs(this.applied.roll);
    return clamp(got / total, 0, 1);
  }
}
