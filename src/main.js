import * as THREE from 'three';
import { Engine } from './core/engine.js';
import { Input } from './core/input.js';
import { ChaseCamera } from './core/camera.js';
import { GameState } from './core/gameState.js';
import { Mountain } from './world/mountain.js';
import { courseXAt } from './world/terrain.js';
import { createSky } from './world/sky.js';
import { createProps } from './world/props.js';
import { Race } from './race/race.js';
import { SnowVFX } from './vfx/particles.js';
import { createPostStack } from './vfx/post.js';
import { GameAudio } from './audio/audio.js';
import { HUD } from './ui/hud.js';

/**
 * Wiring only. Every subsystem is owned by its own module and is reached
 * through the interface documented in docs/INTERFACES.md — nothing here
 * should ever contain gameplay or rendering logic.
 */

const engine = new Engine(document.getElementById('stage'));
const input = new Input();

const sky = createSky(engine.scene, engine.renderer);
const mountain = new Mountain();
engine.scene.add(mountain.group);

// The field. The player is just racer 0 — same physics, same trick rules, same
// input struct as the AI, which is what keeps a network layer a drop-in later.
const race = new Race(engine.scene, input, { opponents: 5 });
const body = race.player.body;      // convenience aliases for the systems that
const tricks = race.player.tricks;  // only ever care about the local rider

const props = createProps(engine.scene, { mountain, sky });
const vfx = new SnowVFX(engine.scene, { sky });
const chase = new ChaseCamera(engine.camera);
const audio = new GameAudio();
const hud = new HUD(document.getElementById('ui-root'));
const post = createPostStack(engine, { sky });
const run = new GameState({
  onStart: () => { race.reset(); chase.snap(body); },
});

race.reset();
chase.snap(body);
mountain.update(engine.camera.position);

// Audio contexts may only start from a user gesture.
const startAudio = () => { audio.init(); removeEventListener('pointerdown', startAudio); removeEventListener('keydown', startAudio); };
addEventListener('pointerdown', startAudio);
addEventListener('keydown', startAudio);

const world = { mountain, props };

const game = {
  fixedUpdate(dt, elapsed) {
    input.poll(dt);

    if (input.justPressed('pause')) run.togglePause();
    // Any of the ride controls drops you into the run from the title screen.
    if (!run.simRunning && (input.justPressed('jump') || input.justPressed('tuck'))) {
      run.beginCountdown();
    }

    const stepPhysics = run.fixedUpdate(dt, body, tricks);
    if (stepPhysics) race.fixedUpdate(dt, world);

    if (input.justPressed('reset')) { race.reset(); chase.snap(body); }
    input.endFrame();
  },

  update(dt, alpha, elapsed) {
    chase.update(dt, body);
    mountain.update(engine.camera.position);
    race.update(dt);
    props.update?.(dt, body, engine.camera);
    vfx.update(dt, body, tricks, engine.camera);
    sky.update(dt, elapsed, engine.camera);
    audio.update(dt, body, tricks);
    hud.update(dt, body, tricks, run, race);
  },

  render(dt) {
    post.render(dt);
  },

  resize(w, h) {
    post.resize?.(w, h);
    hud.resize?.(w, h);
  },
};

engine.add(game);
engine.start();

// Debug handle for tools/shot.mjs and tools/probe.mjs.
globalThis.__game = {
  __courseX: courseXAt,
  engine, chase, mountain, sky, input, vfx, props, hud, post, audio, run, race, THREE,
  // Local-rider aliases the capture tools already use.
  body, tricks, rider: race.player.rider,
};
