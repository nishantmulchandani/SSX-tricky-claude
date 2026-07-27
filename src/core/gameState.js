import { COURSE_LENGTH, progressAt } from '../world/terrain.js';

/**
 * Run lifecycle. Owns the states a run moves through and the clock, and
 * nothing else — no rendering, no input mapping, no scoring (the trick system
 * owns that). The HUD reads this to decide which screen to show.
 *
 *   title      waiting at the gate
 *   countdown  3..2..1, rider held in place
 *   riding     the clock is running
 *   finished   crossed the line; final time and score are frozen
 *   paused     riding, suspended
 *
 * Transitions are explicit. Nothing else may write `state`.
 */
export const RunState = {
  TITLE: 'title',
  COUNTDOWN: 'countdown',
  RIDING: 'riding',
  FINISHED: 'finished',
  PAUSED: 'paused',
};

const COUNTDOWN_TIME = 3.2;

export class GameState {
  constructor({ onStart, onFinish } = {}) {
    this.onStart = onStart;
    this.onFinish = onFinish;
    this.reset();
  }

  reset() {
    this.state = RunState.TITLE;
    this.time = 0;              // elapsed run time, seconds
    this.countdown = 0;
    this.progress = 0;          // 0..1 down the course
    this.finalTime = 0;
    this.finalScore = 0;
    this.best = this.best ?? null;
    this._prevState = null;
  }

  get isRiding() { return this.state === RunState.RIDING; }
  /** True whenever the sim should advance (i.e. not paused or on a menu). */
  get simRunning() {
    return this.state === RunState.RIDING || this.state === RunState.COUNTDOWN;
  }

  beginCountdown() {
    if (this.state !== RunState.TITLE && this.state !== RunState.FINISHED) return;
    this.state = RunState.COUNTDOWN;
    this.countdown = COUNTDOWN_TIME;
    this.time = 0;
    this.finalTime = 0;
    this.finalScore = 0;
    this.onStart?.();
  }

  togglePause() {
    if (this.state === RunState.RIDING) {
      this._prevState = this.state;
      this.state = RunState.PAUSED;
    } else if (this.state === RunState.PAUSED) {
      this.state = this._prevState ?? RunState.RIDING;
      this._prevState = null;
    }
  }

  /**
   * @param dt   fixed timestep
   * @param body physics body, read-only here
   * @param tricks trick system, read-only here
   * @returns true if the physics should step this frame
   */
  fixedUpdate(dt, body, tricks) {
    switch (this.state) {
      case RunState.COUNTDOWN:
        this.countdown -= dt;
        if (this.countdown <= 0) {
          this.countdown = 0;
          this.state = RunState.RIDING;
        }
        // Rider is held at the gate until the countdown clears.
        return false;

      case RunState.RIDING: {
        this.time += dt;
        this.progress = progressAt(body.pos.z);
        if (body.pos.z <= -COURSE_LENGTH) this._finish(tricks);
        return true;
      }

      case RunState.FINISHED:
        // Let the rider coast to a stop past the line rather than freezing.
        return true;

      case RunState.TITLE:
      case RunState.PAUSED:
      default:
        return false;
    }
  }

  _finish(tricks) {
    this.state = RunState.FINISHED;
    this.finalTime = this.time;
    // Pay out any chain still in progress before freezing the score, or a run
    // that ends mid-combo silently throws those points away.
    tricks?.bankAll?.();
    this.finalScore = tricks?.score ?? 0;
    if (!this.best || this.finalScore > this.best.score) {
      this.best = { score: this.finalScore, time: this.finalTime };
    }
    this.onFinish?.({ time: this.finalTime, score: this.finalScore });
  }
}
