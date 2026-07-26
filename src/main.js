import * as THREE from 'three';
import { Engine } from './core/engine.js';
import { Input } from './core/input.js';
import { ChaseCamera } from './core/camera.js';
import { GameState } from './core/gameState.js';
import { Mountain } from './world/mountain.js';
import { createSky } from './world/sky.js';
import { createProps } from './world/props.js';
import { BoardPhysics } from './physics/board.js';
import { Rider } from './player/rider.js';
import { TrickSystem } from './tricks/trickSystem.js';
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

const body = new BoardPhysics();
const rider = new Rider();
engine.scene.add(rider.group);

const props = createProps(engine.scene, { mountain, sky });
const tricks = new TrickSystem();
const vfx = new SnowVFX(engine.scene, { sky });
const chase = new ChaseCamera(engine.camera);
const audio = new GameAudio();
const hud = new HUD(document.getElementById('ui-root'));
const post = createPostStack(engine, { sky });
const run = new GameState({
  onStart: () => { body.reset(-20); tricks.reset(); chase.snap(body); },
});

body.reset(-20);
chase.snap(body);
mountain.update(engine.camera.position);

// Audio contexts may only start from a user gesture.
const startAudio = () => { audio.init(); removeEventListener('pointerdown', startAudio); removeEventListener('keydown', startAudio); };
addEventListener('pointerdown', startAudio);
addEventListener('keydown', startAudio);

const game = {
  fixedUpdate(dt, elapsed) {
    input.poll(dt);

    if (input.justPressed('pause')) run.togglePause();
    // Any of the ride controls drops you into the run from the title screen.
    if (!run.simRunning && (input.justPressed('jump') || input.justPressed('tuck'))) {
      run.beginCountdown();
    }

    const stepPhysics = run.fixedUpdate(dt, body, tricks);

    if (stepPhysics) {
      // The trick system owns rotation while airborne and reports back the
      // control intent the physics body should apply.
      const intent = tricks.fixedUpdate(dt, input, body);

      body.step(dt, {
        steer: intent.steer,
        pitch: intent.pitch,
        jumpHeld: input.down('jump'),
        jumpReleased: input.justReleased('jump'),
        brake: input.down('brake'),
      });
    }

    if (input.justPressed('reset')) { body.reset(body.pos.z); tricks.reset(); chase.snap(body); }
    input.endFrame();
  },

  update(dt, alpha, elapsed) {
    chase.update(dt, body);
    mountain.update(engine.camera.position);
    rider.update(dt, body, tricks);
    props.update?.(dt, body, engine.camera);
    vfx.update(dt, body, tricks, engine.camera);
    sky.update(dt, elapsed, engine.camera);
    audio.update(dt, body, tricks);
    hud.update(dt, body, tricks, run);
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
globalThis.__game = { engine, body, chase, mountain, sky, input, rider, vfx, tricks, props, hud, post, audio, run, THREE };
