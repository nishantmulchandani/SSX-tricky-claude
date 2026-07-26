/**
 * OWNER: agent "audio".
 *
 * Fully synthesised game audio. This project ships zero audio assets and never
 * touches the network — every sound below is built at runtime out of
 * oscillators, procedurally generated noise buffers, biquads and a convolution
 * reverb whose impulse response is computed from an exponential decay (dsp.js).
 *
 * Signal flow
 * -----------
 *   ride  ──▶ rideBus ──┐
 *   wind  ──▶ windBus ──┴──▶ airDuck ──┐
 *   sfx   ──▶ sfxBus  ─────────────────┤
 *   music ──▶ MusicEngine ──▶ musicDuck┤
 *                                      ├─▶ master ─▶ comp ─▶ limiter ─▶ out
 *   (sends) ──▶ convolver ──▶ revReturn┤
 *           └─▶ valley delay ─▶ dlyRet ┘
 *
 * The limiter is a tanh waveshaper with a mathematically bounded transfer
 * (|y| < 1 for every possible input), so the output can never clip regardless
 * of how many one-shots pile up.
 *
 * Interface (docs/INTERFACES.md):
 *   new GameAudio() -> { init(), update(dt, body, tricks) }
 *
 * `init(ctx)` optionally accepts a context. Passing an OfflineAudioContext puts
 * the engine on a simulated clock driven by update()'s dt, which is how
 * tools/audiotest.mjs renders the whole graph to PCM for numeric verification.
 */

import {
  clamp, lerp, smoothstep, glide, setNow,
  makeWhiteNoise, makePinkNoise, makeCrackle,
  makeImpulseResponse, makeTanhCurve, mulberry32,
} from './dsp.js';
import { MusicEngine } from './music.js';

const IDLE_BODY = {
  speed: 0, edge: 0, grounded: true, airTime: 0, crouch: 0,
  lastLandImpact: 0, crashed: false,
};

export class GameAudio {
  constructor(opts = {}) {
    this.ctx = null;
    this.ready = false;
    this.failed = false;
    this.volume = opts.volume ?? 0.9;
    this.muted = false;

    // simulated clock (offline render) vs. the real audio clock
    this.offline = false;
    this._t = 0;

    // Smoothed control signals. These — not the raw physics values — drive the
    // synth, so a single-frame spike never becomes an audible glitch.
    this.sSpeed = 0;
    this.sEdge = 0;
    this.sAir = 0;
    this.sIntensity = 0;

    this._prev = { grounded: true, crashed: false, score: 0, combo: 0, tricks: 0, airTime: 0 };
    this._paramClock = 0;
    this._lastStinger = -1;

    this.rnd = mulberry32(opts.seed ?? 0xC0FFEE);
    this.stats = { landings: 0, takeoffs: 0, crashes: 0, stingers: 0, comboUps: 0 };
  }

  // =========================================================================
  // setup
  // =========================================================================

  /**
   * @param ctx optional AudioContext / OfflineAudioContext. Omitted in game —
   *            main.js calls this from the first user gesture.
   */
  init(ctx) {
    if (this.ready || this.failed) return this.ready;
    try {
      const AC = ctx || (typeof AudioContext !== 'undefined'
        ? new AudioContext({ latencyHint: 'interactive' })
        : null);
      if (!AC) { this.failed = true; return false; }
      this.ctx = AC;
      this.offline = (typeof OfflineAudioContext !== 'undefined' && AC instanceof OfflineAudioContext)
        || (typeof AC.startRendering === 'function' && typeof AC.resume !== 'function');
      if (!this.offline && AC.state === 'suspended') AC.resume?.();

      this._t = this.offline ? 0 : AC.currentTime;
      this._buildBuffers();
      this._buildMaster();
      this._buildSpace();
      this._buildRide();
      this._buildWind();
      this._buildAir();
      this._buildMusic();
      this._startSources(this.now);

      this.ready = true;
      return true;
    } catch (e) {
      // Audio must never take the game down.
      this.failed = true;
      console.warn('[audio] init failed:', e);
      return false;
    }
  }

  get now() { return this.offline ? this._t : this.ctx.currentTime; }

  _buildBuffers() {
    const ctx = this.ctx;
    this.buf = {
      white: makeWhiteNoise(ctx, 4.0, 0x51D3),
      pink: makePinkNoise(ctx, 4.0, 0x7A1C),
      crackle: makeCrackle(ctx, 2.0, 0x1CE, 1100),
    };
  }

  // 8. MIXING — bus structure, glue compression, bounded limiter.
  _buildMaster() {
    const ctx = this.ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.volume;

    // Glue compressor: catches the pile-up when a landing, a crash and a
    // stinger all land in the same 50 ms, without pumping the music.
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -12;
    this.comp.knee.value = 8;
    this.comp.ratio.value = 6;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.22;

    // Bounded soft-clip brickwall — see makeTanhCurve: net transfer is
    // y = tanh(x), unity slope at 0, |y| < 1 for all x.
    this.limPre = ctx.createGain();
    this.limPre.gain.value = 0.25;
    this.limiter = ctx.createWaveShaper();
    this.limiter.curve = makeTanhCurve(8192, 0.25);
    this.limiter.oversample = 'none';   // 'none' keeps the bound exact

    this.master.connect(this.comp).connect(this.limPre).connect(this.limiter).connect(ctx.destination);

    this.airDuck = ctx.createGain();      // dips the world at takeoff
    this.airDuck.gain.value = 1;
    this.airDuck.connect(this.master);

    this.rideBus = ctx.createGain(); this.rideBus.gain.value = 1.0; this.rideBus.connect(this.airDuck);
    this.windBus = ctx.createGain(); this.windBus.gain.value = 1.0; this.windBus.connect(this.airDuck);
    this.sfxBus = ctx.createGain(); this.sfxBus.gain.value = 1.0; this.sfxBus.connect(this.master);
    this.musicDuck = ctx.createGain(); this.musicDuck.gain.value = 1.0; this.musicDuck.connect(this.master);
    this.musicBus = ctx.createGain(); this.musicBus.gain.value = 0.62; this.musicBus.connect(this.musicDuck);
  }

  // 6. REVERB / SPACE — generated IR + a valley slap-back.
  _buildSpace() {
    const ctx = this.ctx;

    this.reverbSend = ctx.createGain(); this.reverbSend.gain.value = 1;
    // Roll off sub and extreme treble before the convolver — a big IR turns
    // bass into mud and makes hiss sound like a swimming pool.
    this.revHP = ctx.createBiquadFilter(); this.revHP.type = 'highpass'; this.revHP.frequency.value = 210;
    this.revLP = ctx.createBiquadFilter(); this.revLP.type = 'lowpass'; this.revLP.frequency.value = 7200;

    this.convolver = ctx.createConvolver();
    this.convolver.normalize = true;
    this.convolver.buffer = makeImpulseResponse(ctx, {
      seconds: 3.4, decay: 2.0, preDelay: 0.020, damping: 0.6, earlyGain: 0.45,
    });
    this.revReturn = ctx.createGain();
    this.revReturn.gain.value = 0.30;      // modest wet — it's outdoors, not a church
    this.reverbSend.connect(this.revHP).connect(this.revLP).connect(this.convolver)
      .connect(this.revReturn).connect(this.master);

    // Valley echo: a couple of clear repeats, darkening as they bounce.
    this.delaySend = ctx.createGain(); this.delaySend.gain.value = 1;
    this.delay = ctx.createDelay(2.0);
    this.delay.delayTime.value = 0.46;
    this.dlyFB = ctx.createGain(); this.dlyFB.gain.value = 0.30;
    this.dlyDamp = ctx.createBiquadFilter(); this.dlyDamp.type = 'lowpass'; this.dlyDamp.frequency.value = 1900;
    this.dlyHP = ctx.createBiquadFilter(); this.dlyHP.type = 'highpass'; this.dlyHP.frequency.value = 300;
    this.dlyReturn = ctx.createGain(); this.dlyReturn.gain.value = 0.20;

    this.delaySend.connect(this.dlyHP).connect(this.delay);
    this.delay.connect(this.dlyDamp).connect(this.dlyFB).connect(this.delay);   // feedback loop
    this.delay.connect(this.dlyReturn).connect(this.master);
  }

  // -------------------------------------------------------------------------
  // 1. BOARD ON SNOW
  // -------------------------------------------------------------------------
  /**
   * Four looping layers on the ride bus:
   *
   *   hiss    broadband bed, the base "riding" sound. Centre frequency and
   *           gain climb with speed, brightening further on edge.
   *   carve   narrow resonant band that only exists when the edge is engaged —
   *           this is the "shhhk". Q rises with |edge| so it morphs from airy
   *           to focused and grainy as you commit to the turn.
   *   rumble  low-passed pink noise; the soft powder body under the board.
   *           Strongest flat, ducked on edge (you're cutting, not floating).
   *   grain   the crackle buffer, pitch-shifted by speed. Ice chatter.
   *
   * Every parameter is a setTargetAtTime target, never a direct assignment, so
   * sweeping the stick produces a continuous morph and never a zipper.
   */
  _buildRide() {
    const ctx = this.ctx;
    const mk = (buffer, rate) => {
      const s = ctx.createBufferSource();
      s.buffer = buffer; s.loop = true; s.playbackRate.value = rate;
      return s;
    };

    // -- hiss -------------------------------------------------------------
    this.hissSrc = mk(this.buf.white, 1.0);
    this.hissBP = ctx.createBiquadFilter(); this.hissBP.type = 'bandpass';
    this.hissBP.frequency.value = 700; this.hissBP.Q.value = 0.6;
    this.hissShelf = ctx.createBiquadFilter(); this.hissShelf.type = 'highshelf';
    this.hissShelf.frequency.value = 4000; this.hissShelf.gain.value = 0;
    this.hissGain = ctx.createGain(); this.hissGain.gain.value = 0;
    this.hissSrc.connect(this.hissBP).connect(this.hissShelf).connect(this.hissGain).connect(this.rideBus);

    // -- carve ------------------------------------------------------------
    this.carveSrc = mk(this.buf.white, 1.0);
    this.carveBP = ctx.createBiquadFilter(); this.carveBP.type = 'bandpass';
    this.carveBP.frequency.value = 2200; this.carveBP.Q.value = 1.2;
    this.carvePk = ctx.createBiquadFilter(); this.carvePk.type = 'peaking';
    this.carvePk.frequency.value = 3400; this.carvePk.Q.value = 2.2; this.carvePk.gain.value = 0;
    this.carveGain = ctx.createGain(); this.carveGain.gain.value = 0;
    this.carveSrc.connect(this.carveBP).connect(this.carvePk).connect(this.carveGain).connect(this.rideBus);

    // -- powder rumble ----------------------------------------------------
    this.rumbleSrc = mk(this.buf.pink, 1.0);
    this.rumbleLP = ctx.createBiquadFilter(); this.rumbleLP.type = 'lowpass';
    this.rumbleLP.frequency.value = 180; this.rumbleLP.Q.value = 0.9;
    this.rumbleGain = ctx.createGain(); this.rumbleGain.gain.value = 0;
    this.rumbleSrc.connect(this.rumbleLP).connect(this.rumbleGain).connect(this.rideBus);

    // -- ice grain --------------------------------------------------------
    this.grainSrc = mk(this.buf.crackle, 1.0);
    this.grainBP = ctx.createBiquadFilter(); this.grainBP.type = 'bandpass';
    this.grainBP.frequency.value = 2600; this.grainBP.Q.value = 1.1;
    this.grainGain = ctx.createGain(); this.grainGain.gain.value = 0;
    this.grainSrc.connect(this.grainBP).connect(this.grainGain).connect(this.rideBus);

    this.rideSend = ctx.createGain(); this.rideSend.gain.value = 0.16;
    this.rideBus.connect(this.rideSend).connect(this.reverbSend);
  }

  // -------------------------------------------------------------------------
  // 2. WIND
  // -------------------------------------------------------------------------
  _buildWind() {
    const ctx = this.ctx;

    this.windSrc = ctx.createBufferSource();
    this.windSrc.buffer = this.buf.pink; this.windSrc.loop = true;
    this.windLP = ctx.createBiquadFilter(); this.windLP.type = 'lowpass';
    this.windLP.frequency.value = 400; this.windLP.Q.value = 0.7;
    this.windHP = ctx.createBiquadFilter(); this.windHP.type = 'highpass';
    this.windHP.frequency.value = 160;
    this.windGain = ctx.createGain(); this.windGain.gain.value = 0;

    // Gusting: a slow LFO on a series gain, kept as (1 + depth*lfo) so the
    // level can never cross zero and invert phase.
    this.gust = ctx.createGain(); this.gust.gain.value = 1;
    this.gustLfo = ctx.createOscillator(); this.gustLfo.type = 'sine'; this.gustLfo.frequency.value = 0.19;
    this.gustDepth = ctx.createGain(); this.gustDepth.gain.value = 0.28;
    this.gustLfo.connect(this.gustDepth).connect(this.gust.gain);

    this.windSrc.connect(this.windLP).connect(this.windHP).connect(this.windGain)
      .connect(this.gust).connect(this.windBus);

    // Resonant whistle — the edge-of-helmet tone that only appears fast.
    this.whistleSrc = ctx.createBufferSource();
    this.whistleSrc.buffer = this.buf.white; this.whistleSrc.loop = true;
    this.whBP1 = ctx.createBiquadFilter(); this.whBP1.type = 'bandpass';
    this.whBP1.frequency.value = 900; this.whBP1.Q.value = 16;
    this.whBP2 = ctx.createBiquadFilter(); this.whBP2.type = 'bandpass';
    this.whBP2.frequency.value = 1450; this.whBP2.Q.value = 24;
    this.whGain = ctx.createGain(); this.whGain.gain.value = 0;

    this.whLfo = ctx.createOscillator(); this.whLfo.type = 'sine'; this.whLfo.frequency.value = 0.13;
    this.whLfoAmt = ctx.createGain(); this.whLfoAmt.gain.value = 90;
    this.whLfo.connect(this.whLfoAmt);
    this.whLfoAmt.connect(this.whBP1.frequency);
    this.whLfoAmt.connect(this.whBP2.frequency);

    const split = ctx.createGain();
    this.whistleSrc.connect(split);
    split.connect(this.whBP1).connect(this.whGain);
    split.connect(this.whBP2).connect(this.whGain);
    this.whGain.connect(this.windBus);

    this.windSend = ctx.createGain(); this.windSend.gain.value = 0.10;
    this.windBus.connect(this.windSend).connect(this.reverbSend);
  }

  // -------------------------------------------------------------------------
  // 3. AIR
  // -------------------------------------------------------------------------
  _buildAir() {
    const ctx = this.ctx;
    // Airborne swell: near-silence right after the pop, then a rising filtered
    // pad as hang time builds. Paired with airDuck this gives the classic
    // "everything drops out" moment before the landing hits.
    this.airSrc = ctx.createBufferSource();
    this.airSrc.buffer = this.buf.pink; this.airSrc.loop = true;
    this.airSrc.playbackRate.value = 0.8;
    this.airLP = ctx.createBiquadFilter(); this.airLP.type = 'lowpass';
    this.airLP.frequency.value = 300; this.airLP.Q.value = 1.4;
    this.airGain = ctx.createGain(); this.airGain.gain.value = 0;
    this.airSrc.connect(this.airLP).connect(this.airGain).connect(this.windBus);

    this.sfxSend = ctx.createGain(); this.sfxSend.gain.value = 0.30;
    this.sfxBus.connect(this.sfxSend).connect(this.reverbSend);
    this.sfxDly = ctx.createGain(); this.sfxDly.gain.value = 0.16;
    this.sfxBus.connect(this.sfxDly).connect(this.delaySend);
  }

  _buildMusic() {
    this.music = new MusicEngine(this.ctx, this.musicBus,
      { reverb: this.reverbSend, delay: this.delaySend },
      { rnd: this.rnd });
    this.music.noise = this.buf.white;
  }

  _startSources(t) {
    const at = Math.max(0, t);
    for (const s of [this.hissSrc, this.carveSrc, this.rumbleSrc, this.grainSrc,
      this.windSrc, this.whistleSrc, this.airSrc]) {
      s.start(at, this.rnd() * 1.5);
    }
    this.gustLfo.start(at);
    this.whLfo.start(at);
    this.music.start(at);
  }

  // =========================================================================
  // per-frame
  // =========================================================================

  /**
   * @param dt     frame delta, seconds
   * @param body   BoardPhysics (or anything exposing the same scalars)
   * @param tricks TrickSystem
   */
  update(dt, body, tricks) {
    // 9. Called before init() (or after a failed init) — do nothing, never
    // throw. main.js calls update() from frame 1 but init() only on the first
    // user gesture, so this is the normal state for the first few seconds.
    if (!this.ready || !this.ctx) return;

    const b = body || IDLE_BODY;
    const tr = tricks || null;
    const step = clamp(dt || 0, 0, 0.1);
    if (this.offline) this._t += step;
    const t = this.now;

    // ---- smoothed control signals ---------------------------------------
    const speed = Number.isFinite(b.speed) ? b.speed : 0;
    const edge = Number.isFinite(b.edge) ? b.edge : 0;
    const grounded = b.grounded !== false;
    this.sSpeed += (speed - this.sSpeed) * (1 - Math.exp(-8 * step));
    this.sEdge += (Math.abs(edge) - this.sEdge) * (1 - Math.exp(-12 * step));
    this.sAir += ((grounded ? 0 : 1) - this.sAir) * (1 - Math.exp(-9 * step));

    // ---- discrete events -------------------------------------------------
    this._events(t, b, tr);

    // ---- continuous synthesis -------------------------------------------
    // Throttled to ~40 Hz: setTargetAtTime interpolates between updates anyway,
    // so re-targeting every frame only grows the automation timeline.
    this._paramClock += step;
    if (this._paramClock >= 0.024) {
      this._paramClock = 0;
      this._ride(t, grounded);
      this._wind(t, grounded);
      this._airTone(t, b, grounded);
    }

    // ---- music -----------------------------------------------------------
    const combo = tr && Number.isFinite(tr.combo) ? tr.combo : 0;
    const boost = tr && Number.isFinite(tr.boost) ? tr.boost : 0;
    const target = clamp(
      0.18
      + 0.52 * smoothstep(4, 42, this.sSpeed)
      + 0.34 * smoothstep(0, 6, combo)
      + 0.12 * clamp(boost, 0, 1),
      0, 1);
    this.sIntensity += (target - this.sIntensity) * (1 - Math.exp(-1.6 * step));
    this.music.schedule(t, this.sIntensity);
  }

  _ride(t, grounded) {
    const sp = clamp(this.sSpeed / 42, 0, 1.35);       // normalised speed
    const e = clamp(this.sEdge, 0, 1);
    // Contact fade: 60 ms out on takeoff, 30 ms in on touchdown. Fast enough to
    // read as instant, slow enough that nothing clicks.
    const contact = grounded ? 1 : 0;
    const tcG = grounded ? 0.03 : 0.06;

    // hiss — broadband bed, opens up with speed and brightens on edge
    glide(this.hissBP.frequency, 520 + 2900 * sp + 2100 * e * (0.3 + 0.7 * sp), t, 0.07, 4);
    glide(this.hissBP.Q, 0.55 + 1.5 * e, t, 0.08, 0.01);
    glide(this.hissShelf.gain, -4 + 12 * e * sp, t, 0.08, 0.05);
    glide(this.hissGain.gain, contact * (0.012 + 0.30 * Math.pow(sp, 0.85)) * (1 - 0.25 * e), t, tcG, 3e-4);
    glide(this.hissSrc.playbackRate, 0.82 + 0.45 * sp, t, 0.12, 0.005);

    // carve — the "shhhk". Exists only on edge, focuses as the edge bites.
    glide(this.carveBP.frequency, 1900 + 3600 * e + 1500 * sp, t, 0.06, 5);
    glide(this.carveBP.Q, 0.9 + 4.5 * e, t, 0.07, 0.01);
    glide(this.carvePk.frequency, 3000 + 3200 * e, t, 0.08, 5);
    glide(this.carvePk.gain, 2 + 9 * e, t, 0.08, 0.05);
    glide(this.carveGain.gain, contact * 0.42 * Math.pow(e, 1.35) * smoothstep(2, 16, this.sSpeed), t, tcG, 3e-4);
    glide(this.carveSrc.playbackRate, 0.9 + 0.6 * sp + 0.3 * e, t, 0.1, 0.005);

    // powder rumble — the body of soft snow, ducked when carving hard
    glide(this.rumbleLP.frequency, 110 + 280 * sp, t, 0.1, 2);
    glide(this.rumbleGain.gain, contact * (0.05 + 0.34 * sp) * (1 - 0.45 * e), t, tcG, 3e-4);

    // ice grain — density (playbackRate) and level both track speed & edge
    glide(this.grainSrc.playbackRate, 0.55 + 1.25 * sp + 0.35 * e, t, 0.1, 0.005);
    glide(this.grainBP.frequency, 1800 + 3000 * e + 900 * sp, t, 0.08, 5);
    glide(this.grainGain.gain, contact * 0.26 * e * smoothstep(3, 20, this.sSpeed), t, tcG, 3e-4);
  }

  _wind(t, grounded) {
    const sp = clamp(this.sSpeed / 48, 0, 1.3);
    // Airborne, the board noise vanishes and wind is all that's left — so it
    // gets both louder and wider open.
    const airBoost = lerp(1, 1.85, this.sAir);

    glide(this.windLP.frequency, 320 + 4600 * Math.pow(sp, 1.1) * lerp(1, 1.35, this.sAir), t, 0.12, 4);
    glide(this.windGain.gain, (0.014 + 0.26 * Math.pow(sp, 1.45)) * airBoost, t, 0.10, 3e-4);

    const wf = 780 + 1500 * sp;
    glide(this.whBP1.frequency, wf, t, 0.14, 4);
    glide(this.whBP2.frequency, wf * 1.62, t, 0.14, 4);
    glide(this.whBP1.Q, 12 + 14 * sp, t, 0.15, 0.05);
    glide(this.whBP2.Q, 18 + 18 * sp, t, 0.15, 0.05);
    const whistle = 0.115 * Math.pow(smoothstep(0.42, 1.0, sp), 1.4) * lerp(1, 1.5, this.sAir);
    glide(this.whGain.gain, whistle, t, 0.16, 2e-4);
  }

  _airTone(t, b, grounded) {
    const air = Number.isFinite(b.airTime) ? b.airTime : 0;
    if (grounded) {
      glide(this.airGain.gain, 0, t, 0.05, 2e-4);
      glide(this.airLP.frequency, 300, t, 0.2, 4);
      glide(this.airDuck.gain, 1.0, t, 0.14, 1e-3);
    } else {
      // Swell: cutoff and level rise with hang time.
      const s = smoothstep(0.05, 1.4, air);
      glide(this.airGain.gain, 0.05 + 0.24 * s, t, 0.16, 2e-4);
      glide(this.airLP.frequency, 260 + 2400 * s, t, 0.22, 4);
      // The duck recovers over the flight — quiet at the pop, full at apex.
      glide(this.airDuck.gain, lerp(0.42, 1.0, s), t, 0.2, 1e-3);
    }
  }

  // -------------------------------------------------------------------------
  // event detection
  // -------------------------------------------------------------------------
  _events(t, b, tr) {
    const p = this._prev;
    const grounded = b.grounded !== false;

    if (p.grounded && !grounded) this.playTakeoff(t, this.sSpeed);
    if (!p.grounded && grounded && p.airTime > 0.12) {
      this.playLanding(t, Number.isFinite(b.lastLandImpact) ? b.lastLandImpact : 8);
    }
    if (!p.crashed && b.crashed === true) this.playCrash(t, this.sSpeed);

    if (tr) {
      const score = Number.isFinite(tr.score) ? tr.score : 0;
      const combo = Number.isFinite(tr.combo) ? tr.combo : 0;
      const nTricks = Array.isArray(tr.tricks) ? tr.tricks.length : 0;
      if (score > p.score + 1e-6 || nTricks > p.tricks) this.playTrickStinger(t, combo);
      if (combo > p.combo) this.playComboUp(t, combo);
      p.score = score; p.combo = combo; p.tricks = nTricks;
    }

    p.grounded = grounded;
    p.crashed = b.crashed === true;
    p.airTime = Number.isFinite(b.airTime) ? b.airTime : 0;
  }

  // =========================================================================
  // one-shots — public so the offline test can fire them deterministically
  // =========================================================================

  /** 3. Takeoff whoosh: a noise band swept up then back down off the lip. */
  playTakeoff(t = this.now, speed = 20) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const v = clamp(0.25 + speed / 45, 0.25, 1);
    this.stats.takeoffs++;

    const src = ctx.createBufferSource();
    src.buffer = this.buf.white; src.loop = true;

    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.6;
    bp.frequency.setValueAtTime(320, t);
    bp.frequency.exponentialRampToValueAtTime(2600 + 900 * v, t + 0.16);
    bp.frequency.exponentialRampToValueAtTime(420, t + 0.52);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.34 * v, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0004, t + 0.55);

    src.connect(bp).connect(g).connect(this.sfxBus);
    src.start(t, this.rnd() * 2); src.stop(t + 0.6);

    // the pop itself — board leaving the snow
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(260, t);
    o.frequency.exponentialRampToValueAtTime(90, t + 0.09);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.16 * v, t);
    og.gain.exponentialRampToValueAtTime(0.0004, t + 0.12);
    o.connect(og).connect(this.sfxBus);
    o.start(t); o.stop(t + 0.14);
  }

  /**
   * 3. Landing: four stacked layers scaled by impact — a low thump (the board
   *    loading), a mid knock (flex), a broadband snow-compression burst, and
   *    the crackle of settling powder.
   */
  playLanding(t = this.now, impact = 8) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const v = clamp(impact / 22, 0.12, 1.25);
    this.stats.landings++;

    // low thump
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(105 + 40 * v, t);
    o.frequency.exponentialRampToValueAtTime(36, t + 0.16);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0, t);
    og.gain.linearRampToValueAtTime(0.62 * v, t + 0.005);
    og.gain.exponentialRampToValueAtTime(0.0005, t + 0.30 + 0.2 * v);
    o.connect(og).connect(this.sfxBus);
    o.start(t); o.stop(t + 0.55);

    // mid knock — board flex
    const k = ctx.createOscillator(); k.type = 'triangle';
    k.frequency.setValueAtTime(240 + 120 * v, t);
    k.frequency.exponentialRampToValueAtTime(110, t + 0.07);
    const kg = ctx.createGain();
    kg.gain.setValueAtTime(0.24 * v, t);
    kg.gain.exponentialRampToValueAtTime(0.0004, t + 0.10);
    k.connect(kg).connect(this.sfxBus);
    k.start(t); k.stop(t + 0.12);

    // snow compression burst
    const src = ctx.createBufferSource();
    src.buffer = this.buf.white; src.loop = true;
    src.playbackRate.value = 0.8 + 0.5 * v;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 1.1;
    lp.frequency.setValueAtTime(1400 + 1800 * v, t);
    lp.frequency.exponentialRampToValueAtTime(260, t + 0.26);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.46 * v, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 0.30);
    src.connect(lp).connect(g).connect(this.sfxBus);
    src.start(t, this.rnd() * 2); src.stop(t + 0.34);

    // settling crunch
    const cs = ctx.createBufferSource();
    cs.buffer = this.buf.crackle; cs.loop = true;
    cs.playbackRate.value = 0.9 + 0.6 * v;
    const cb = ctx.createBiquadFilter(); cb.type = 'bandpass';
    cb.frequency.value = 2200 + 900 * v; cb.Q.value = 1.0;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.30 * v, t + 0.01);
    cg.gain.exponentialRampToValueAtTime(0.0004, t + 0.22);
    cs.connect(cb).connect(cg).connect(this.sfxBus);
    cs.start(t + 0.01, this.rnd() * 1.5); cs.stop(t + 0.26);
  }

  /**
   * 4. Crash: a tumbling sequence, not one hit. 5-8 irregular impacts with
   *    falling energy and scattered pitch, plus a long scraping slide that
   *    filters down as the rider comes to rest.
   */
  playCrash(t = this.now, speed = 20) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const v = clamp(0.4 + speed / 40, 0.4, 1.2);
    this.stats.crashes++;

    const hits = 5 + Math.floor(this.rnd() * 4);
    let at = t;
    for (let i = 0; i < hits; i++) {
      const decay = Math.pow(0.74, i);
      const amp = v * decay * (0.6 + this.rnd() * 0.5);

      // impact body
      const o = ctx.createOscillator(); o.type = 'sine';
      const f0 = 90 + this.rnd() * 130;
      o.frequency.setValueAtTime(f0, at);
      o.frequency.exponentialRampToValueAtTime(f0 * 0.35, at + 0.12);
      const og = ctx.createGain();
      og.gain.setValueAtTime(0, at);
      og.gain.linearRampToValueAtTime(0.5 * amp, at + 0.004);
      og.gain.exponentialRampToValueAtTime(0.0004, at + 0.20);
      o.connect(og).connect(this.sfxBus);
      o.start(at); o.stop(at + 0.24);

      // snow / ice spray
      const s = ctx.createBufferSource();
      s.buffer = this.rnd() < 0.5 ? this.buf.white : this.buf.crackle;
      s.loop = true; s.playbackRate.value = 0.7 + this.rnd() * 1.1;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
      bp.frequency.setValueAtTime(900 + this.rnd() * 2600, at);
      bp.frequency.exponentialRampToValueAtTime(400, at + 0.18);
      bp.Q.value = 0.8 + this.rnd() * 1.6;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(0.40 * amp, at + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0004, at + 0.16 + this.rnd() * 0.1);
      s.connect(bp).connect(g).connect(this.sfxBus);
      s.start(at, this.rnd() * 1.5); s.stop(at + 0.30);

      at += 0.055 + this.rnd() * 0.19;
    }

    // the slide-out
    const sl = ctx.createBufferSource();
    sl.buffer = this.buf.white; sl.loop = true;
    const slf = ctx.createBiquadFilter(); slf.type = 'lowpass'; slf.Q.value = 1.4;
    slf.frequency.setValueAtTime(2600, t);
    slf.frequency.exponentialRampToValueAtTime(220, t + 1.3);
    const slg = ctx.createGain();
    slg.gain.setValueAtTime(0, t);
    slg.gain.linearRampToValueAtTime(0.26 * v, t + 0.06);
    slg.gain.setTargetAtTime(0.0001, t + 0.35, 0.36);
    sl.connect(slf).connect(slg).connect(this.sfxBus);
    sl.start(t, this.rnd() * 2); sl.stop(t + 1.7);

    this._duckMusic(t, 0.55, 0.9);
  }

  /**
   * 5. Trick stinger. Pitch walks up a pentatonic ladder with the combo count,
   *    so a chain is audibly a chain — each hit lands a step higher, and the
   *    voice gets brighter as you climb.
   */
  playTrickStinger(t = this.now, combo = 0) {
    if (!this.ready) return;
    if (t - this._lastStinger < 0.05) t = this._lastStinger + 0.05;
    this._lastStinger = t;
    this.stats.stingers++;

    const ctx = this.ctx;
    const LADDER = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24, 27, 29, 31];
    const idx = clamp(combo, 0, LADDER.length - 1) | 0;
    const f = 330 * Math.pow(2, LADDER[idx] / 12);
    const bright = idx / (LADDER.length - 1);

    // three-operator body: triangle fundamental, square a fifth up, octave sine
    for (const [type, mul, amp] of [['triangle', 1, 0.34], ['square', 1.5, 0.13], ['sine', 2, 0.10]]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(f * mul, t);
      o.frequency.exponentialRampToValueAtTime(f * mul * 1.02, t + 0.12);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(amp * (0.7 + 0.5 * bright), t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0004, t + 0.16 + 0.10 * bright);
      o.connect(g).connect(this.sfxBus);
      o.start(t); o.stop(t + 0.32);
    }

    // transient tick so it cuts through the ride noise
    const s = ctx.createBufferSource();
    s.buffer = this.buf.white; s.loop = true; s.playbackRate.value = 1.4;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass';
    hp.frequency.value = 3200 + 3000 * bright;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.20, t);
    g.gain.exponentialRampToValueAtTime(0.0004, t + 0.05);
    s.connect(hp).connect(g).connect(this.sfxBus);
    s.start(t, this.rnd() * 2); s.stop(t + 0.07);

    this._duckMusic(t, 0.72, 0.28);
  }

  /** 5. Combo multiplier up — a brighter two-note flourish above the stinger. */
  playComboUp(t = this.now, combo = 1) {
    if (!this.ready) return;
    const ctx = this.ctx;
    this.stats.comboUps++;
    const step = clamp(combo, 1, 12) | 0;
    const base = 440 * Math.pow(2, ((step * 2) % 12) / 12) * (1 + Math.floor(step / 6));

    for (let i = 0; i < 2; i++) {
      const at = t + i * 0.075;
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(base * (i ? 1.5 : 1), at);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(0.16, at + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0004, at + 0.42);
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
      bp.frequency.value = base * (i ? 1.5 : 1); bp.Q.value = 3;
      o.connect(bp).connect(g).connect(this.sfxBus);
      o.start(at); o.stop(at + 0.5);
    }
    this._duckMusic(t, 0.78, 0.3);
  }

  /** 8. Sidechain the music under a stinger so hits always read. */
  _duckMusic(t, amount, hold) {
    const p = this.musicDuck.gain;
    p.cancelScheduledValues(t);
    p.setTargetAtTime(amount, t, 0.012);
    p.setTargetAtTime(1.0, t + hold * 0.35, hold * 0.4);
    p.__tgt = 1.0;
  }

  // =========================================================================
  // mixer control
  // =========================================================================

  setMasterVolume(v) {
    this.volume = clamp(v, 0, 1.5);
    if (this.ready) glide(this.master.gain, this.muted ? 0 : this.volume, this.now, 0.05, 1e-4);
  }
  getMasterVolume() { return this.volume; }
  setMuted(m) {
    this.muted = !!m;
    if (this.ready) glide(this.master.gain, this.muted ? 0 : this.volume, this.now, 0.05, 1e-4);
  }
  toggleMute() { this.setMuted(!this.muted); return this.muted; }

  /** Bus trims — also how tools/audiotest.mjs solos a stem. */
  setBusGain(name, v) {
    if (!this.ready) return;
    const map = {
      ride: this.rideBus, wind: this.windBus, sfx: this.sfxBus,
      music: this.musicBus, reverb: this.revReturn, delay: this.dlyReturn,
    };
    const n = map[name];
    if (n) setNow(n.gain, v, this.now);
  }

  debugInfo() {
    if (!this.ready) return { ready: false };
    return {
      ready: true,
      offline: this.offline,
      time: this.now,
      sampleRate: this.ctx.sampleRate,
      speed: this.sSpeed, edge: this.sEdge, air: this.sAir,
      intensity: this.sIntensity,
      stats: { ...this.stats },
      music: this.music.debugInfo(),
    };
  }

  /** Not used by main.js, but keeps things tidy if a host ever tears down. */
  dispose() {
    if (!this.ready) return;
    try { this.master.disconnect(); this.ctx.close?.(); } catch { /* ignore */ }
    this.ready = false;
  }
}

export default GameAudio;
