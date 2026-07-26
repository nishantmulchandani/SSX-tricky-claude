# Module interfaces

`src/main.js` is wiring only. Each subsystem below is owned by exactly one
agent and is reached through the interface described here. **Do not edit files
you do not own** — if you need something from another module, add it to this
document and use the existing hook.

## Shared, read-only for everyone (owner: integration)
| File | Purpose |
|---|---|
| `src/core/engine.js` | renderer, scene, camera, fixed-step loop |
| `src/core/noise.js` | `hash2 noise2 fbm2 ridged2 worley2 mulberry32` |
| `src/core/input.js` | action set + analog axes |
| `src/core/camera.js` | chase camera |
| `src/world/terrain.js` | **the** height field: `heightAt normalInto slopeAt courseAt courseXAt progressAt lateralOffset` |
| `src/world/mountain.js` | radial terrain mesh |
| `src/physics/board.js` | snowboard body |
| `src/main.js` | wiring |

Never re-implement terrain height maths. Always call `heightAt(x, z)`.

## Owned modules

### `src/world/sky.js` — owner: **atmosphere**
```js
createSky(scene, renderer) -> {
  sun,                  // THREE.DirectionalLight (or CSM rig)
  sunDir,               // THREE.Vector3, normalised, points *towards* the sun
  envMap,               // THREE.Texture used as scene.environment
  fogParams,            // { color, density, ... } consumed by snowMaterial
  update(dt, elapsed, camera),
}
```

### `src/world/snowMaterial.js` — owner: **snow-shading**
```js
createSnowMaterial(opts) -> THREE.Material   // used by mountain.js
updateSnowMaterial(dt, ctx)                  // optional per-frame uniforms
```
The terrain mesh supplies `position`, `normal`, `uv` (uv = world xz * 0.05).
If you need more attributes, request them — do not edit `mountain.js`.

### `src/player/rider.js` — owner: **character**
```js
new Rider() -> { group, update(dt, body, tricks) }
```
`body` exposes `pos vel up forward yaw roll pitch speed grounded airTime crouch edge crashed`.

### `src/tricks/trickSystem.js` — owner: **tricks**
```js
new TrickSystem() -> {
  score, combo, boost, current, tricks,
  fixedUpdate(dt, input, body) -> { steer, pitch },  // may consume input while airborne
  reset(),
}
```
It owns air rotation. It must write `body.yaw` / visual spin state, and may
call `body.crash()` on a bad landing.

### `src/vfx/particles.js` — owner: **vfx**
```js
new SnowVFX(scene, { sky }) -> { update(dt, body, tricks, camera) }
```

### `src/vfx/post.js` — owner: **vfx**
```js
createPostStack(engine, { sky }) -> { render(dt), resize(w, h) }
```
`render` replaces the direct `renderer.render` call and must draw the frame.

### `src/world/props.js` — owner: **props**
```js
createProps(scene, { mountain, sky }) -> { update(dt, body, camera) }
```

### `src/audio/audio.js` — owner: **audio**
```js
new GameAudio() -> { init(), update(dt, body, tricks) }
```
`init()` is called on the first user gesture (AudioContext policy).

### `src/ui/hud.js` + `src/ui/hud.css` — owner: **ui**
```js
new HUD(rootEl) -> { update(dt, body, tricks), resize(w, h) }
```

## Tools
```
node tools/shot.mjs  --out shots/x.png --z -1400 --wait 4 --w 1280 --h 720
node tools/shot.mjs  --preset gallery --dir shots/gallery
node tools/probe.mjs -1400     # dump live engine state
```
Both need `CHROME_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome`
and the dev server on :5173 (`npm run dev`).
