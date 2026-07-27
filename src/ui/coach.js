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
  .filter((f) => f.type === 'kicker' || f.type === 'table' || f.type === 'hip'
    || f.type === 'climb')
  .sort((a, b) => b.z - a.z);

/** Distance from z to the next takeoff lip ahead, in metres. */
function toNextLip(z) {
  for (let i = 0; i < JUMPS.length; i++) {
    const f = JUMPS[i];
    if (f.z < z - 2) return { dist: z - f.z, feature: f };
  }
  return { dist: Infinity, feature: null };
}

/** The pipe sections, as [zEnter, zExit] spans. */
const PIPES = courseFeatures()
  .filter((f) => f.type === 'pipe')
  .map((f) => [f.z + f.len, f.z - f.len]);

function inPipe(z) {
  for (const [a, b] of PIPES) if (z <= a && z >= b) return true;
  return false;
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
      } else if (tricks?.tricky && !tricks.uber) {
        // A full meter is the one moment the player has an option they will
        // never discover on their own, and it is worth more than any grab.
        // The bar says IT'S TRICKY; this says what to actually do about it.
        c.stage = 'uber';
        c.title = 'PRESS  U';
        c.sub = 'uber trick — the meter is full';
        c.meter = Math.min(1, body.airTime / 2.2);
        c.urgent = true;
      } else {
        c.stage = 'air';
        c.title = tricks?.uber ? 'HOLD IT' : 'SPIN  A / D';
        c.sub = tricks?.uber
          ? `${tricks.uber.name} — ride it out`
          : 'J K L I to grab  ·  hold for more points';
        c.meter = Math.min(1, body.airTime / 2.2);
      }
      return c;
    }

    // ---- on the ground: is a jump coming? ---------------------------------
    const { dist, feature } = toNextLip(body.pos.z);

    // The pipe is ridden, not hit, so it gets its own instruction for as long
    // as the rider is inside it. Without this the section is silent — there is
    // no lip to count down to — and a player has no way to learn that the walls
    // are the point.
    if (inPipe(body.pos.z)) {
      c.stage = 'pipe';
      c.title = 'RIDE THE WALLS';
      c.sub = 'carve up the transition and pop off the coping';
      return c;
    }

    // A climb is a long approach you have to arrive at with speed, so the
    // warning has to come before the hill starts, not 85 m from its lip —
    // by then you are already halfway up it and it is too late to tuck.
    const isClimb = feature?.type === 'climb';
    const run = isClimb ? (feature.run || feature.len * 3.5) : 0;
    const approach = isClimb ? run + 40 : APPROACH;

    if (dist > approach) {
      c.stage = 'none';
      c.title = '';
      c.sub = '';
      return c;
    }

    if (isClimb) {
      if (dist > POP) {
        c.stage = 'climb';
        c.title = dist > run * 0.4 ? 'CLIMB AHEAD' : 'HOLD  SPACE';
        c.sub = dist > run * 0.4
          ? 'tuck — carry every bit of speed up it'
          : 'charge the ollie for the top';
        c.meter = 1 - (dist - POP) / (approach - POP);
        return c;
      }
      c.stage = 'pop';
      c.title = 'RELEASE!';
      c.sub = 'huge air — pick a spin and commit';
      c.meter = 1;
      c.urgent = true;
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
