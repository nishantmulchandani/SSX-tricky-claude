/**
 * OWNER: agent "audio".
 *
 * "Whiteout Ledge" — an original driving big-beat / breakbeat loop, synthesised
 * from oscillators and noise. No samples, no external assets, and deliberately
 * not a reproduction of any existing track: the pattern tables and the A-minor
 * riff below are written for this game.
 *
 * Timing is sequenced against AudioContext.currentTime with a lookahead
 * scheduler (never setInterval / rAF for note times) — the frame loop only asks
 * "has the horizon moved?", and every note is placed on the audio clock, so
 * jitter is sample-accurate regardless of frame rate.
 *
 * The mix breathes with the ride: `intensity` (speed + combo) opens the master
 * music filter, brings in the acid lead and the extra percussion layer, and
 * pushes the bass drive. A big combo run genuinely lifts the track.
 */

import { clamp, lerp, glide, semi, makeDriveCurve } from './dsp.js';

const BPM = 142;
const STEPS = 32;                       // two bars of sixteenths
const STEP = 60 / BPM / 4;              // seconds per sixteenth ~= 0.1056
const LOOP = STEPS * STEP;

// --- pattern tables --------------------------------------------------------
// Sixteenth-grid positions. The kick deliberately avoids a straight four so the
// groove stumbles forward the way big beat should.
const KICK   = [0, 6, 10, 16, 22, 26, 29];
const SNARE  = [4, 12, 20, 28];
const GHOST  = [7, 15, 23, 31];          // quiet snare flams between the backbeats
const OPENHAT = [6, 14, 22, 30];
const PERC   = [2, 9, 13, 18, 25, 27];   // extra layer, fades in with intensity
const RIDE_ACCENT = [0, 8, 16, 24];

// Hat velocity per sixteenth — the swing lives here, not in the timing.
const HAT_VEL = [
  1.00, 0.34, 0.62, 0.30, 0.88, 0.32, 0.58, 0.36,
  0.94, 0.30, 0.66, 0.28, 0.86, 0.34, 0.60, 0.40,
  1.00, 0.32, 0.62, 0.30, 0.90, 0.30, 0.56, 0.38,
  0.92, 0.34, 0.68, 0.26, 0.84, 0.36, 0.64, 0.46,
];

// Four 8-step groups: Am - Am - F - G, rooted on A1.
const ROOTS = [0, 0, -4, -2];
// Riff inside each group: {step, semitone offset, length in steps, accent}
const BASS_FIG = [
  { s: 0, o: 0,  d: 2.6, a: 1.00 },
  { s: 3, o: 0,  d: 1.0, a: 0.62 },
  { s: 5, o: 12, d: 1.0, a: 0.78 },
  { s: 6, o: 7,  d: 1.7, a: 0.55 },
];

// Acid lead, A-minor pentatonic + the b6 for grit. null = rest.
const LEAD = [
  0, null, 12, 10, null, 7, null, 3,
  0, null, 7, null, 10, 12, null, 15,
  0, null, 12, 10, null, 7, null, 5,
  3, null, 7, 10, null, 12, 15, 12,
];
const LEAD_ACCENT = new Set([0, 2, 8, 13, 16, 18, 24, 29, 30]);

const A1 = 55;      // bass root
const A3 = 220;     // lead root

export class MusicEngine {
  /**
   * @param ctx   AudioContext or OfflineAudioContext
   * @param dest  input node of the music bus
   * @param send  { reverb, delay } send nodes (may be null)
   */
  constructor(ctx, dest, send = {}, opts = {}) {
    this.ctx = ctx;
    this.rnd = opts.rnd || Math.random;

    // --- music-local bus -------------------------------------------------
    // Everything passes the "lift" filter; that single cutoff is what makes a
    // combo run feel like the track opened up.
    this.filter = ctx.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.frequency.value = 1200;
    this.filter.Q.value = 0.8;

    this.tilt = ctx.createBiquadFilter();     // gentle high shelf, adds air
    this.tilt.type = 'highshelf';
    this.tilt.frequency.value = 5200;
    this.tilt.gain.value = 2.5;

    this.out = ctx.createGain();
    this.out.gain.value = 1.0;

    this.filter.connect(this.tilt).connect(this.out).connect(dest);
    if (send.reverb) { this.revSend = ctx.createGain(); this.revSend.gain.value = 0.13; this.out.connect(this.revSend).connect(send.reverb); }
    if (send.delay)  { this.dlySend = ctx.createGain(); this.dlySend.gain.value = 0.10; this.out.connect(this.dlySend).connect(send.delay); }

    // Drums bypass the lift filter's low end by having their own path — a
    // muffled kick just sounds broken, so only the tone-ful parts get filtered.
    this.drumBus = ctx.createGain();
    this.drumBus.gain.value = 0.95;
    this.drumBus.connect(this.tilt);

    this.drive = ctx.createWaveShaper();
    this.drive.curve = makeDriveCurve(4096, 2.0);
    this.drive.oversample = '2x';
    this.bassBus = ctx.createGain();
    this.bassBus.gain.value = 0.9;
    this.bassBus.connect(this.drive).connect(this.tilt);

    this.leadBus = ctx.createGain();
    this.leadBus.gain.value = 0.0;           // faded in by intensity
    this.leadBus.connect(this.filter);

    this.padBus = ctx.createGain();
    this.padBus.gain.value = 0.0;
    this.padBus.connect(this.filter);

    // --- state -----------------------------------------------------------
    this.bpm = BPM;
    this.stepDur = STEP;
    this.stepsPerLoop = STEPS;
    this.loopDur = LOOP;
    this.startTime = 0;
    this.step = 0;
    this.nextStepTime = 0;
    this.lookahead = 0.28;
    this.intensity = 0;
    this.running = false;

    this.patterns = { kick: KICK, snare: SNARE, ghost: GHOST, openhat: OPENHAT, perc: PERC };
  }

  start(time) {
    if (this.running) return;
    this.running = true;
    this.startTime = time + 0.06;
    this.nextStepTime = this.startTime;
    this.step = 0;
    this._pad(this.startTime);
  }

  /** @param now current audio-clock time (real or simulated) */
  schedule(now, intensity) {
    if (!this.running) return;
    this.intensity = intensity;
    const t = now;

    // Continuous lift: cutoff and lead level follow intensity every frame.
    const cut = 700 + 9200 * Math.pow(intensity, 0.75);
    glide(this.filter.frequency, cut, t, 0.25, 5);
    glide(this.filter.Q, 0.7 + 2.6 * intensity, t, 0.3, 0.02);
    glide(this.leadBus.gain, 0.06 + 0.5 * Math.pow(intensity, 1.3), t, 0.35, 0.003);
    glide(this.padBus.gain, 0.16 + 0.20 * intensity, t, 0.5, 0.003);
    glide(this.tilt.gain, 1.5 + 4.0 * intensity, t, 0.4, 0.02);

    let guard = 0;
    while (this.nextStepTime < t + this.lookahead && guard++ < 256) {
      this._step(this.step % STEPS, this.nextStepTime);
      this.nextStepTime += STEP;
      this.step++;
      // Re-arm the two-bar pad on the loop boundary.
      if (this.step % STEPS === 0) this._pad(this.nextStepTime);
    }
  }

  // -------------------------------------------------------------------------
  // sequencing
  // -------------------------------------------------------------------------

  _step(s, t) {
    const I = this.intensity;

    if (KICK.includes(s)) this._kick(t, s === 0 || s === 16 ? 1.0 : 0.86);
    if (SNARE.includes(s)) this._snare(t, 0.9);
    if (GHOST.includes(s)) this._snare(t, 0.24 + 0.14 * I, true);

    // Hats: closed on the grid, open on the pushes.
    const hv = HAT_VEL[s];
    if (hv > 0.25) this._hat(t, hv * (0.55 + 0.45 * I), OPENHAT.includes(s));
    if (RIDE_ACCENT.includes(s)) this._hat(t + 0.002, 0.5, false, 1.6);

    // Extra industrial percussion only once the run is going.
    if (I > 0.45 && PERC.includes(s)) this._perc(t, 0.30 * (I - 0.45) / 0.55 + 0.10);

    // Bass: 4 groups of 8, each with the same figure on a different root.
    const grp = (s / 8) | 0;
    const local = s % 8;
    for (const f of BASS_FIG) {
      if (f.s !== local) continue;
      const freq = A1 * semi(ROOTS[grp] + f.o);
      this._bass(t, freq, f.d * STEP, f.a);
    }

    // Acid lead — sparse when cruising, every note when the combo is up.
    const n = LEAD[s];
    if (n !== null && n !== undefined) {
      const acc = LEAD_ACCENT.has(s);
      if (I > 0.12 && (acc || I > 0.38)) {
        this._lead(t, A3 * semi(n), STEP * (acc ? 1.7 : 0.9), acc ? 1.0 : 0.62);
      }
    }
  }

  // -------------------------------------------------------------------------
  // voices — all built from oscillators + generated noise
  // -------------------------------------------------------------------------

  _kick(t, v = 1) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(155, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.10);
    o.frequency.exponentialRampToValueAtTime(36, t + 0.30);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.95 * v, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0008, t + 0.34);

    // beater click — a hair of noise-free transient keeps it audible on laptops
    const c = ctx.createOscillator();
    c.type = 'triangle';
    c.frequency.setValueAtTime(1300, t);
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.16 * v, t);
    cg.gain.exponentialRampToValueAtTime(0.0004, t + 0.02);

    o.connect(g).connect(this.drumBus);
    c.connect(cg).connect(this.drumBus);
    o.start(t); o.stop(t + 0.38);
    c.start(t); c.stop(t + 0.03);
  }

  _snare(t, v = 1, ghost = false) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.playbackRate.value = 0.9 + this.rnd() * 0.25;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(ghost ? 2600 : 1750, t);
    bp.frequency.exponentialRampToValueAtTime(ghost ? 1800 : 900, t + 0.14);
    bp.Q.value = ghost ? 1.4 : 0.85;

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 320;

    const g = ctx.createGain();
    const dur = ghost ? 0.055 : 0.17;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.55 * v, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);

    src.connect(bp).connect(hp).connect(g).connect(this.drumBus);
    src.start(t, this.rnd() * 2);
    src.stop(t + dur + 0.02);

    if (!ghost) {
      // body tone: two detuned triangles give the shell its pitch
      for (const f of [186, 268]) {
        const o = ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.setValueAtTime(f, t);
        o.frequency.exponentialRampToValueAtTime(f * 0.82, t + 0.09);
        const og = ctx.createGain();
        og.gain.setValueAtTime(0.20 * v, t);
        og.gain.exponentialRampToValueAtTime(0.0004, t + 0.10);
        o.connect(og).connect(this.drumBus);
        o.start(t); o.stop(t + 0.12);
      }
    }
  }

  _hat(t, v = 1, open = false, qmul = 1) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.playbackRate.value = 1.3 + this.rnd() * 0.5;

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = open ? 6200 : 7600;
    hp.Q.value = 0.7 * qmul;

    const peak = ctx.createBiquadFilter();
    peak.type = 'peaking';
    peak.frequency.value = 10500;
    peak.Q.value = 1.2;
    peak.gain.value = 5;

    const dur = open ? 0.16 : 0.036;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.20 * v, t + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0004, t + dur);

    src.connect(hp).connect(peak).connect(g).connect(this.drumBus);
    src.start(t, this.rnd() * 2);
    src.stop(t + dur + 0.02);
  }

  _perc(t, v) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'square';
    const f = 380 + this.rnd() * 900;
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * 0.55, t + 0.05);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = f * 1.4; bp.Q.value = 5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.28 * v, t);
    g.gain.exponentialRampToValueAtTime(0.0004, t + 0.07);
    o.connect(bp).connect(g).connect(this.drumBus);
    o.start(t); o.stop(t + 0.09);
  }

  _bass(t, freq, dur, v) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(freq, t);
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(freq, t);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 6;
    const base = 130 + 520 * v * (0.5 + 0.5 * this.intensity);
    lp.frequency.setValueAtTime(base * 3.4, t);
    lp.frequency.exponentialRampToValueAtTime(base, t + Math.max(0.04, dur * 0.7));

    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.34 * v, t + 0.006);
    g.gain.setTargetAtTime(0.0001, t + dur * 0.6, dur * 0.25);

    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0, t);
    sg.gain.linearRampToValueAtTime(0.26 * v, t + 0.008);
    sg.gain.setTargetAtTime(0.0001, t + dur * 0.6, dur * 0.25);

    o.connect(lp).connect(g).connect(this.bassBus);
    sub.connect(sg).connect(this.bassBus);
    const stop = t + dur + 0.14;
    o.start(t); o.stop(stop);
    sub.start(t); sub.stop(stop);
  }

  _lead(t, freq, dur, v) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(freq, t);
    const o2 = ctx.createOscillator();
    o2.type = 'square';
    o2.frequency.setValueAtTime(freq * 0.5, t);
    o2.detune.value = 7;

    // Resonant filter envelope — the whole point of an acid line.
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 9 + 8 * v;
    const top = clamp(freq * (5 + 9 * v) * (0.6 + 0.8 * this.intensity), 300, 11000);
    lp.frequency.setValueAtTime(top, t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(160, freq * 1.1), t + dur * 0.95);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.34 * v, t + 0.005);
    g.gain.setTargetAtTime(0.0001, t + dur * 0.55, dur * 0.22);

    const g2 = ctx.createGain();
    g2.gain.value = 0.35;

    o.connect(lp);
    o2.connect(g2).connect(lp);
    lp.connect(g).connect(this.leadBus);
    const stop = t + dur + 0.12;
    o.start(t); o.stop(stop);
    o2.start(t); o2.stop(stop);
  }

  /** Two-bar sustained pad — the harmonic bed the lead sits on. */
  _pad(t) {
    const ctx = this.ctx;
    const chord = [0, 3, 7, 12, 15];     // A minor add9-ish, voiced wide
    const dur = LOOP;
    for (let i = 0; i < chord.length; i++) {
      const o = ctx.createOscillator();
      o.type = i % 2 ? 'triangle' : 'sawtooth';
      o.frequency.value = A3 * 0.5 * semi(chord[i]);
      o.detune.value = (i - 2) * 6;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.055 / chord.length * (i === 0 ? 2 : 1), t + 0.35);
      g.gain.setValueAtTime(0.055 / chord.length * (i === 0 ? 2 : 1), t + dur - 0.4);
      g.gain.linearRampToValueAtTime(0, t + dur);
      o.connect(g).connect(this.padBus);
      o.start(t); o.stop(t + dur + 0.05);
    }
  }

  debugInfo() {
    return {
      bpm: this.bpm,
      stepDur: this.stepDur,
      stepsPerLoop: this.stepsPerLoop,
      loopDur: this.loopDur,
      startTime: this.startTime,
      kickSteps: KICK.slice(),
      snareSteps: SNARE.slice(),
      hatSteps: HAT_VEL.map((v, i) => (v > 0.25 ? i : -1)).filter((i) => i >= 0),
    };
  }
}

export const MUSIC_CONST = { BPM, STEPS, STEP, LOOP, KICK, SNARE, OPENHAT };
