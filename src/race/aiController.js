import { courseXAt, courseWidthAt, heightAt, courseFeatures, COURSE_LENGTH } from '../world/terrain.js';
import { makeInput } from './racer.js';
import { mulberry32 } from '../core/noise.js';

/**
 * An AI rider.
 *
 * It drives with the same input struct a human produces — steer, tuck, ollie,
 * spin, grab — so it is subject to exactly the same physics and trick rules.
 * There is no rubber-banding of position or speed; difficulty is expressed as
 * how well it rides, not as a hidden multiplier.
 *
 * Behaviour:
 *   - holds a personal racing line, offset from centre, that shifts through
 *     corners so the field does not ride in single file
 *   - tucks on the flat, backs off before a feature it intends to hit
 *   - pre-winds and pops off kickers, spins in the air, spots the landing
 *   - makes mistakes in proportion to (1 - skill)
 */

const FEATURES = courseFeatures();

/** Features sorted by z descending (first encountered first). */
const ORDERED = [...FEATURES].sort((a, b) => b.z - a.z);

export class AIController {
  /**
   * @param skill 0..1. Affects line accuracy, tuck discipline, trick ambition
   *              and how often it botches a landing.
   */
  constructor({ skill = 0.7, seed = 1, lane = 0 } = {}) {
    this.skill = skill;
    this.lane = lane;                 // preferred lateral offset, -1..1
    this.rand = mulberry32(seed >>> 0);
    this._wanderPhase = this.rand() * 100;
    this._trickPlan = null;
    this._spinDir = this.rand() < 0.5 ? -1 : 1;
    this._grab = 1 + Math.floor(this.rand() * 4);
    this._mistake = 0;
    this._t = 0;
  }

  /** The next feature ahead of z, or null. */
  _next(z) {
    for (let i = 0; i < ORDERED.length; i++) {
      const f = ORDERED[i];
      if (f.z < z - 4) return f;      // downhill of us
    }
    return null;
  }

  sample(dt, racer, world) {
    const inp = makeInput();
    const b = racer.body;
    this._t += dt;

    const z = b.pos.z;
    const cx = courseXAt(z);
    const half = Math.max(6, courseWidthAt(z) * 0.5);

    // --- pick a target point on the racing line ----------------------------
    // Aim well ahead, or the rider saws at the wheel. Lookahead scales with
    // speed so the line stays smooth at pace.
    const ahead = Math.min(90, 22 + b.speed * 0.9);
    const targetZ = z - ahead;
    const wander = Math.sin(this._t * 0.5 + this._wanderPhase) * (1 - this.skill) * 0.35;
    const laneOff = (this.lane + wander) * half * 0.42;
    const targetX = courseXAt(targetZ) + laneOff;

    // Steer towards it, in the frame of where the board is actually pointing.
    const dx = targetX - b.pos.x;
    const dz = targetZ - z;
    const desiredYaw = Math.atan2(dx, -dz);
    let yawErr = wrap(desiredYaw - b.yaw);

    // Better riders hold a tighter line; worse ones over- and under-steer.
    const gain = 1.4 + this.skill * 1.2;
    inp.steer = clamp(yawErr * gain, -1, 1);

    // A hard correction at speed just scrubs; good riders know that.
    if (this.skill > 0.5 && b.speed > 45) inp.steer = clamp(inp.steer, -0.7, 0.7);

    // --- speed management ---------------------------------------------------
    // Tuck discipline is one of the clearest expressions of skill: a weaker
    // rider keeps sitting up and bleeding speed rather than staying low.
    inp.pitch = -1;
    if (this.skill < 0.9) {
      const slack = Math.sin(this._t * (0.7 + this.lane) + this._wanderPhase * 3);
      if (slack > this.skill * 1.6 - 0.5) inp.pitch = -0.25;
    }
    const feat = this._next(z);
    const distToFeat = feat ? z - feat.z : 1e9;

    // --- feature handling ---------------------------------------------------
    if (feat && distToFeat < 60 && distToFeat > 0) {
      const isJump = feat.type === 'kicker' || feat.type === 'table' || feat.type === 'hip';
      if (isJump) {
        // Line up with the takeoff.
        const lipX = courseXAt(feat.z) + (feat.off || 0);
        const lineErr = lipX - b.pos.x;
        inp.steer = clamp(inp.steer - lineErr * 0.05, -1, 1);

        // Wind up and charge the ollie into the lip.
        if (distToFeat < 34) {
          inp.prewind = this.skill > 0.35;
          inp.jumpHeld = true;
        }
        if (distToFeat < 3) {
          inp.jumpHeld = false;
          inp.jumpReleased = true;
          // Decide the trick once, at takeoff.
          this._trickPlan = {
            spin: this.rand() < 0.35 + this.skill * 0.5,
            grab: this.rand() < 0.4 + this.skill * 0.45,
            dir: this.rand() < 0.5 ? -1 : 1,
          };
          this._mistake = this.rand() > this.skill * 0.9 + 0.08 ? 1 : 0;
        }
      }
    }

    // --- airborne -----------------------------------------------------------
    if (!b.grounded) {
      const alt = b.pos.y - heightAt(b.pos.x, b.pos.z);
      const descending = b.vel.y < 0;
      // Spot the landing: let go of everything with room to spare. A rider
      // that holds a grab or a spin into the snow bails, by design.
      const spotting = descending && alt < 7 + (1 - this.skill) * 6;

      const plan = this._trickPlan;
      if (plan && !spotting) {
        if (plan.spin) {
          if (plan.dir > 0) inp.spinR = true; else inp.spinL = true;
        }
        if (plan.grab && b.airTime > 0.2) inp.grab = this._grab;
      }
      // A botched attempt holds on too long and eats the landing.
      if (this._mistake && plan) {
        inp.spinR = plan.dir > 0;
        inp.spinL = plan.dir < 0;
        inp.grab = this._grab;
      }
      inp.steer = 0;
      inp.pitch = -0.4;
    } else {
      this._trickPlan = null;
    }

    // --- uber ---------------------------------------------------------------
    if (racer.tricks.boost >= 1 && !b.grounded && b.airTime > 0.35 && this.skill > 0.55) {
      inp.uber = true;
    }

    return inp;
  }
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function wrap(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}
