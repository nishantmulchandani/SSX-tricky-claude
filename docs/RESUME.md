# Resume notes — paused build

Work was paused deliberately. All five subsystem agents were stopped mid-task
and their in-progress files committed. **The build is verified green at this
commit**: the page boots with no JS errors and no shader compile errors, and
both headless suites pass.

## Verify before doing anything else

```bash
npm install
npm run dev                       # http://localhost:5173
export CHROME_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome

node tools/ridetest.mjs           # course rideability   -> PASS
node tools/tricktest.mjs          # trick system         -> PASS (13/13)
node tools/smoke.mjs --seconds 6  # end-to-end in-browser -> PASS
node tools/shot.mjs --out shots/check.png --z -1400 --wait 6 --w 1280 --h 720
```

`smoke.mjs` is the one that catches what the others cannot: a module that
parses but blanks the screen at runtime (shader that will not compile, a
temporal-dead-zone reference, a missing uniform). Run it before every commit.

Two things about this environment that will mislead you if you do not know them:
- Rendering is **software** (swiftshader). The full post stack runs at well
  under 1 fps. That is not a performance bug, and no frame-rate number measured
  here says anything about a real GPU.
- `renderer.info.render` resets on every `render()` call, and the post stack
  ends on a fullscreen quad — so reading it after a frame reports "1 call, 1
  triangle". `smoke.mjs` renders the scene once directly to get the real
  figure. Current baseline: **9 draw calls, 151,808 triangles** (no props yet).
`shot.mjs` prints a `=== PAGE ERRORS ===` section. Pipe through `strings` when
the output looks binary. Any `ERROR: 0:` line is a shader compile failure.

## State by subsystem

| Subsystem | Owner file(s) | State |
|---|---|---|
| Engine, input, camera | `src/core/` | done |
| Terrain + course | `src/world/terrain.js`, `mountain.js` | done, 22 authored features |
| Physics | `src/physics/board.js` | done, tuned |
| Run lifecycle | `src/core/gameState.js` | done |
| Tricks / scoring / grinds | `src/tricks/` | done + tested |
| Audio | `src/audio/` | done, never listened to |
| Snow shading | `src/world/snowMaterial.js`, `src/shaders/snow*` | done |
| Post stack | `src/vfx/post.js` + passes | done |
| **Sky / lighting** | `src/world/sky.js`, `lighting.js`, `src/shaders/sky*` | **partial** |
| **HUD** | `src/ui/` | mostly working, state screens unfinished |
| **Particles** | `src/vfx/particles.js`, `particlePool.js` | **partial** |
| **Character** | `src/player/rig.js`, `materials.js` | **partial — rider.js is still the placeholder capsule** |
| **Props** | `src/world/propCommon.js`, `src/shaders/prop*`, `tree*` | **partial — props.js is still the no-op** |

Anything marked partial was cut off mid-file. `rider.js` and `props.js` still
export the original placeholders, so the game runs but has **no visible rider
and no trees**.

## Fixes applied while pausing

Three defects left by the killed agents, all fixed here:

1. `src/shaders/skyAerial.glsl.js` — a JSDoc comment containing backticks sat
   *inside* the GLSL template literal and terminated the string. This is the
   single most common failure in this codebase: **never put a backtick in a
   comment inside a shader template literal.**
2. `src/world/sky.js` — the environment bake assigned `api.envMap` during
   construction, before the `const api = {...}` below it was initialised (a
   temporal dead zone `ReferenceError`). `api` is now a `let` declared early
   and the bake guards on it.
3. `src/world/sky.js` — `glsl3f()` emitted `out vec4 pc_FragColor;` before any
   precision qualifier. GLSL ES 3.0 rejects that, and `RawShaderMaterial` adds
   no boilerplate, so precision must be the first thing in the preamble.

## Picking the work back up

Relaunch one agent per partial subsystem, each with strict file ownership (see
`docs/INTERFACES.md`) and a brief that says what it is inheriting. Priority:

1. **character** — biggest visible gap; there is no rider on screen.
2. **props** — second biggest; the mountain is bare.
3. **sky/lighting** — finish and wire `sky.js`; the lighting rig and shaders
   exist but the module is incomplete.
4. **particles** — carve spray is the signature effect and is missing.
5. **HUD** — only the title/pause/results screens remain.

Warn every agent about the three gotchas above, and require it to confirm the
page still boots after each change — a broken module blanks the screen for
every other agent working in parallel.

## Honest status

The mountain, snow, post-processing, physics, tricks and audio are real work.
The frame is not yet a finished game: no rider, no vegetation, no course
dressing. The original goal ("beats Call of Duty in a blind side-by-side") is
not a bar this can clear — CoD is a native engine with hundreds of gigabytes of
authored assets, against zero-asset procedural WebGL. Judge this against good
real-time WebGL work instead, which is a bar worth chasing.
