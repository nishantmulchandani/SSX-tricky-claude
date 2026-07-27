import * as THREE from 'three';
import { fbm2, ridged2, hash2 } from '../core/noise.js';

/**
 * Terrain is the single source of truth for the mountain surface.
 * EVERY other system (physics, props, VFX, camera) queries it through
 * this interface and must never duplicate the height math.
 *
 *   heightAt(x, z)   -> world Y of the snow surface
 *   normalAt(x, z)   -> unit surface normal (central difference)
 *   courseAt(t)      -> { pos, tangent, width } along the run's centre spline
 *   distanceAlong(x,z) -> approximate progress t in [0,1] down the run
 *
 * The run descends along -Z. Course centre meanders in X.
 */

export const COURSE_LENGTH = 6400; // metres of -Z
export const COURSE_START_Y = 1750;

// Banked wall bounding the run. Low enough to launch off, steep enough to hold
// a line in. BERM_RUN is how far it takes to reach full height.
// The banked wall bounding the run. This is what actually keeps riders on the
// course: a 35deg bank they can carve up and that gravity rolls them back down.
//
// An explicit barrier constraint in the physics was tried instead and was
// strictly worse — a hard position clamp pinned riders against the crest for
// tens of seconds, and a velocity spring got eaten by edge grip, so they
// drifted out and stayed out. The terrain already solves this; the padded wall
// is drawn at the crest purely as the visual full stop.
export const BERM_H = 11;
export const BERM_RUN = 16;

/**
 * Lateral limit of the rideable course at a depth: the top of the berm, which
 * is where the padded barrier stands. Physics and the props layer both use
 * this so the wall you can see is exactly the wall you hit.
 */
export function trackLimitAt(z) {
  return courseWidthAt(z) * 0.5 + BERM_RUN;
}

// --- course centre spline -------------------------------------------------
// A hand-tuned meander so the run reads as a designed course, not noise.
// Sweeping, flowing turns — not a slalom.
//
// This used to swing +/-95m in X against a ~21m half-width, which meant the
// track was permanently running away sideways faster than a player could
// correct: even a committed corrective input could not hold the course. A race
// line should curve enough to be interesting and read as a designed circuit,
// while staying rideable at 60 m/s.
const CTRL = [
  [0, 0], [6, 0.06], [-14, 0.13], [-26, 0.21], [-10, 0.28],
  [18, 0.35], [32, 0.42], [16, 0.49], [-12, 0.56], [-34, 0.63],
  [-22, 0.70], [4, 0.77], [26, 0.84], [12, 0.91], [0, 1.0],
];
const _curve = new THREE.CatmullRomCurve3(
  CTRL.map(([x, t]) => new THREE.Vector3(x, 0, -t * COURSE_LENGTH)),
  false, 'catmullrom', 0.5,
);

// --- baked course tables --------------------------------------------------
/**
 * heightAt() needs the course centre and width at several z values per call,
 * and CatmullRomCurve3.getPointAt does an arc-length binary search every time —
 * roughly 550ns a lookup. Baking the spline into a flat table once at module
 * load turns that into two array reads and a lerp.
 */
const LUT_N = 2048;
const LUT_DZ = COURSE_LENGTH / (LUT_N - 1);
const LUT_X = new Float64Array(LUT_N);
const LUT_W = new Float64Array(LUT_N);
{
  const p = new THREE.Vector3();
  for (let i = 0; i < LUT_N; i++) {
    const c = i / (LUT_N - 1);
    _curve.getPointAt(c, p);
    LUT_X[i] = p.x;
    // Track width. Deliberately narrow and fairly consistent: SSX courses read
    // as a ribbon you are held inside, not an open field. It opens a little in
    // the middle third for the big feature sections and pinches at the gates.
    LUT_W[i] = 38 + 14 * Math.sin(c * Math.PI) + 4.0 * Math.sin(c * 7.0);
  }
}

/** Linear sample of a baked table by course parameter t in [0,1]. */
function lut(table, t) {
  const f = (t <= 0 ? 0 : t >= 1 ? 1 : t) * (LUT_N - 1);
  const i = f | 0;
  if (i >= LUT_N - 1) return table[LUT_N - 1];
  const a = table[i];
  return a + (table[i + 1] - a) * (f - i);
}

const _cPos = new THREE.Vector3();
const _cTan = new THREE.Vector3();
export function courseAt(t) {
  const c = THREE.MathUtils.clamp(t, 0, 1);
  const pos = _curve.getPointAt(c, _cPos);
  const tangent = _curve.getTangentAt(c, _cTan);
  return { pos, tangent, width: lut(LUT_W, c) };
}

/** Course half-width at a depth z. Cheap — table lookup only. */
export function courseWidthAt(z) {
  return lut(LUT_W, -z / COURSE_LENGTH);
}

/** Course centre X for a given depth z (z is negative going downhill). */
export function courseXAt(z) {
  return lut(LUT_X, -z / COURSE_LENGTH);
}

export function progressAt(z) {
  return THREE.MathUtils.clamp(-z / COURSE_LENGTH, 0, 1);
}

// --- authored course features ---------------------------------------------
/**
 * Discrete, hand-placed features layered on top of the smooth run. Each has
 * compact support so it only perturbs its own patch of mountain, and each is
 * expressed as a displacement in metres above the base course surface.
 *
 * `z` is the downhill centre of the feature (negative). The rider approaches
 * from larger z and travels towards smaller z, so a kicker ramps up over
 * [z, z+len] and ends in a vertical lip at z.
 *
 *   kicker  — takeoff ramp ending in a lip. `h` = lip height, `len` = ramp run.
 *   table   — kicker + flat deck + landing ramp. `gap` = deck length.
 *   quarter — concave wall on one side of the run for vertical hits.
 *   roller  — rideable bump you can pump or pop off.
 *   drop    — a step down; the run simply falls away.
 *   hip     — an angled takeoff that throws you across the fall line.
 */
const FEATURES = [
  // --- section 1: warm-up. Read the line, find the rhythm. ----------------
  { type: 'roller',  z: -240,  h: 3.0,  len: 44, off: 0,   w: 26 },
  { type: 'roller',  z: -340,  h: 3.4,  len: 40, off: 0,   w: 26 },
  { type: 'kicker',  z: -520,  h: 6.5,  len: 30, off: 0,   w: 22 },
  { type: 'roller',  z: -760,  h: 3.8,  len: 46, off: -5,  w: 24 },

  // --- section 2: first real airs, still forgiving ------------------------
  { type: 'table',   z: -1040, h: 8.0,  len: 32, off: 0,   w: 24, gap: 38 },
  { type: 'quarter', z: -1330, h: 9,    len: 70, off: 13,  w: 14, side: 1 },
  { type: 'kicker',  z: -1600, h: 9.0,  len: 32, off: -4,  w: 22 },
  { type: 'drop',    z: -1860, h: 12,   len: 26, off: 0,   w: 34 },

  // --- section 3: rhythm run. Three hits in quick succession. -------------
  { type: 'roller',  z: -2060, h: 4.4,  len: 38, off: 4,   w: 24 },
  { type: 'roller',  z: -2160, h: 4.8,  len: 36, off: -3,  w: 24 },
  { type: 'hip',     z: -2340, h: 10,   len: 34, off: -7,  w: 22, side: -1 },
  { type: 'table',   z: -2640, h: 11,   len: 38, off: 0,   w: 26, gap: 56 },

  // --- section 4: the steep. Big, committing features. --------------------
  { type: 'quarter', z: -2960, h: 12,   len: 78, off: -14, w: 15, side: -1 },
  { type: 'kicker',  z: -3240, h: 12,   len: 36, off: 4,   w: 24 },
  { type: 'drop',    z: -3500, h: 19,   len: 30, off: 0,   w: 38 },
  { type: 'roller',  z: -3740, h: 4.8,  len: 44, off: -6,  w: 26 },

  // --- section 5: the money jump, then a technical stretch ----------------
  { type: 'table',   z: -4000, h: 13,   len: 40, off: 0,   w: 28, gap: 70 },
  { type: 'hip',     z: -4320, h: 11,   len: 36, off: 8,   w: 22, side: 1 },
  { type: 'quarter', z: -4620, h: 11,   len: 74, off: 14,  w: 15, side: 1 },
  { type: 'kicker',  z: -4900, h: 13,   len: 38, off: -5,  w: 24 },

  // --- section 6: run to the line. Fast, flowing, one last hit. -----------
  { type: 'roller',  z: -5160, h: 4.0,  len: 44, off: 0,   w: 28 },
  { type: 'table',   z: -5400, h: 14,   len: 42, off: 3,   w: 28, gap: 78 },
  { type: 'kicker',  z: -5740, h: 10,   len: 34, off: -4,  w: 24 },
  { type: 'roller',  z: -6000, h: 2.6,  len: 48, off: 0,   w: 30 },
];

/** Smooth 0..1 lateral falloff so features blend into the piste at their edges. */
function lateralFalloff(dx, w) {
  const t = 1 - THREE.MathUtils.clamp(Math.abs(dx) / w, 0, 1);
  return t * t * (3 - 2 * t);
}

/** Total displacement from authored features at (x, z). */
function featureHeight(x, z, cx) {
  let d = 0;
  for (let i = 0; i < FEATURES.length; i++) {
    const f = FEATURES[i];
    const s = z - f.z;                    // >0 = uphill of the feature
    const span = f.len + (f.gap || 0) + 60;
    if (s < -span || s > span) continue;  // compact support

    const dx = x - (cx + f.off);
    const lat = lateralFalloff(dx, f.w);
    if (lat <= 0) continue;

    switch (f.type) {
      case 'roller': {
        // Symmetric cosine bump — pump it or pop off the crest.
        if (Math.abs(s) > f.len) break;
        d += f.h * lat * 0.5 * (1 + Math.cos((s / f.len) * Math.PI));
        break;
      }
      case 'kicker': {
        // Ramps up over [0, len] approaching the lip at s = 0, then falls away.
        if (s < 0 || s > f.len) break;
        const t = 1 - s / f.len;          // 0 at the base, 1 at the lip
        d += f.h * lat * Math.pow(t, 1.7) * (1 + 0.25 * t); // late kick for pop
        break;
      }
      case 'hip': {
        // Like a kicker but the deck tilts, throwing the rider sideways.
        if (s < 0 || s > f.len) break;
        const t = 1 - s / f.len;
        const tilt = 1 + (f.side * dx / f.w) * 0.55;
        d += f.h * lat * Math.pow(t, 1.6) * tilt;
        break;
      }
      case 'table': {
        // takeoff ramp | flat deck | landing ramp
        const deck = f.gap;
        if (s >= 0 && s <= f.len) {
          const t = 1 - s / f.len;
          d += f.h * lat * Math.pow(t, 1.7);
        } else if (s < 0 && s >= -deck) {
          d += f.h * lat;                                    // deck
        } else if (s < -deck && s >= -deck - f.len * 1.6) {
          const t = (-s - deck) / (f.len * 1.6);             // landing ramp down
          d += f.h * lat * (1 - t) * (1 - t);
        }
        break;
      }
      case 'drop': {
        // A step: ground falls away below s = 0 and recovers over the runout.
        if (s > 0) break;
        const t = THREE.MathUtils.clamp(-s / (f.len * 3), 0, 1);
        d -= f.h * lat * (1 - t) * (1 - t);
        break;
      }
      case 'quarter': {
        // Concave wall rising off one edge of the run — vertical hits.
        if (Math.abs(s) > f.len) break;
        const along = 0.5 * (1 + Math.cos((s / f.len) * Math.PI));
        const u = THREE.MathUtils.clamp((dx * f.side) / f.w, 0, 1);
        d += f.h * along * u * u * (3 - 2 * u);
        break;
      }
    }
  }
  return d;
}

/** Public: is this point on an authored feature? Used by props and VFX. */
export function featureAt(x, z) {
  return featureHeight(x, z, courseXAt(z));
}

export function courseFeatures() { return FEATURES; }

// --- height field ---------------------------------------------------------

/** Base downhill fall-line: steep at the top, a flat-ish outrun at the bottom. */
function fallLine(t) {
  // Integral of a slope profile — steeper up top, mellowing out near the base.
  const steep = 1.0 - 0.55 * smoothstep(0.55, 1.0, t);
  return COURSE_START_Y * (1 - Math.pow(t, 1.18)) * steep + COURSE_START_Y * 0.06 * (1 - t);
}

function smoothstep(a, b, x) {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Signed distance from the course centre, normalised by half-width.
 * 0 at the centre line, 1 at the edge of the groomed run, >1 off-piste.
 */
export function lateralOffset(x, z) {
  const p = progressAt(z);
  return (x - lut(LUT_X, p)) / (lut(LUT_W, p) * 0.5);
}

/**
 * The rideable surface of the run itself: the fall line plus banking, rollers
 * and fine snow texture. Smooth and continuous by construction — anything that
 * would buck the rider belongs in the relief term, not here.
 */
function courseSurface(x, z, p, cx, halfWidth, lod) {
  const u = (x - cx) / halfWidth; // -1 .. 1 across the groomed run
  let h = fallLine(p);

  // Banked turns — the course rolls into its own corners.
  const curvature = (lut(LUT_X, progressAt(z - 80)) - 2 * cx + lut(LUT_X, progressAt(z + 80))) / (80 * 80);
  // Banking is an ANGLE, not a fixed height. Expressing it as metres of rise
  // at the edge meant narrowing the track turned every corner into a ~55deg
  // wall the rider slid down and stalled against. tan(22deg) ~= 0.40 at full
  // lock, scaled by the local half-width.
  const bank = THREE.MathUtils.clamp(curvature * 1.6e4, -1, 1) * 0.40;
  h += THREE.MathUtils.clamp(u, -1.2, 1.2) * halfWidth * bank;

  // Gentle rollers down the fall line — rideable, pumpable, never a wall.
  h += Math.sin(z * 0.017 + Math.sin(z * 0.0031) * 2.0) * 4.2;
  h += Math.sin(z * 0.052 + x * 0.004) * 1.15;

  // Snow surface texture, retired band by band as the sample spacing grows.
  // A 12cm wind ripple evaluated at a vertex 200m from its neighbour is pure
  // cost: it cannot be represented, and it only aliases.
  //
  // Amplitudes here are deliberately small. A groomed race line has to be
  // smooth enough to hold an edge on; lumpy noise underfoot reads as a messy
  // hillside and makes the carve feel vague.
  if (lod < 30) h += fbm2(x * 0.013, z * 0.013, lod < 8 ? 4 : 2) * 0.9;
  if (lod < 4) h += fbm2(x * 0.085, z * 0.085, 3) * 0.18;
  if (lod < 1) h += Math.sin(x * 0.5 + fbm2(x * 0.04, z * 0.04, 2) * 6.0) * 0.06;

  return h;
}

/**
 * Off-piste relief, in metres above the course surface. Always >= 0, so the
 * run is guaranteed to sit at the bottom of its own valley no matter what the
 * noise does. Amplitude is driven entirely by distance from the course, which
 * is what keeps the corridor open and rideable.
 */
function relief(x, z, distFromCourse, halfWidth, lod) {
  // Distance outside the groomed ribbon.
  const d = distFromCourse - halfWidth;

  // Inside the ribbon: perfectly clean. Nothing here, ever. This is what makes
  // the course read as a built track rather than a patch of open mountain, and
  // it also skips all the multifractal work for every vertex the rider can
  // actually ride on.
  if (d <= 0) return 0;

  // --- berm ---------------------------------------------------------------
  // A banked wall rising straight off the edge of the piste, like the lip of a
  // bobsleigh run. It is rideable: you can carve up it, and it holds a bad
  // line in rather than letting the rider wander into scenery. This single
  // feature is most of what makes a course feel like a course.
  const bermT = smoothstep(0, BERM_RUN, d);
  const berm = bermT * bermT * BERM_H;

  // --- shoulder and flanks -------------------------------------------------
  const shoulder = smoothstep(BERM_RUN, BERM_RUN + 140, d);
  const far = smoothstep(BERM_RUN + 90, 900, d);

  let r = berm;
  if (shoulder <= 0 && far <= 0) return r;

  const crest = Math.pow(THREE.MathUtils.clamp(ridged2(x * 0.00042, z * 0.00042, lod < 60 ? 5 : 3), 0, 1), 1.4);
  const bulk = fbm2(x * 0.0016, z * 0.0016, lod < 60 ? 4 : 2) * 0.5 + 0.5;

  r += shoulder * (10 + bulk * 22);
  r += far * far * (crest * 1150 + bulk * 320);
  // Broken ground beyond the berm so the flanks are not smooth ramps. Kept
  // off the berm itself, which must stay clean enough to carve.
  if (shoulder > 0 && lod < 50) {
    r += shoulder * (fbm2(x * 0.006, z * 0.006, 4) * 9
      + (lod < 12 ? ridged2(x * 0.02, z * 0.02, 3) * 4 : 0));
  }
  return r;
}

/**
 * World Y of the snow surface.
 *
 * @param lod  world-space distance between neighbouring samples, in metres.
 *   Detail bands finer than this are skipped: they cannot be represented at
 *   that sampling rate and only cost time and aliasing. Physics and anything
 *   needing the true surface must pass 0 (the default).
 */
export function heightAt(x, z, lod = 0) {
  const p = progressAt(z);
  // Table lookups only — courseAt() allocates a result object and walks the
  // spline, which is far too heavy for the hot path.
  const halfWidth = lut(LUT_W, p) * 0.5;
  const cx = lut(LUT_X, p);
  const dist = Math.abs(x - cx);

  let h = courseSurface(x, z, p, cx, halfWidth, lod)
    + relief(x, z, dist, halfWidth, lod);
  // Authored features are 25-100m long; past that spacing they are invisible.
  if (lod < 40) h += featureHeight(x, z, cx);
  return h;
}

const _n = new THREE.Vector3();
export function normalAt(x, z, eps = 1.2) {
  const hL = heightAt(x - eps, z), hR = heightAt(x + eps, z);
  const hD = heightAt(x, z - eps), hU = heightAt(x, z + eps);
  return _n.set(hL - hR, 2 * eps, hD - hU).normalize().clone();
}

/** Cheap reusable normal that avoids the per-call clone (hot physics path). */
export function normalInto(out, x, z, eps = 1.2) {
  const hL = heightAt(x - eps, z), hR = heightAt(x + eps, z);
  const hD = heightAt(x, z - eps), hU = heightAt(x, z + eps);
  return out.set(hL - hR, 2 * eps, hD - hU).normalize();
}

/** Slope angle in radians at a point (0 = flat). */
export function slopeAt(x, z) {
  const n = normalInto(_n, x, z);
  return Math.acos(THREE.MathUtils.clamp(n.y, -1, 1));
}

export { hash2 };
