import { BoardPhysics } from '../physics/board.js';
import { TrickSystem } from '../tricks/trickSystem.js';
import { Rider } from '../player/rider.js';
import { progressAt, COURSE_LENGTH } from '../world/terrain.js';

/**
 * One competitor: a physics body, a trick system, a visual rider, and a
 * *controller* that supplies input.
 *
 * The important part is that nothing here knows or cares where the input comes
 * from. A controller only has to expose:
 *
 *     sample(dt, racer, world) -> RacerInput
 *
 * The local player's controller reads the keyboard; the AI computes a line;
 * a network controller would replay inputs received from a peer. Because every
 * racer is driven purely by that struct, adding netcode later means writing one
 * more controller and a transport — not restructuring the simulation. This is
 * also why input is a plain serialisable object with no object references.
 */

/** The full control surface of a rider. Serialisable on purpose. */
export function makeInput() {
  return {
    steer: 0,        // -1..1
    pitch: 0,        // -1..1  (negative = tuck)
    jumpHeld: false,
    jumpReleased: false,
    brake: false,
    prewind: false,
    spinL: false,
    spinR: false,
    grab: 0,         // 0 = none, 1..4 = grab button
    uber: false,
  };
}

/**
 * Adapts a RacerInput to the interface TrickSystem.fixedUpdate expects, so the
 * trick system does not need to know about controllers at all.
 */
class InputView {
  constructor() {
    this.axis = { steer: 0, pitch: 0 };
    this._cur = makeInput();
    this._prev = makeInput();
  }

  set(next) {
    this._prev = this._cur;
    this._cur = next;
    this.axis.steer = next.steer;
    this.axis.pitch = next.pitch;
  }

  _flag(a) {
    const c = this._cur;
    switch (a) {
      case 'prewind': return c.prewind;
      case 'spinL': return c.spinL;
      case 'spinR': return c.spinR;
      case 'uber': return c.uber;
      case 'jump': return c.jumpHeld;
      case 'grab1': return c.grab === 1;
      case 'grab2': return c.grab === 2;
      case 'grab3': return c.grab === 3;
      case 'grab4': return c.grab === 4;
      default: return false;
    }
  }

  down(a) { return this._flag(a); }

  justPressed(a) {
    const cur = this._flag(a);
    const prev = this._prevFlag(a);
    return cur && !prev;
  }

  justReleased(a) {
    if (a === 'jump') return this._cur.jumpReleased;
    return !this._flag(a) && this._prevFlag(a);
  }

  _prevFlag(a) {
    const save = this._cur;
    this._cur = this._prev;
    const v = this._flag(a);
    this._cur = save;
    return v;
  }
}

export class Racer {
  /**
   * @param {object} opts
   *   id        stable identifier (used by a future network layer)
   *   name      display name
   *   palette   rider colours
   *   isPlayer  whether the local camera follows this racer
   *   controller object with sample(dt, racer, world) -> RacerInput
   */
  constructor({ id, name, palette, isPlayer = false, controller, visual = true }) {
    this.id = id;
    this.name = name;
    this.isPlayer = isPlayer;
    this.controller = controller;

    this.body = new BoardPhysics();
    this.tricks = new TrickSystem();
    this.input = makeInput();
    this._view = new InputView();

    this.rider = visual ? new Rider({ palette }) : null;
    this.group = this.rider ? this.rider.group : null;

    this.progress = 0;       // 0..1 down the course
    this.place = 1;
    this.finished = false;
    this.finishTime = 0;
    this.raceTime = 0;
  }

  reset(z = -20, lateral = 0) {
    this.body.reset(z);
    this.body.pos.x += lateral;
    this.tricks.reset();
    this.progress = 0;
    this.finished = false;
    this.finishTime = 0;
    this.raceTime = 0;
  }

  /** One fixed step. `world` carries anything a controller may need. */
  fixedUpdate(dt, world) {
    if (this.finished) {
      // Coast to a stop past the line rather than freezing mid-air.
      this.input.steer *= 0.9;
      this.input.pitch = 0.6;
      this.input.jumpHeld = false;
      this.input.jumpReleased = false;
    } else {
      this.raceTime += dt;
      this.input = this.controller.sample(dt, this, world) || makeInput();
    }

    this._view.set(this.input);
    const intent = this.tricks.fixedUpdate(dt, this._view, this.body);

    this.body.step(dt, {
      steer: intent.steer,
      pitch: intent.pitch,
      jumpHeld: this.input.jumpHeld,
      jumpReleased: this.input.jumpReleased,
      brake: this.input.brake,
    });

    this.progress = progressAt(this.body.pos.z);
    if (!this.finished && this.body.pos.z <= -COURSE_LENGTH) {
      this.finished = true;
      this.finishTime = this.raceTime;
      this.tricks.bankAll();
    }
  }

  update(dt) {
    this.rider?.update(dt, this.body, this.tricks);
  }
}
