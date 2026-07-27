import { COURSE_LENGTH, progressAt, CHECKPOINTS } from '../world/terrain.js';

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
    // Survive a reset, like `best` — these are the session's records, not the
    // current run's state.
    this.bestTime = this.bestTime ?? null;
    this.bestSplits = this.bestSplits ?? null;
    this._prevState = null;

    // Split times, one per checkpoint gantry. null until that arch is passed.
    this.splits = CHECKPOINTS.map(() => null);
    this._nextCheckpoint = 0;
    // The most recent split, and how it compared to the best run's. The HUD
    // shows this for a few seconds after each arch; `delta` is null on a first
    // run because there is nothing to be up or down against yet.
    this.lastSplit = null;   // { index, time, delta }
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
    this.splits = CHECKPOINTS.map(() => null);
    this._nextCheckpoint = 0;
    this.lastSplit = null;
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
        this._checkSplits(body);
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

  /**
   * Stop the clock at each checkpoint gantry.
   *
   * Strictly forward-only: the index advances and never rewinds, so a rider who
   * bounces back uphill past an arch cannot re-trigger a split, and a rider who
   * flies clean over one at 70 m/s (a whole gantry can pass between two fixed
   * steps) still gets it — the test is "am I past it", not "did I touch it".
   */
  _checkSplits(body) {
    while (this._nextCheckpoint < CHECKPOINTS.length
           && body.pos.z <= CHECKPOINTS[this._nextCheckpoint]) {
      const i = this._nextCheckpoint++;
      this.splits[i] = this.time;
      const ref = this.bestSplits?.[i];
      this.lastSplit = { index: i, time: this.time, delta: ref == null ? null : this.time - ref };
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
    // Split references track the FASTEST run, not the highest-scoring one —
    // a split delta is a pace comparison, and pacing yourself against a run
    // that stopped to spin on every lip tells you nothing about your pace.
    if (!this.bestTime || this.finalTime < this.bestTime) {
      this.bestTime = this.finalTime;
      this.bestSplits = this.splits.slice();
    }
    this.onFinish?.({ time: this.finalTime, score: this.finalScore, splits: this.splits.slice() });
  }
}
