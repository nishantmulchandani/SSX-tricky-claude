import { Racer, makeInput } from './racer.js';
import { AIController } from './aiController.js';
import { courseXAt } from '../world/terrain.js';

/**
 * The race: a field of racers, their standings, and the finish order.
 *
 * Every racer is driven by a controller producing the same input struct, so
 * the player, the AI and (later) a remote peer are indistinguishable to the
 * simulation. `addRemote()` is the seam a network transport would use.
 */

/** Reads the local keyboard/gamepad Input into a RacerInput. */
export class PlayerController {
  constructor(input) { this.input = input; }

  sample() {
    const i = this.input;
    const out = makeInput();
    out.steer = i.axis.steer;
    out.pitch = i.axis.pitch;
    out.jumpHeld = i.down('jump');
    out.jumpReleased = i.justReleased('jump');
    out.brake = i.down('brake');
    out.prewind = i.down('prewind');
    out.spinL = i.down('spinL');
    out.spinR = i.down('spinR');
    out.uber = i.down('uber');
    out.grab = i.down('grab1') ? 1 : i.down('grab2') ? 2 : i.down('grab3') ? 3 : i.down('grab4') ? 4 : 0;
    return out;
  }
}

/**
 * Replays inputs delivered from elsewhere. Not wired to a transport yet — it
 * exists so the simulation already has the shape a network layer needs, and
 * holds the last input if a packet is late rather than stalling the racer.
 */
export class RemoteController {
  constructor() { this.latest = makeInput(); }
  receive(input) { this.latest = input; }
  sample() { return this.latest; }
}

const FIELD = [
  { id: 'ai-1', name: 'KAZ',    skill: 0.92, lane: -0.55, palette: { jacket: '#2f6ad8', jacketDark: '#17356e', accent: '#e8f0ff' } },
  { id: 'ai-2', name: 'MERCY',  skill: 0.84, lane: 0.5,   palette: { jacket: '#28c07a', jacketDark: '#12613c', accent: '#eafff4' } },
  { id: 'ai-3', name: 'VOSS',   skill: 0.76, lane: -0.2,  palette: { jacket: '#f0a92b', jacketDark: '#8a5c10', accent: '#fff6e2' } },
  { id: 'ai-4', name: 'RIKO',   skill: 0.68, lane: 0.25,  palette: { jacket: '#a44bd8', jacketDark: '#54216f', accent: '#f6e9ff' } },
  { id: 'ai-5', name: 'BRICK',  skill: 0.6,  lane: 0.75,  palette: { jacket: '#d8d4cc', jacketDark: '#6d6a63', accent: '#2b2f3a' } },
];

export class Race {
  /**
   * @param scene   THREE.Scene to add rider visuals to
   * @param input   local Input instance for the player
   * @param opts    { opponents }
   */
  constructor(scene, input, { opponents = 5 } = {}) {
    this.scene = scene;
    this.racers = [];

    this.player = new Racer({
      id: 'player',
      name: 'YOU',
      isPlayer: true,
      controller: new PlayerController(input),
    });
    this.racers.push(this.player);

    for (let i = 0; i < Math.min(opponents, FIELD.length); i++) {
      const f = FIELD[i];
      this.racers.push(new Racer({
        id: f.id,
        name: f.name,
        palette: f.palette,
        controller: new AIController({ skill: f.skill, seed: 1000 + i * 77, lane: f.lane }),
      }));
    }

    for (const r of this.racers) if (r.group) scene.add(r.group);

    this.standings = [];
    this.finishOrder = [];
    this.reset();
  }

  /**
   * Seam for a future network layer: swap an AI for a remote peer without the
   * simulation noticing.
   */
  addRemote(id, name, palette) {
    const ctrl = new RemoteController();
    const r = new Racer({ id, name, palette, controller: ctrl });
    this.racers.push(r);
    if (r.group) this.scene.add(r.group);
    return ctrl;
  }

  reset() {
    // Line up across the start gate, player in the middle of the grid.
    const startZ = -20;
    const cx = courseXAt(startZ);
    const n = this.racers.length;
    this.racers.forEach((r, i) => {
      const lateral = ((i - (n - 1) / 2) * 3.6);
      r.reset(startZ - (i % 2) * 4, lateral);
      r.body.pos.x = cx + lateral;
    });
    this.finishOrder = [];
    this._updateStandings();
  }

  fixedUpdate(dt, world) {
    for (const r of this.racers) {
      const wasFinished = r.finished;
      r.fixedUpdate(dt, world);
      if (r.finished && !wasFinished) this.finishOrder.push(r);
    }
    this._updateStandings();
  }

  update(dt) {
    for (const r of this.racers) r.update(dt);
  }

  _updateStandings() {
    // Finished racers rank by finish time; the rest by distance down the hill.
    this.standings = [...this.racers].sort((a, b) => {
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.progress - a.progress;
    });
    for (let i = 0; i < this.standings.length; i++) this.standings[i].place = i + 1;
  }

  get playerPlace() { return this.player.place; }
  get fieldSize() { return this.racers.length; }
}
