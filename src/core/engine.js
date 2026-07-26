import * as THREE from 'three';

/**
 * Engine owns the renderer, scene, camera and the fixed-step update loop.
 * Subsystems register via `add({ update, fixedUpdate, resize, dispose })`.
 *
 * Contract:
 *   fixedUpdate(dt)  - dt is always FIXED_DT. Physics/gameplay live here.
 *   update(dt, alpha) - variable rate. Rendering-side interpolation lives here.
 */
export const FIXED_DT = 1 / 120;
const MAX_FRAME = 0.25;

export class Engine {
  constructor(canvas) {
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // handled by the post stack (TAA/SMAA)
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.VSMShadowMap;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(58, 1, 0.1, 12000);

    this.clock = new THREE.Clock();
    this.accumulator = 0;
    this.elapsed = 0;
    this.systems = [];
    this.running = false;

    this._onResize = this._onResize.bind(this);
    this._tick = this._tick.bind(this);
    addEventListener('resize', this._onResize);
    this._onResize();
  }

  add(system) {
    this.systems.push(system);
    if (system.resize) system.resize(this.width, this.height);
    return system;
  }

  _onResize() {
    this.width = innerWidth;
    this.height = innerHeight;
    this.renderer.setSize(this.width, this.height, false);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    for (const s of this.systems) s.resize?.(this.width, this.height);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    this.renderer.setAnimationLoop(this._tick);
  }

  stop() {
    this.running = false;
    this.renderer.setAnimationLoop(null);
  }

  _tick() {
    const frame = Math.min(this.clock.getDelta(), MAX_FRAME);
    this.accumulator += frame;
    this.elapsed += frame;

    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < 8) {
      for (const s of this.systems) s.fixedUpdate?.(FIXED_DT, this.elapsed);
      this.accumulator -= FIXED_DT;
      steps++;
    }
    if (steps === 8) this.accumulator = 0; // bail out of the spiral of death

    const alpha = this.accumulator / FIXED_DT;
    for (const s of this.systems) s.update?.(frame, alpha, this.elapsed);
    for (const s of this.systems) s.render?.(frame, alpha);
  }
}
