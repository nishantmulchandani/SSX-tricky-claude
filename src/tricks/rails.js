/**
 * OWNER: agent "tricks".
 *
 * Rails / grinds. The rail *geometry* belongs to the props owner — this module
 * only consumes it, through a deliberately loose adapter so that it is a
 * complete no-op until props ships something. See docs/REQUESTS-tricks.md for
 * the interface being asked for:
 *
 *     props.nearestRail(pos, maxDist) -> null | {
 *       point, tangent, dist, id, t, length, kind
 *     }
 *
 * Fallbacks the adapter also understands, so props can ship the cheap version
 * first: `props.rails` as an array of `{a,b}` / `{start,end}` / `{points:[]}`.
 */

import * as THREE from 'three';
import { clamp, wrapPi, deg, grindName, grindDifficulty } from './trickTable.js';

const RAIL_RIDE_HEIGHT = 0.11;
const SNAP_DIST = 0.95;      // how close the board must pass to catch a rail
const HOLD_DIST = 1.70;      // how far it may drift before the grind drops
const MIN_GRIND_SPEED = 5.0;

const _p = new THREE.Vector3();
const _t = new THREE.Vector3();
const _ab = new THREE.Vector3();
const _ap = new THREE.Vector3();

function vec(o, out) {
  if (!o) return null;
  if (o.isVector3) return out.copy(o);
  if (Array.isArray(o)) return out.set(o[0] || 0, o[1] || 0, o[2] || 0);
  if (typeof o.x === 'number') return out.set(o.x, o.y || 0, o.z || 0);
  return null;
}

/** Closest point on segment a->b to p. Writes into out, returns { d2, t }. */
function closestOnSegment(a, b, p, out) {
  _ab.copy(b).sub(a);
  _ap.copy(p).sub(a);
  const len2 = _ab.lengthSq();
  const t = len2 > 1e-9 ? clamp(_ap.dot(_ab) / len2, 0, 1) : 0;
  out.copy(a).addScaledVector(_ab, t);
  return { d2: out.distanceToSquared(p), t, len: Math.sqrt(len2) };
}

/**
 * Resolves whatever the props owner has published into one function.
 * Re-probes periodically so a hot-reloaded props module is picked up.
 */
export class RailAdapter {
  constructor() {
    this.query = null;
    this.source = 'none';
    this._nextProbe = 0;
    this._hit = {
      point: new THREE.Vector3(), tangent: new THREE.Vector3(),
      dist: 0, id: -1, t: 0, length: 0, kind: 'rail',
    };
  }

  _props() {
    return globalThis.__game?.props ?? globalThis.__props ?? null;
  }

  probe(now) {
    if (now < this._nextProbe) return;
    this._nextProbe = now + 1.0;
    const p = this._props();
    if (!p) { this.query = null; this.source = 'none'; return; }

    if (typeof p.nearestRail === 'function') {
      this.query = (pos, maxDist) => this._normalise(p.nearestRail(pos, maxDist), pos);
      this.source = 'props.nearestRail';
      return;
    }
    const list = p.rails ?? p.grindables ?? null;
    if (Array.isArray(list) && list.length) {
      this.query = (pos, maxDist) => this._brute(list, pos, maxDist);
      this.source = `props.rails[${list.length}]`;
      return;
    }
    this.query = null;
    this.source = 'none';
  }

  _normalise(raw, pos) {
    if (!raw) return null;
    const h = this._hit;
    const pt = vec(raw.point ?? raw.pos ?? raw.p ?? raw.position, h.point);
    if (!pt) return null;
    const tg = vec(raw.tangent ?? raw.dir ?? raw.direction ?? raw.tan, h.tangent);
    if (!tg || tg.lengthSq() < 1e-9) return null;
    h.tangent.normalize();
    h.dist = raw.dist ?? raw.distance ?? h.point.distanceTo(pos);
    h.id = raw.id ?? raw.index ?? 0;
    h.t = raw.t ?? 0;
    h.length = raw.length ?? raw.len ?? 0;
    h.kind = raw.kind ?? raw.type ?? 'rail';
    return h;
  }

  _brute(list, pos, maxDist) {
    let best = null, bestD2 = maxDist * maxDist;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), out = new THREE.Vector3();
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      const segs = r.points && r.points.length >= 2
        ? r.points
        : [r.a ?? r.start ?? r.p0, r.b ?? r.end ?? r.p1];
      for (let s = 0; s + 1 < segs.length; s++) {
        if (!vec(segs[s], a) || !vec(segs[s + 1], b)) continue;
        const res = closestOnSegment(a, b, pos, out);
        if (res.d2 < bestD2) {
          bestD2 = res.d2;
          best = { p: out.clone(), tan: b.clone().sub(a).normalize(), t: res.t, len: res.len, id: r.id ?? i, kind: r.kind ?? 'rail' };
        }
      }
    }
    if (!best) return null;
    const h = this._hit;
    h.point.copy(best.p); h.tangent.copy(best.tan);
    h.dist = Math.sqrt(bestD2); h.id = best.id; h.t = best.t; h.length = best.len; h.kind = best.kind;
    return h;
  }
}

/**
 * Grind state machine. Drives `body` directly while locked to a rail — this is
 * the one place the trick system writes body position, because the rail *is*
 * the surface and board.js only knows about the height field.
 */
export class GrindState {
  constructor(adapter) {
    this.adapter = adapter;
    this.reset();
  }

  reset() {
    this.active = false;
    this.name = '';
    this.time = 0;
    this.points = 0;
    this.balance = 0;
    this.balanceVel = 0;
    this.press = 0;
    this.dark = false;
    this.angle = 0;
    this.railId = -1;
    this.dir = 1;
    this.entryYaw = 0;
    this.seed = 1;
    this.bail = false;
    this.wobble = 0;
  }

  available() { return !!this.adapter.query; }

  /** Deterministic smooth drift so grinds are learnable, not random. */
  _noise(t) {
    return Math.sin(t * 3.1 + this.seed) * 0.6 + Math.sin(t * 7.7 + this.seed * 2.3) * 0.4;
  }

  /** @returns true when a rail was caught this step. */
  tryEnter(body, stance) {
    if (!this.adapter.query || this.active) return false;
    if (body.speed < MIN_GRIND_SPEED || body.crashed) return false;
    let hit = null;
    try { hit = this.adapter.query(body.pos, SNAP_DIST * 2.2); } catch { return false; }
    if (!hit || hit.dist > SNAP_DIST) return false;
    // Must be coming down onto it, not punching up through it.
    if (body.pos.y < hit.point.y - 0.55) return false;
    if (body.vel.y > 4.0) return false;

    this.active = true;
    this.time = 0;
    this.points = 0;
    this.balance = 0;
    this.balanceVel = 0;
    this.bail = false;
    this.railId = hit.id;
    this.seed = (hit.id * 12.9898 + 78.233) % 6.283;
    this.entryYaw = body.yaw;
    _t.copy(hit.tangent);
    this.dir = _t.dot(body.vel) >= 0 ? 1 : -1;
    this.updateName(body, stance);
    return true;
  }

  updateName(body, stance) {
    const railYaw = Math.atan2(_t.x * this.dir, -_t.z * this.dir);
    this.angle = deg(wrapPi(body.yaw - railYaw));
    this.name = grindName(this.angle, this.press, this.dark, stance);
  }

  /**
   * @param intent mutable { steer, pitch } — the grind consumes both.
   * @returns null while grinding, or a result object when it ends.
   */
  step(dt, input, body, stance) {
    if (!this.active) return null;
    let hit = null;
    try { hit = this.adapter.query(body.pos, HOLD_DIST * 1.5); } catch { hit = null; }
    if (!hit || hit.dist > HOLD_DIST || hit.id !== this.railId) return this.exit(body, 'end');

    this.time += dt;
    _t.copy(hit.tangent).multiplyScalar(this.dir);

    // Lock to the rail line.
    _p.copy(hit.point); _p.y += RAIL_RIDE_HEIGHT;
    body.pos.copy(_p);

    // Speed along the rail: gravity component minus steel friction.
    let sp = body.vel.dot(_t);
    if (sp < 0) sp = Math.abs(body.vel.length()) * 0.2;
    sp += -22.0 * _t.y * dt;                    // gravity along the rail
    sp *= Math.exp(-0.16 * dt);                 // friction
    body.vel.copy(_t).multiplyScalar(Math.max(0, sp));
    body.up.set(0, 1, 0);

    // Press + darkslide read live off the sticks.
    const pitch = input.axis.pitch;
    this.press = pitch < -0.45 ? -1 : pitch > 0.45 ? 1 : 0;
    if (input.down('prewind') && input.down('spinL')) this.dark = true;
    if (input.justPressed('spinR')) this.dark = false;

    // Free rotation on the rail for transfers / re-grinds.
    const spin = (input.down('spinR') ? 1 : 0) - (input.down('spinL') ? 1 : 0);
    if (spin && !input.down('prewind')) body.yaw -= spin * 1.6 * dt;
    this.updateName(body, stance);

    // ---- balance -----------------------------------------------------------
    // Unstable equilibrium: the further you lean, the harder it pulls. The
    // rail angle and any press make it worse. Steer is the only correction.
    const hard = 0.35 + Math.abs(Math.sin(this.angle * Math.PI / 180)) * 0.55 + Math.abs(this.press) * 0.35
      + (this.dark ? 0.5 : 0);
    const drift = this._noise(this.time) * 0.55 * hard;
    const acc = drift + this.balance * (1.6 * hard) - input.axis.steer * 3.1;
    this.balanceVel = (this.balanceVel + acc * dt) * Math.exp(-2.4 * dt);
    this.balance = clamp(this.balance + this.balanceVel * dt, -1.4, 1.4);
    this.wobble = Math.abs(this.balance);
    if (Math.abs(this.balance) >= 1) return this.exit(body, 'bail');

    // ---- scoring -----------------------------------------------------------
    const diff = grindDifficulty(this.name);
    const speedF = clamp(body.speed / 25, 0.4, 1.5);
    const styleF = 1 + (1 - Math.abs(this.balance)) * 0.35;
    this.points += 150 * diff * speedF * styleF * dt;

    if (input.justPressed('jump')) return this.exit(body, 'pop');
    if (body.speed < 2.5) return this.exit(body, 'stall');
    return null;
  }

  exit(body, reason) {
    const res = {
      name: this.name || '50-50',
      time: this.time,
      points: this.points,
      reason,
      difficulty: grindDifficulty(this.name || '50-50'),
      balance: this.balance,
    };
    if (reason === 'pop') {
      body.vel.y += 8.5;
      res.points *= 1.15;
    } else if (reason === 'bail') {
      res.points = 0;
    }
    this.active = false;
    this.time = 0;
    this.points = 0;
    this.dark = false;
    this.press = 0;
    return res;
  }
}
