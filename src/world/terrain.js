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

export function courseAt(t) {
  const c = THREE.MathUtils.clamp(t, 0, 1);
  const pos = _curve.getPointAt(c);
  const tangent = _curve.getTangentAt(c);
  // Course pinches at the top (start gate) and flares through the mid-section.
  const width = 46 + 34 * Math.sin(c * Math.PI) + 10 * Math.sin(c * 11.0);
  return { pos, tangent, width };
}

/** Course centre X for a given depth z (z is negative going downhill). */
export function courseXAt(z) {
  const t = THREE.MathUtils.clamp(-z / COURSE_LENGTH, 0, 1);
  return _curve.getPointAt(t).x;
}

export function progressAt(z) {
  return THREE.MathUtils.clamp(-z / COURSE_LENGTH, 0, 1);
}

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
  const { width } = courseAt(progressAt(z));
  return (x - courseXAt(z)) / (width * 0.5);
}

/**
 * The rideable surface of the run itself: the fall line plus banking, rollers
 * and fine snow texture. Smooth and continuous by construction — anything that
 * would buck the rider belongs in the relief term, not here.
 */
function courseSurface(x, z, p, cx, halfWidth) {
  const u = (x - cx) / halfWidth; // -1 .. 1 across the groomed run
  let h = fallLine(p);

  // Banked turns — the course rolls into its own corners.
  const curvature = (courseXAt(z - 80) - 2 * cx + courseXAt(z + 80)) / (80 * 80);
  h += THREE.MathUtils.clamp(curvature * 1.2e4, -1, 1) * THREE.MathUtils.clamp(u, -1.4, 1.4) * 16;

  // Gentle rollers down the fall line — rideable, pumpable, never a wall.
  h += Math.sin(z * 0.017 + Math.sin(z * 0.0031) * 2.0) * 4.2;
  h += Math.sin(z * 0.052 + x * 0.004) * 1.15;

  // Snow surface texture: drifts, then wind ripples.
  h += fbm2(x * 0.013, z * 0.013, 4) * 2.6;
  h += fbm2(x * 0.085, z * 0.085, 3) * 0.42;
  h += Math.sin(x * 0.5 + fbm2(x * 0.04, z * 0.04, 2) * 6.0) * 0.09;

  return h;
}

/**
 * Off-piste relief, in metres above the course surface. Always >= 0, so the
 * run is guaranteed to sit at the bottom of its own valley no matter what the
 * noise does. Amplitude is driven entirely by distance from the course, which
 * is what keeps the corridor open and rideable.
 */
function relief(x, z, distFromCourse, halfWidth) {
  // Rise profile: flat shoulder just off the piste, then walls over ~800m.
  const d = Math.max(0, distFromCourse - halfWidth * 1.15);
  const near = smoothstep(0, 90, d);        // low banks framing the run
  const far = smoothstep(60, 850, d);       // the actual mountain flanks

  const crest = Math.pow(THREE.MathUtils.clamp(ridged2(x * 0.00042, z * 0.00042, 5), 0, 1), 1.4);
  const bulk = fbm2(x * 0.0016, z * 0.0016, 4) * 0.5 + 0.5;

  let r = near * (14 + bulk * 26);                       // banks
  r += far * far * (crest * 1150 + bulk * 320);          // flanks and peaks
  // Mid-scale broken ground off-piste so the flanks aren't smooth ramps.
  r += near * (fbm2(x * 0.006, z * 0.006, 4) * 9 + ridged2(x * 0.02, z * 0.02, 3) * 4);
  return r;
}

export function heightAt(x, z) {
  const p = progressAt(z);
  const { width } = courseAt(p);
  const halfWidth = width * 0.5;
  const cx = courseXAt(z);
  const dist = Math.abs(x - cx);

  return courseSurface(x, z, p, cx, halfWidth) + relief(x, z, dist, halfWidth);
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
