import { courseFeatures, heightAt } from '../world/terrain.js';

/**
 * Tells the player what to do, and when.
 *
 * A trick system is worthless if nobody can find it. The inputs here are not
 * guessable — charge an ollie on the approach, release at the lip, hold a
 * direction to spin, let go early enough to spot the landing — and none of
 * that is discoverable by pressing buttons at 200 km/h. This watches the
 * rider and emits one clear instruction at a time.
 *
 *   cue.stage   'none' | 'approach' | 'charge' | 'pop' | 'air' | 'spot'
 *   cue.title   the instruction, e.g. "HOLD  SPACE"
 *   cue.sub     supporting line
 *   cue.meter   0..1 progress bar, or -1 for none
 *   cue.urgent  true when the window is about to close
 */

const JUMPS = courseFeatures()
  .filter((f) => f.type === 'kicker' || f.type === 'table' || f.type === 'hip')
  .sort((a, b) => b.z - a.z);

/** Distance from z to the next takeoff lip ahead, in metres. */
function toNextLip(z) {
  for (let i = 0; i < JUMPS.length; i++) {
    const f = JUMPS[i];
    if (f.z < z - 2) return { dist: z - f.z, feature: f };
  }
  return { dist: Infinity, feature: null };
}

const APPROACH = 85;   // start telling them a jump is coming
const CHARGE = 42;     // start of the ollie charge window
const POP = 7;         // release window

export class Coach {
  constructor() {
    this.cue = { stage: 'none', title: '', sub: '', meter: -1, urgent: false };
    this._lastStage = '';
    this._landedRecently = 0;
  }

  reset() { this._lastStage = ''; }

  /**
   * @param body   physics body
   * @param tricks trick system
   * @param dt     seconds
   */
  update(dt, body, tricks) {
    const c = this.cue;
    c.meter = -1;
    c.urgent = false;

    if (!body) { c.stage = 'none'; c.title = ''; c.sub = ''; return c; }

    if (body.crashed) {
      c.stage = 'crash';
      c.title = 'WIPEOUT';
      c.sub = 'let go of the spin before you land';
      return c;
    }

    // ---- airborne ---------------------------------------------------------
    if (!body.grounded) {
      const alt = body.pos.y - heightAt(body.pos.x, body.pos.z);
      const descending = body.vel.y < 0;
      const spotting = descending && alt < 9;

      if (spotting) {
        c.stage = 'spot';
        c.title = 'LET GO';
        c.sub = 'centre the board to land it';
        c.urgent = true;
      } else {
        c.stage = 'air';
        c.title = 'SPIN  A / D';
        c.sub = 'J K L I to grab  ·  hold for more points';
        c.meter = Math.min(1, body.airTime / 2.2);
      }
      return c;
    }

    // ---- on the ground: is a jump coming? ---------------------------------
    const { dist } = toNextLip(body.pos.z);

    if (dist > APPROACH) {
      c.stage = 'none';
      c.title = '';
      c.sub = '';
      return c;
    }

    if (dist > CHARGE) {
      c.stage = 'approach';
      c.title = 'JUMP AHEAD';
      c.sub = `${Math.round(dist)} m  ·  get on the racing line`;
      return c;
    }

    if (dist > POP) {
      c.stage = 'charge';
      c.title = 'HOLD  SPACE';
      c.sub = 'charge the ollie';
      // How far through the charge window we are, so the bar fills towards the
      // lip rather than tracking the crouch — the player needs to know when to
      // release, not how crouched they are.
      c.meter = 1 - (dist - POP) / (CHARGE - POP);
      return c;
    }

    c.stage = 'pop';
    c.title = 'RELEASE!';
    c.sub = 'then hold A or D to spin';
    c.meter = 1;
    c.urgent = true;
    return c;
  }
}
