# Build status

All subsystems are implemented and the build is green. See `README.md` for how
to run, test and capture, and for the full list of traps in this codebase.

## Verify

```bash
npm install
npm run dev                       # http://localhost:5173
export CHROME_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome

node tools/lintshaders.mjs        # static shader hazards
node tools/ridetest.mjs           # course rideability
node tools/tricktest.mjs          # trick detection, naming, judging, scoring
node tools/audiotest.mjs          # offline PCM render of the audio graph
node tools/smoke.mjs --seconds 6  # end-to-end in the real browser
```

`smoke.mjs` catches what the others cannot: a module that parses but blanks the
screen at runtime. Run it before every commit.

## State by subsystem

| Subsystem | Owner file(s) | State |
|---|---|---|
| Engine, input, camera | `src/core/` | done |
| Run lifecycle | `src/core/gameState.js` | done |
| Terrain + course | `src/world/terrain.js`, `mountain.js` | done, 22 authored features |
| Physics | `src/physics/board.js` | done, tuned |
| Tricks / scoring / grinds | `src/tricks/` | done + tested |
| Snow shading | `src/world/snowMaterial.js`, `src/shaders/snow*` | done |
| Sky / lighting / clouds | `src/world/sky.js`, `lighting.js`, `src/shaders/sky*` | done |
| Props (forest, rocks, rails, course furniture) | `src/world/prop*.js` | done |
| Rider | `src/player/` | done |
| VFX (particles + post stack) | `src/vfx/` | done |
| Audio | `src/audio/` | done + verified numerically |
| HUD (title / countdown / pause / results) | `src/ui/` | done |

Scene cost at the reference capture: **~53 draw calls, ~355k triangles**.

## Known rough edges

An honest list of what is not finished to a high bar:

- **Distant foliage still shimmers.** All three tree LOD tiers now use
  alpha-to-coverage against the multisampled scene pass, which fixes the worst
  of it, but the mid-distance band is still busy. The proper fix is
  coverage-preserving alpha — rescaling alpha by mip level so thin branches do
  not dissolve and reappear.
- **Motion blur is strong** at speed and smears the treeline. It suits the
  genre but sits close to too much.
- **The countdown digit did not appear** in the captured `countdown` state. The
  CSS uses `animation-fill-mode: both`, so it should persist; this was not
  chased down and may simply be capture timing.
- **Uber tricks** are implemented but have not been visually verified end to
  end.
- Only one course exists, and there are no opponents or race mode.

## On the original goal

The brief asked for something that beats Call of Duty in a blind side-by-side.
That is not a bar this can clear, and no critic pass should be read as clearing
it: CoD is a native engine shipping hundreds of gigabytes of photoscanned,
artist-authored assets, against zero-asset procedural WebGL generated in code.
Judge this against good real-time WebGL work instead.
