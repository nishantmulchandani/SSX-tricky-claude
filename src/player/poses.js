/**
 * OWNER: agent "character".
 *
 * Everything that decides where the rider's limbs go. `rig.js` is the solver;
 * this file is the animator.
 *
 * ── The one idea that makes this work ──────────────────────────────────────
 * The feet are BOLTED TO THE BOARD. In board space the ankles never move: they
 * sit in the bindings, full stop. So the legs are not animated at all — they
 * are a *consequence* of where the pelvis is. Crouch, ollie, landing squash,
 * grab tuck and crash all reduce to "move the pelvis, re-run leg IK", and the
 * knees then bend by exactly the right amount for free, which is why the stance
 * never slides off the board.
 *
 * The arms are the opposite: they are driven by an IK target, so a grab can
 * name a point on the board and the hand goes *there*. When the target is out
 * of reach we do not shrug and let the arm float — we fold the whole body
 * towards it (see `_reachRefine`), which is what a real rider does and is the
 * difference between a grab that connects and a grab that mimes.
 *
 * ── Board space, and stance ────────────────────────────────────────────────
 *   -Z nose   +Z tail   +Y up   +X = the toe edge for a regular rider
 * A regular rider faces +X. Riding switch, the body is turned 180 degrees and
 * faces -X; the bindings do not move. `sgn` (+1 / -1) is that facing, and it
 * falls out of `tricks.stance`. Because the pelvis frame is rebuilt from `sgn`
 * every frame, mirroring the whole pose is that single number — every lean,
 * twist and hand target below is expressed in the pelvis frame or scaled by it.
 *
 * Which *bone* is the nose-side limb also flips with stance: for a regular
 * rider the rig's 'R' chain lands on the nose side, and switch swaps it. Hence
 * `noseSide`/`tailSide` rather than left/right anywhere below.
 */
import * as THREE from 'three';
import { D, ARM_REACH, aimQuat } from './rig.js';

const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const damp = (cur, tgt, rate, dt) => cur + (tgt - cur) * (1 - Math.exp(-rate * dt));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a || 1e-6), 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

// ── stance geometry (board space) ──────────────────────────────────────────
export const STANCE = {
  noseZ: -0.255,          // front binding centre
  tailZ: 0.255,           // rear binding centre
  angleNose: 0.30,        // binding angle, radians, rotated towards the nose
  angleTail: -0.14,       // slight duck on the rear foot
  ankleY: D.ankleY,
  heelOffset: 0.055,      // ankle sits behind the ball of the foot
};

/**
 * Standing (fully extended) pelvis height, and the deepest tuck the pose code
 * asks for on its own. `_reachRefine` is allowed to go below PELVIS_LOW, down
 * to PELVIS_FLOOR, because a grab genuinely needs the hips level with the
 * bindings and hanging off the heel edge — anywhere higher and the hand simply
 * cannot get to the board, arms being 0.54 m and the shoulder a metre up.
 */
const PELVIS_TALL = 1.010;
const PELVIS_LOW = 0.420;
const PELVIS_FLOOR = 0.285;
const PELVIS_OUT = 0.345;      // furthest the hips may swing to the heel side

// Where each grab lands on the board. `where` picks the position along the
// board, `edge` picks the side. Straight out of trickTable.js.
const GRAB_Z = { nose: -0.585, tail: 0.585, between: 0.00, behind: 0.320, through: 0.075 };
const GRAB_X = { toe: 0.132, heel: -0.132, nose: 0.0, tail: 0.0, both: 0.0 };

function armSlot() {
  return {
    target: V3(), pole: V3(), handDir: V3(0, -1, 0), palm: V3(0, 0, 1), shrug: 0,
  };
}
function legSlot() {
  return { ankle: V3(), pole: V3(), toe: V3(1, 0, 0), up: V3(0, 1, 0) };
}

export function createPose() {
  return {
    pelvis: V3(), pelvisQ: new THREE.Quaternion(),
    spine: { bend: 0, twist: 0, side: 0 },
    head: { pitch: 0, yaw: 0, roll: 0 },
    arm: { L: armSlot(), R: armSlot() },
    leg: { L: legSlot(), R: legSlot() },
  };
}

// scratch
const _a = V3(), _b = V3(), _c = V3(), _d = V3(), _e = V3();
const _q = new THREE.Quaternion();

/**
 * A scalar critically-damped spring. Used for every squash-and-stretch channel
 * so impulses (ollie pop, landing impact) decay with real overshoot instead of
 * a linear fade.
 */
class Spring {
  constructor(k = 90, z = 0.7) { this.v = 0; this.dv = 0; this.k = k; this.z = z; }
  kick(a) { this.dv += a; }
  step(dt, target = 0) {
    // Sub-step so a long frame cannot explode the integrator.
    const n = Math.min(6, Math.max(1, Math.ceil(dt * 90)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.dv += (-this.k * (this.v - target) - 2 * this.z * Math.sqrt(this.k) * this.dv) * h;
      this.v += this.dv * h;
    }
    return this.v;
  }
}

export class PoseSolver {
  constructor() {
    this.pose = createPose();
    this.t = 0;

    // secondary motion / reaction state
    this.squash = new Spring(150, 0.42);     // vertical, drives pelvis height
    this.lean = new Spring(70, 0.75);        // fore/aft weight
    this.side = new Spring(60, 0.70);        // lateral weight
    this.headYaw = new Spring(46, 0.80);
    this.headPitch = new Spring(46, 0.85);
    this.armLag = [V3(), V3()];              // hand target lag, [nose, tail]
    this.armVel = [V3(), V3()];

    this._prevGrounded = true;
    this._prevCrouch = 0;
    this._prevImpact = 0;
    this._airT = 0;
    this._grabBlend = 0;
    this._grabRef = null;
    this._crashT = 0;
    this._crashSeed = 0;
    this._fold = 0;          // extra knee fold demanded by a reach, 0..1
    this._reach = 0;
    this._breath = 0;
    this._stanceBlend = 0;   // smoothed facing sign, so a switch landing turns
  }

  // ── the neutral riding stance ────────────────────────────────────────────
  /**
   * The bind pose. The skin is generated from this, so it is deliberately the
   * pose the rider spends most of its life in — deformation away from bind then
   * stays small and the elbows/knees never shear.
   */
  bindPose() {
    this._fill({
      sgn: 1, pelvisY: 0.958, pelvisX: -0.034, pelvisZ: -0.010,
      lean: 0.30, side: 0.06, twist: 0.34, roll: 0,
      headPitch: -0.05, headYaw: 0.42, headRoll: 0,
      armNose: V3(0.335, 0.995, -0.470), armTail: V3(0.300, 0.930, 0.455),
      handSpread: 1, shrug: 0,
    });
    return this.pose;
  }

  // ── per-frame ────────────────────────────────────────────────────────────
  /**
   * @param rig    a RiderRig — solved in place, possibly more than once
   * @param body   physics body (see docs/INTERFACES.md)
   * @param tricks TrickSystem, read-only; every field is optional-chained
   */
  update(dt, body, tricks, rig) {
    this.t += dt;
    const d = Math.min(dt, 1 / 20);

    const stance = tricks?.stance ? 1 : 0;
    // Turning switch is a real 180 of the torso; blend it so the rider pivots.
    this._stanceBlend = damp(this._stanceBlend, stance, 7, d);
    const sgn = 1 - 2 * this._stanceBlend;

    const grounded = !!body.grounded;
    const phase = tricks?.phase ?? (grounded ? 'ground' : 'air');
    const crashed = !!body.crashed;
    const speed01 = clamp((body.speed ?? 0) / 55, 0, 1);

    // ---- impulses -----------------------------------------------------------
    // Ollie: the crouch charge collapsing as the board leaves the snow is the
    // pop. Read the *drop* in crouch rather than a flag so it also fires for a
    // natural launch off a lip.
    const crouch = clamp(body.crouch ?? 0, 0, 1);
    if (this._prevGrounded && !grounded) {
      this.squash.kick(this._prevCrouch * 5.2 + 1.1);
      this._airT = 0;
    }
    // Landing: compress hard, proportional to how much velocity got eaten.
    const impact = body.lastLandImpact ?? 0;
    if (!this._prevGrounded && grounded) {
      this.squash.kick(-clamp(impact / 12, 0.25, 3.4));
    }
    this._prevGrounded = grounded;
    this._prevCrouch = crouch;
    this._prevImpact = impact;
    if (!grounded) this._airT += d; else this._airT = 0;

    if (crashed) this._crashT += d; else if (this._crashT > 0) { this._crashT = 0; this._crashSeed = Math.random() * 100; }

    // ---- vertical: crouch, squash, air tuck ---------------------------------
    const R = tricks?.rotation ?? {};
    const spinRate = Math.abs(R.spinRate ?? 0);
    const flipRate = Math.abs(R.flipRate ?? 0);
    const grab = (!grounded && !crashed) ? (tricks?.grab ?? null) : null;
    this._grabBlend = damp(this._grabBlend, grab ? 1 : 0, grab ? 13 : 8, d);
    if (grab) this._grabRef = grab;
    const gb = this._grabBlend;
    const gref = this._grabRef;

    // How balled-up the rider is, 0 (standing) .. 1 (knees in the chest).
    // Airborne rotation implies a tuck: you cannot spin a 900 spread-eagled.
    const spinTuck = smooth(0.55, 2.3, spinRate) * 0.62 + smooth(0.3, 1.4, flipRate) * 0.5;
    const airSettle = smooth(0.0, 0.45, this._airT);
    // A rider is never straight-legged: 0.10 is the standing athletic bend.
    let tuck = grounded
      ? clamp(0.10 + crouch * 0.62, 0, 1)
      : clamp(0.30 + spinTuck, 0, 1) * airSettle + 0.08;
    if (phase === 'grind') tuck = Math.max(tuck, 0.34);

    const sq = this.squash.step(d, 0);
    // Deep, fast carves ride lower; so does high speed.
    const carveDrop = Math.abs(body.edge ?? 0) * 0.075 * speed01;

    this._breath += d * (grounded ? 1.6 : 2.6);
    const breath = Math.sin(this._breath) * 0.006 + Math.sin(this._breath * 2.3 + 1.1) * 0.003;

    // ---- lean: carve angulation and fore/aft weight -------------------------
    const roll = body.roll ?? 0;
    const edge = body.edge ?? 0;
    // Inclination: the board banks by `roll` at the group level; the rider must
    // angulate *further* the same way or they read as a plank glued to a plate.
    const angulate = grounded ? sgn * roll * 0.62 * (0.4 + 0.6 * speed01) : 0;
    const leanTarget = 0.30 + carveDrop * 1.6 + (grounded ? 0 : 0.10)
      + tuck * 0.42 + angulate;
    const sideTarget = sgn * (0.10 + edge * 0.16 * speed01);

    this.lean.step(d, leanTarget);
    this.side.step(d, sideTarget);

    // ---- head: spot the landing, lead the spin ------------------------------
    const spinLead = clamp((R.spinRate ?? 0) * -0.34, -0.75, 0.75);
    const wob = (tricks?.wobble ?? 0);
    this.headYaw.step(d, sgn * (0.44 + (grounded ? 0.10 * speed01 : 0.20)) + spinLead
      + Math.sin(this.t * 17) * 0.10 * wob);
    this.headPitch.step(d, grounded ? -0.06 - 0.12 * speed01 : -0.16 - 0.20 * clamp(this._airT, 0, 1));

    // ---- pelvis -------------------------------------------------------------
    let pelvisY = lerp(PELVIS_TALL, PELVIS_LOW + 0.10, tuck) + sq * 0.085 - carveDrop + breath;
    // Weight moves back over the tail under acceleration and forward on a nose
    // press; a static centred pelvis is the single most robotic thing possible.
    let pelvisZ = -0.010 + sgn * 0.0 + (grounded ? edge * 0.02 : 0);
    let pelvisX = -0.030 * sgn - this.lean.v * 0.055 * sgn;

    const p = {
      sgn, pelvisY, pelvisX, pelvisZ,
      lean: this.lean.v, side: this.side.v,
      twist: sgn * (0.34 + (grounded ? 0.06 * speed01 : 0.16)) - spinLead * 0.30,
      roll,
      headPitch: this.headPitch.v, headYaw: this.headYaw.v, headRoll: sgn * -edge * 0.14,
      armNose: null, armTail: null, handSpread: 1, shrug: 0,
    };

    // ---- arms ---------------------------------------------------------------
    const noseB = sgn > 0 ? 'R' : 'L';   // the rig chain that lands nose-side
    const tailB = sgn > 0 ? 'L' : 'R';
    this._noseB = noseB; this._tailB = tailB;

    this._armDefaults(p, body, tricks, tuck, sgn, speed01);

    // Grab: aim one (or both) hands at a point on the board.
    this._grabTarget = null;
    if (gb > 0.01 && gref) this._applyGrab(p, gref, gb, sgn);

    // Crash overrides everything above.
    if (this._crashT > 0) this._crashPose(p, body, sgn);

    // Follow-through: hands never snap to a new target. During a grab the
    // spring is stiff (the hand is committed and has to actually land on the
    // board); free-air hands are loose and trail the body.
    this._lagHands(d, p, gb);

    this._fill(p);
    rig.solve(this.pose);

    // ---- whole-body reach refinement ---------------------------------------
    if (this._grabTarget && this._crashT <= 0) this._reachRefine(p, rig);

    return this.pose;
  }

  /** Critically-damped spring on each wrist target — one frame of overlap. */
  _lagHands(dt, p, grabBlend) {
    const k = lerp(110, 420, grabBlend);
    const zeta = 0.9;
    const h = Math.min(dt, 1 / 45);
    const slots = [p.armNose, p.armTail];
    for (let i = 0; i < 2; i++) {
      const lag = this.armLag[i], vel = this.armVel[i], tgt = slots[i];
      if (lag.lengthSq() === 0) { lag.copy(tgt); continue; }
      _a.copy(tgt).sub(lag).multiplyScalar(k).addScaledVector(vel, -2 * zeta * Math.sqrt(k));
      vel.addScaledVector(_a, h);
      lag.addScaledVector(vel, h);
      tgt.copy(lag);
    }
  }

  // ── default arm behaviour ───────────────────────────────────────────────
  _armDefaults(p, body, tricks, tuck, sgn, speed01) {
    const grounded = !!body.grounded;
    const R = tricks?.rotation ?? {};
    const spin = clamp((R.spinRate ?? 0) / 2.4, -1, 1);
    const t = this.t;

    // Riding: arms low and open, counter-swinging gently against the carve.
    // Air: arms come in and up as the tuck deepens; a spin throws the leading
    // arm across the chest and trails the other one, which is what actually
    // sells rotation direction.
    const openness = grounded ? 1 : lerp(1, 0.34, tuck);
    const swing = grounded
      ? -(body.edge ?? 0) * 0.10 * speed01
      : -spin * 0.20;
    const flap = Math.sin(t * 5.3) * 0.012 + Math.sin(t * 2.1 + 2) * 0.018;

    p.armNose = V3(
      sgn * (0.20 + 0.16 * openness),
      p.pelvisY + 0.09 + 0.09 * openness + flap,
      -0.28 - 0.22 * openness + swing * 0.5,
    );
    p.armTail = V3(
      sgn * (0.18 + 0.14 * openness),
      p.pelvisY + 0.03 + 0.10 * openness - flap,
      0.26 + 0.22 * openness + swing * 0.5,
    );
    if (!grounded) {
      // Spin: lead arm tucks across the chest, trail arm streams out.
      p.armNose.z += spin * 0.16;
      p.armTail.z += spin * 0.16;
      p.armNose.x -= sgn * Math.abs(spin) * 0.08;
    }
    if (tricks?.phase === 'grind') {
      const bal = tricks?.grindInfo?.balance ?? 0;
      p.armNose.y += 0.18 + bal * 0.10;
      p.armTail.y += 0.18 - bal * 0.10;
      p.armNose.z -= 0.10; p.armTail.z += 0.10;
    }
    p.shrug = grounded ? 0.04 : 0.12 + tuck * 0.20;
  }

  // ── grabs ────────────────────────────────────────────────────────────────
  /**
   * Turn a trickTable grab descriptor into an actual hand target on the board,
   * plus the body shape that makes it reachable. `tweak` covers the poses that
   * are about the *legs* rather than the hand (method's arch, japan's bone).
   */
  _applyGrab(p, g, blend, sgn) {
    const where = GRAB_Z[g.where] ?? 0;
    const ex = (GRAB_X[g.edge] ?? 0) * sgn;
    const target = V3(ex, 0.035, where);

    // Tip grabs wrap the hand around the end of the board, not the edge.
    if (g.edge === 'nose') { target.set(0, 0.05, -0.60); }
    if (g.edge === 'tail') { target.set(0, 0.05, 0.60); }

    const both = g.hand === 'both';
    const none = g.hand === 'none';
    const noseHand = g.hand === 'front' || both;
    const tailHand = g.hand === 'rear' || both;

    // Fold up hard towards the board. This is the whole grab: knees to chest,
    // hips out over the heel edge, torso hinged down over the toe edge.
    const fold = 0.86;
    p.pelvisY = lerp(p.pelvisY, PELVIS_LOW, blend * fold);
    p.pelvisX = lerp(p.pelvisX, -sgn * 0.115, blend * 0.8);
    p.pelvisZ = lerp(p.pelvisZ, clamp(where * 0.22, -0.10, 0.10), blend * 0.8);
    p.lean = lerp(p.lean, 0.92, blend * 0.85);
    p.side = lerp(p.side, sgn * clamp(-where * 1.1, -0.42, 0.42), blend * 0.8);
    p.shrug = lerp(p.shrug, 0.42, blend);
    p.headPitch = lerp(p.headPitch, -0.34, blend * 0.7);

    switch (g.tweak) {
      case 'arch':          // method: hips thrown forward, back arched, board pulled up behind
        p.lean = lerp(p.lean, -0.34, blend * 0.9);
        p.pelvisX = lerp(p.pelvisX, sgn * 0.10, blend);
        p.pelvisY = lerp(p.pelvisY, PELVIS_LOW + 0.10, blend);
        p.side = lerp(p.side, sgn * 0.46, blend);
        p.headPitch = lerp(p.headPitch, 0.34, blend);
        break;
      case 'boned':         // japan: front leg kicked straight out
      case 'stiff':
        p.pelvisZ = lerp(p.pelvisZ, 0.09, blend);
        p.lean = lerp(p.lean, 1.05, blend);
        break;
      case 'vertical':      // rocket air: nose straight up, both hands on it
        p.lean = lerp(p.lean, 0.30, blend);
        p.side = lerp(p.side, sgn * -0.55, blend);
        p.pelvisZ = lerp(p.pelvisZ, 0.13, blend);
        break;
      case 'behindhead':
        p.headPitch = lerp(p.headPitch, 0.5, blend);
        p.lean = lerp(p.lean, 1.15, blend);
        break;
      case 'superman':      // both arms forward, legs trailing
        p.lean = lerp(p.lean, 1.25, blend);
        p.pelvisY = lerp(p.pelvisY, PELVIS_LOW + 0.20, blend);
        break;
      case 'christ':        // no hands: arms straight out to the sides
        p.lean = lerp(p.lean, -0.10, blend);
        p.pelvisY = lerp(p.pelvisY, PELVIS_TALL - 0.08, blend);
        break;
      default: break;
    }

    if (none || g.tweak === 'christ') {
      p.armNose = V3(sgn * 0.10, p.pelvisY + 0.30, -0.72);
      p.armTail = V3(sgn * 0.10, p.pelvisY + 0.30, 0.72);
      return;
    }

    // Blend the hand from its free-air position onto the board.
    if (noseHand) p.armNose = p.armNose.lerp(target, blend);
    if (tailHand) p.armTail = p.armTail.lerp(target.clone().add(V3(0, 0, both ? 0.12 : 0)), blend);
    // The free hand counterbalances: thrown out and up, away from the grab.
    if (!noseHand) p.armNose = p.armNose.lerp(V3(sgn * 0.16, p.pelvisY + 0.42, -0.62), blend * 0.85);
    if (!tailHand) p.armTail = p.armTail.lerp(V3(sgn * 0.16, p.pelvisY + 0.42, 0.62), blend * 0.85);

    this._grabTarget = {
      point: target,
      bones: [noseHand ? this._noseB : null, tailHand ? this._tailB : null].filter(Boolean),
      blend,
    };
  }

  /**
   * Close the last few centimetres of a grab. After a first solve we know where
   * the shoulder actually ended up, so we can measure the real deficit and pay
   * for it by folding deeper and hinging further — the same two dials a rider
   * uses. Two iterations is enough to converge to within a centimetre, and
   * anything still out of reach is left visibly straining, which reads as
   * effort rather than as a bug.
   */
  _reachRefine(p, rig) {
    const G = this._grabTarget;
    for (let iter = 0; iter < 4; iter++) {
      let worst = 0;
      for (const s of G.bones) {
        const sh = rig.tip('clav' + s, _a);
        const d = _b.copy(G.point).sub(sh).length();
        worst = Math.max(worst, d - ARM_REACH * 0.94);
      }
      if (worst <= 0.004) break;
      const pay = clamp(worst, 0, 0.28) * G.blend;
      p.pelvisY = Math.max(PELVIS_FLOOR, p.pelvisY - pay * 0.90);
      p.lean = Math.min(2.05, p.lean + pay * 1.85);
      // Hips out over the heel edge: this is what actually buys the reach,
      // because it lets the shoulder drop without the legs having to shorten.
      p.pelvisX = p.sgn > 0
        ? Math.max(-PELVIS_OUT, p.pelvisX - pay * 0.55)
        : Math.min(PELVIS_OUT, p.pelvisX + pay * 0.55);
      this._fill(p);
      rig.solve(this.pose);
    }
  }

  // ── crash ────────────────────────────────────────────────────────────────
  /**
   * Procedural ragdoll. A real solver is overkill for a 1.6 s event that always
   * ends the same way, so instead every joint gets its own frequency, phase and
   * decay — limbs windmill, the torso jackknifes, the head snaps late. The
   * layered incommensurate frequencies are what keep it from reading as a loop.
   */
  _crashPose(p, body, sgn) {
    const t = this._crashT;
    const s = this._crashSeed;
    const fade = Math.exp(-t * 0.55);
    const flail = (f, ph, a) => Math.sin(t * f + ph + s) * a * fade;

    p.pelvisY = clamp(0.66 + flail(9.1, 0.3, 0.16) - t * 0.06, 0.46, 0.95);
    p.pelvisX = -sgn * (0.10 + flail(6.7, 1.1, 0.10));
    p.pelvisZ = flail(5.3, 2.2, 0.10);
    p.lean = 0.55 + flail(7.9, 0.7, 0.85);
    p.side = flail(6.1, 1.9, 0.75);
    p.twist = sgn * 0.2 + flail(4.7, 3.1, 0.9);
    p.headPitch = flail(11.3, 0.4, 0.85);
    p.headYaw = sgn * 0.3 + flail(8.9, 2.6, 0.9);
    p.headRoll = flail(10.1, 1.4, 0.6);
    p.shrug = 0.5;

    const r = 0.62;
    p.armNose = V3(
      sgn * (0.14 + flail(8.3, 0.0, r)),
      p.pelvisY + 0.30 + flail(6.9, 1.7, r),
      -0.30 + flail(7.7, 2.9, r),
    );
    p.armTail = V3(
      sgn * (0.14 + flail(7.1, 3.4, r)),
      p.pelvisY + 0.30 + flail(9.7, 0.9, r),
      0.30 + flail(6.3, 1.2, r),
    );
  }

  // ── assemble the pose object the rig consumes ────────────────────────────
  _fill(p) {
    const P = this.pose;
    const sgn = p.sgn;
    const facing = _c.set(sgn, 0, 0);
    const up = _d.set(0, 1, 0);

    P.pelvis.set(p.pelvisX, p.pelvisY, p.pelvisZ);
    aimQuat(P.pelvisQ, up, facing);

    // `bend` is positive-backwards in the rig, so a forward hinge is negative.
    P.spine.bend = -p.lean;
    P.spine.twist = p.twist;
    P.spine.side = p.side;
    P.head.pitch = p.headPitch;
    P.head.yaw = p.headYaw;
    P.head.roll = p.headRoll;

    // ---- arms ---------------------------------------------------------------
    const noseB = sgn > 0 ? 'R' : 'L';
    const tailB = sgn > 0 ? 'L' : 'R';
    this._setArm(P.arm[noseB], p.armNose, p, sgn, -1);
    this._setArm(P.arm[tailB], p.armTail, p, sgn, 1);

    // ---- legs: ankles are fixed in the bindings ------------------------------
    this._setLeg(P.leg[noseB], STANCE.noseZ, STANCE.angleNose, p, sgn);
    this._setLeg(P.leg[tailB], STANCE.tailZ, STANCE.angleTail, p, sgn);
  }

  _setArm(slot, targetPos, p, sgn, zside) {
    // The IK target is the WRIST; the palm lands a hand-length further on, so
    // aim first and then walk the target back down the arm. Without this every
    // grab sits a full hand short of the board.
    _a.copy(targetPos);
    const chest = _b.set(p.pelvisX + sgn * p.lean * 0.16, p.pelvisY + 0.44, p.pelvisZ);
    _e.copy(_a).sub(chest);
    if (_e.lengthSq() < 1e-8) _e.set(0, -1, 0);
    _e.normalize();
    slot.handDir.copy(_e);
    slot.target.copy(_a).addScaledVector(_e, -D.hand * 0.80);

    // Elbow pole: out and behind, on the heel side, dropped below the wrist.
    slot.pole.copy(slot.target)
      .addScaledVector(_c.set(-sgn, 0, 0), 0.34)
      .add(_d.set(0, -0.30, zside * 0.24));

    // Back of the hand: perpendicular to the reach, biased upwards.
    slot.palm.set(0, 1, 0).addScaledVector(_e, -_e.y);
    if (slot.palm.lengthSq() < 1e-6) slot.palm.set(sgn, 0, 0);
    slot.palm.normalize();
    slot.shrug = p.shrug;
  }

  _setLeg(slot, z, angle, p, sgn) {
    // Binding angles are measured off the perpendicular: 0 means the toes point
    // straight at the toe edge, positive rotates them towards the nose.
    const toeX = Math.cos(angle) * sgn;
    const toeZ = -Math.sin(angle) * sgn;
    slot.toe.set(toeX, 0, toeZ).normalize();
    slot.up.set(0, 1, 0);
    slot.ankle.set(
      -slot.toe.x * STANCE.heelOffset,
      STANCE.ankleY,
      z - slot.toe.z * STANCE.heelOffset,
    );
    // Knees track out over the toes, and open wider the deeper the fold — the
    // classic frog tuck. Pushing the pole far away keeps the solver stable.
    const openness = clamp((PELVIS_TALL - p.pelvisY) / 0.42, 0, 1);
    slot.pole.set(
      slot.ankle.x + sgn * (1.1 + openness * 0.5),
      slot.ankle.y + 0.55 - openness * 0.30,
      slot.ankle.z + Math.sign(z) * openness * 0.75,
    );
  }
}
