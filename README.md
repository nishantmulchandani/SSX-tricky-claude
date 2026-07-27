# SNOWBLITZ — an SSX-Tricky-style snowboarding game in Three.js

A downhill trick-snowboarding game built on Three.js (r180) and Vite. Every
asset in it is generated in code: there are no model files, no textures, no
audio samples, and no network fetches. The mountain, the rider, the forest,
the sky and the soundtrack are all produced procedurally at load time.

```bash
npm install
npm run dev        # http://localhost:5173
```

## Controls

| Action | Keyboard | Gamepad |
|---|---|---|
| Steer / carve | `A` `D` / arrows | left stick X |
| Tuck (speed) / brake | `W` / `S` | left stick Y |
| Ollie (hold to charge) | `Space` | A |
| Pre-wind (charge a spin on the lip) | `Shift` | LT |
| Spin left / right in the air | `Q` / `E` | LB / RB |
| Grabs | `J` `K` `L` `I` | X / Y / B |
| Uber trick (needs a full meter) | `U` | RT |
| Reset | `R` | — |
| Pause | `Esc` | — |

Start a run from the title screen with jump or tuck.

## How it fits together

`src/main.js` is wiring only — every subsystem is reached through the
interface documented in `docs/INTERFACES.md`.

| Area | Where | Notes |
|---|---|---|
| Fixed-step loop, renderer | `src/core/engine.js` | 120 Hz fixed update, variable-rate render |
| Input | `src/core/input.js` | keyboard + gamepad, analog-smoothed |
| Chase camera | `src/core/camera.js` | analytic critically-damped spring |
| Run lifecycle | `src/core/gameState.js` | title / countdown / riding / finished / paused |
| Terrain | `src/world/terrain.js` | **the** height field — never duplicate this maths |
| Terrain mesh | `src/world/mountain.js` | continuous radial mesh, crack-free by construction |
| Snow shading | `src/world/snowMaterial.js`, `src/shaders/snow*` | PBR snow, sparkle, corduroy, rock blend |
| Sky & lighting | `src/world/sky.js`, `lighting.js`, `src/shaders/sky*` | analytic sky, PMREM IBL, CSM, cloud deck |
| Props | `src/world/prop*.js` | instanced forest, rocks, rails, course furniture |
| Physics | `src/physics/board.js` | arcade snowboard body |
| Tricks | `src/tricks/` | rotation, grabs, naming, landing judgement, combos, grinds |
| Rider | `src/player/` | procedural rig, poses, cloth, board |
| VFX | `src/vfx/` | GPU particle pools + the post stack |
| Audio | `src/audio/` | Web Audio synthesis, including the music |
| HUD | `src/ui/` | DOM/CSS, diffed against cached values |

### The terrain is the contract

`heightAt(x, z)` is the single source of truth for the surface. Physics, props,
VFX and the camera all query it. Nothing may re-implement it.

The world is composed rather than summed: a smooth `courseSurface` for the
rideable run, plus a strictly non-negative `relief` term off-piste, so the run
is guaranteed to sit at the bottom of its own valley whatever the noise does.
On top of that sit 22 authored features — kickers, tabletops, quarterpipes,
hips, drops and rollers — each with compact support so it only perturbs its own
patch of mountain.

## Tests

All four are headless and take seconds. Run them before every commit.

```bash
export CHROME_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome

node tools/lintshaders.mjs        # static shader hazards
node tools/ridetest.mjs           # is the whole course rideable?
node tools/tricktest.mjs          # do tricks detect, name, judge and score?
node tools/audiotest.mjs          # render the audio graph offline, check the PCM
node tools/smoke.mjs --seconds 6  # does the real page actually run?
```

`ridetest` and `tricktest` run the real physics in plain Node with no browser.
`audiotest` renders the whole audio graph through an OfflineAudioContext and
checks the samples numerically — level, headroom, clipping, stereo width and
whether the mix actually responds to the ride. `smoke` boots the page and is
the only one that catches a module which parses but blanks the screen at
runtime.

### Capturing frames

```bash
node tools/shot.mjs --out shots/x.png --z -900 --speed 30 --settle 1.5 --wait 7
node tools/shot.mjs --preset gallery --dir shots/gallery
node tools/uishot.mjs             # every HUD state
node tools/probe.mjs -1400        # dump live engine state
```

## Things that will bite you

Learned the hard way; `tools/lintshaders.mjs` now checks the first three.

1. **Never put a backtick inside a comment within a GLSL template literal.** It
   terminates the JS string and blanks the entire page, and the error it
   produces points nowhere near the real cause. This broke the build four
   separate times.
2. **`patch`, `sample`, `filter`, `input`, `output` and friends are reserved in
   GLSL ES 3.0.** Using one as a variable fails shader compilation.
3. **In a `RawShaderMaterial` preamble, `precision` must precede any
   declaration.** Three adds no boilerplate for raw materials.
4. **VFX, the rider rig and the camera live in the variable-rate `update()`,
   not `fixedUpdate()`.** A test or capture that only drives `fixedUpdate` will
   show no particles at all.
5. **Injecting `input.axis.steer` directly does nothing.** `input.poll()` runs
   at the top of `fixedUpdate` and recomputes the axis from key state. Drive
   `input.actions` instead.
6. **`renderer.info.render` resets on every `render()` call**, and the post
   stack ends on a fullscreen quad — so reading it after a frame reports
   "1 call, 1 triangle". Render the scene once directly for a real figure.

## Development environment note

Rendering in CI here is software (swiftshader), where the full post stack runs
at well under 1 fps. No frame-rate number measured in that environment says
anything about real GPU performance. Because the engine caps fixed steps per
frame to avoid a spiral of death, a slow renderer makes the simulation advance
in slow motion — so tests drive the game loop directly rather than waiting on
wall-clock time.
