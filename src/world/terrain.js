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

// --- course centre spline -------------------------------------------------
// A hand-tuned meander so the run reads as a designed course, not noise.
const CTRL = [
  [0, 0], [18, 0.06], [-40, 0.13], [-70, 0.2], [-20, 0.27],
  [55, 0.34], [95, 0.41], [40, 0.48], [-30, 0.55], [-95, 0.62],
  [-60, 0.69], [10, 0.76], [70, 0.83], [30, 0.9], [0, 1.0],
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
    // Course pinches at the top (start gate) and flares through the mid-section.
    LUT_W[i] = 46 + 34 * Math.sin(c * Math.PI) + 10 * Math.sin(c * 11.0);
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
  { type: 'roller',  z: -260,  h: 3.5,  len: 46, off: 0,   w: 40 },
  { type: 'kicker',  z: -520,  h: 7.0,  len: 30, off: 0,   w: 26 },
  { type: 'roller',  z: -760,  h: 4.2,  len: 52, off: -14, w: 34 },
  { type: 'table',   z: -1040, h: 8.5,  len: 34, off: 6,   w: 30, gap: 40 },
  { type: 'quarter', z: -1350, h: 20,   len: 90, off: 34,  w: 40, side: 1 },
  { type: 'kicker',  z: -1620, h: 9.5,  len: 32, off: -10, w: 28 },
  { type: 'drop',    z: -1880, h: 14,   len: 26, off: 0,   w: 70 },
  { type: 'roller',  z: -2080, h: 5.0,  len: 44, off: 12,  w: 36 },
  { type: 'hip',     z: -2340, h: 11,   len: 36, off: -18, w: 30, side: -1 },
  { type: 'table',   z: -2660, h: 12,   len: 40, off: 0,   w: 34, gap: 62 },
  { type: 'quarter', z: -2980, h: 26,   len: 100, off: -40, w: 44, side: -1 },
  { type: 'kicker',  z: -3260, h: 13,   len: 38, off: 8,   w: 30 },
  { type: 'drop',    z: -3520, h: 22,   len: 30, off: 0,   w: 80 },
  { type: 'roller',  z: -3760, h: 5.5,  len: 48, off: -16, w: 38 },
  { type: 'table',   z: -4020, h: 14,   len: 42, off: 0,   w: 36, gap: 78 },
  { type: 'hip',     z: -4340, h: 12,   len: 38, off: 22,  w: 32, side: 1 },
  { type: 'quarter', z: -4640, h: 24,   len: 96, off: 38,  w: 42, side: 1 },
  { type: 'kicker',  z: -4920, h: 15,   len: 40, off: -12, w: 32 },
  { type: 'roller',  z: -5180, h: 4.5,  len: 46, off: 0,   w: 40 },
  { type: 'table',   z: -5420, h: 16,   len: 44, off: 6,   w: 38, gap: 88 },
  { type: 'kicker',  z: -5760, h: 11,   len: 36, off: -8,  w: 30 },
  { type: 'roller',  z: -6020, h: 3.0,  len: 50, off: 0,   w: 44 },
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
  h += THREE.MathUtils.clamp(curvature * 1.2e4, -1, 1) * THREE.MathUtils.clamp(u, -1.4, 1.4) * 16;

  // Gentle rollers down the fall line — rideable, pumpable, never a wall.
  h += Math.sin(z * 0.017 + Math.sin(z * 0.0031) * 2.0) * 4.2;
  h += Math.sin(z * 0.052 + x * 0.004) * 1.15;

  // Snow surface texture, retired band by band as the sample spacing grows.
  // A 12cm wind ripple evaluated at a vertex 200m from its neighbour is pure
  // cost: it cannot be represented, and it only aliases.
  if (lod < 30) h += fbm2(x * 0.013, z * 0.013, lod < 8 ? 4 : 2) * 2.6;
  if (lod < 4) h += fbm2(x * 0.085, z * 0.085, 3) * 0.42;
  if (lod < 1) h += Math.sin(x * 0.5 + fbm2(x * 0.04, z * 0.04, 2) * 6.0) * 0.09;

  return h;
}

/**
 * Off-piste relief, in metres above the course surface. Always >= 0, so the
 * run is guaranteed to sit at the bottom of its own valley no matter what the
 * noise does. Amplitude is driven entirely by distance from the course, which
 * is what keeps the corridor open and rideable.
 */
function relief(x, z, distFromCourse, halfWidth, lod) {
  // Rise profile: flat shoulder just off the piste, then walls over ~800m.
  const d = Math.max(0, distFromCourse - halfWidth * 1.15);
  const near = smoothstep(0, 90, d);        // low banks framing the run
  const far = smoothstep(60, 850, d);       // the actual mountain flanks

  // On the groomed corridor both masks are zero, so none of the expensive
  // multifractal work below contributes anything. That is the common case for
  // every vertex the rider can actually touch.
  if (near <= 0 && far <= 0) return 0;

  const crest = Math.pow(THREE.MathUtils.clamp(ridged2(x * 0.00042, z * 0.00042, lod < 60 ? 5 : 3), 0, 1), 1.4);
  const bulk = fbm2(x * 0.0016, z * 0.0016, lod < 60 ? 4 : 2) * 0.5 + 0.5;

  let r = near * (14 + bulk * 26);                       // banks
  r += far * far * (crest * 1150 + bulk * 320);          // flanks and peaks
  // Mid-scale broken ground off-piste so the flanks aren't smooth ramps.
  // Its finest band is ~50m, so it is meaningless past that sample spacing.
  if (near > 0 && lod < 50) {
    r += near * (fbm2(x * 0.006, z * 0.006, 4) * 9
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
