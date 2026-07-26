/**
 * OWNER: agent "audio".
 *
 * Zero-asset DSP toolbox. Everything this game makes a sound with is generated
 * here from arithmetic: noise beds, granular crackle, and the convolution
 * impulse response for the alpine bowl. No files are ever fetched.
 *
 * All generators take a seed so an offline render (tools/audiotest.mjs) is
 * reproducible frame-for-frame against a live AudioContext.
 */

// ---------------------------------------------------------------------------
// scalar helpers
// ---------------------------------------------------------------------------

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0 || 1e-9), 0, 1);
  return t * t * (3 - 2 * t);
};
/** dB -> linear */
export const db = (x) => Math.pow(10, x / 20);
/** semitones -> ratio */
export const semi = (n) => Math.pow(2, n / 12);

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// parameter smoothing
// ---------------------------------------------------------------------------

/**
 * setTargetAtTime with change-detection. Calling setTargetAtTime 60x/second on
 * 25 params builds a huge automation timeline for no benefit, and stepping a
 * param directly is what produces zipper noise — so every continuous parameter
 * in this module goes through here.
 *
 * @param eps  don't re-target for changes smaller than this
 * @param tc   time constant (seconds) — the 63% settling time
 */
export function glide(param, value, time, tc = 0.06, eps = 1e-4) {
  const last = param.__tgt;
  if (last !== undefined && Math.abs(last - value) < eps) return;
  param.__tgt = value;
  param.setTargetAtTime(value, time, tc);
}

/** Immediate, un-smoothed set that still records the smoothing state. */
export function setNow(param, value, time) {
  param.__tgt = value;
  param.setValueAtTime(value, time);
}

// ---------------------------------------------------------------------------
// noise beds
// ---------------------------------------------------------------------------

/** Flat white noise, decorrelated per channel so the bed has real stereo width. */
export function makeWhiteNoise(ctx, seconds = 4, seed = 1337, channels = 2) {
  const n = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(channels, n, ctx.sampleRate);
  for (let c = 0; c < channels; c++) {
    const rnd = mulberry32(seed + c * 7919);
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) d[i] = rnd() * 2 - 1;
    crossfadeLoop(d, ctx.sampleRate * 0.02);
  }
  return buf;
}

/**
 * Pink (-3 dB/oct) noise via Paul Kellet's economy filter. Used for wind and
 * powder rumble — white noise sounds like a hissing tap, pink sounds like air.
 */
export function makePinkNoise(ctx, seconds = 4, seed = 4242, channels = 2) {
  const n = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(channels, n, ctx.sampleRate);
  for (let c = 0; c < channels; c++) {
    const rnd = mulberry32(seed + c * 104729);
    const d = buf.getChannelData(c);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = rnd() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
    normalise(d, 0.9);
    crossfadeLoop(d, ctx.sampleRate * 0.03);
  }
  return buf;
}

/**
 * Granular "crackle": sparse impulses each ringing at a random high frequency
 * with a very short exponential tail. Looped and pitch-shifted by playbackRate
 * this is the icy grain under a hard edge — the crunch that separates a carve
 * on boilerplate from a carve in powder.
 */
export function makeCrackle(ctx, seconds = 2, seed = 99, density = 900, channels = 2) {
  const sr = ctx.sampleRate;
  const n = Math.max(1, Math.floor(sr * seconds));
  const buf = ctx.createBuffer(channels, n, sr);
  for (let c = 0; c < channels; c++) {
    const rnd = mulberry32(seed + c * 31337);
    const d = buf.getChannelData(c);
    const grains = Math.floor(density * seconds);
    for (let g = 0; g < grains; g++) {
      const at = Math.floor(rnd() * n);
      const f = 700 + rnd() * 4200;            // ring frequency
      const decay = 260 + rnd() * 900;         // 1/e per second
      const amp = 0.25 + rnd() * 0.75;
      const len = Math.min(Math.floor(sr * 0.02), n - at);
      const w = 2 * Math.PI * f / sr;
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        d[at + i] += amp * Math.sin(w * i) * Math.exp(-decay * t);
      }
    }
    normalise(d, 0.85);
    crossfadeLoop(d, sr * 0.01);
  }
  return buf;
}

/** Short noise burst buffer with its own envelope — cheap one-shot texture. */
export function makeBurst(ctx, seconds, seed, shape = (t) => Math.exp(-6 * t)) {
  const sr = ctx.sampleRate;
  const n = Math.max(1, Math.floor(sr * seconds));
  const buf = ctx.createBuffer(2, n, sr);
  for (let c = 0; c < 2; c++) {
    const rnd = mulberry32(seed + c * 6151);
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) d[i] = (rnd() * 2 - 1) * shape(i / sr);
  }
  return buf;
}

// ---------------------------------------------------------------------------
// convolution reverb impulse response
// ---------------------------------------------------------------------------

/**
 * A large open alpine bowl, generated rather than sampled.
 *
 *  - a handful of discrete early reflections (the far valley walls),
 *  - an exponentially decaying noise tail for the diffuse field,
 *  - progressive high-frequency damping (a one-pole LP whose cutoff falls with
 *    time) because air and snow eat treble long before they eat bass,
 *  - a DC/rumble one-pole HP so the convolver never pumps the sub bus.
 *
 * The two channels use different seeds and slightly different decay constants,
 * which is what makes the tail feel wide instead of like a mono blob.
 */
export function makeImpulseResponse(ctx, opts = {}) {
  const {
    seconds = 3.4,
    decay = 2.1,        // higher = shorter tail
    preDelay = 0.018,
    damping = 0.55,     // 0..1, how fast the treble dies
    earlyGain = 0.5,
    seed = 20250726,
  } = opts;

  const sr = ctx.sampleRate;
  const n = Math.max(1, Math.floor(sr * seconds));
  const buf = ctx.createBuffer(2, n, sr);
  const pd = Math.floor(preDelay * sr);

  // Early-reflection taps, in seconds / relative gain. Irregular on purpose:
  // evenly spaced taps ring like a comb filter.
  const taps = [
    [0.011, 0.90], [0.019, -0.62], [0.031, 0.55], [0.043, -0.41],
    [0.058, 0.36], [0.079, -0.28], [0.104, 0.23], [0.137, -0.17],
    [0.181, 0.14], [0.233, -0.10],
  ];

  for (let c = 0; c < 2; c++) {
    const rnd = mulberry32(seed + c * 2654435761);
    const d = buf.getChannelData(c);
    const dk = decay * (c === 0 ? 1.0 : 0.94);

    // diffuse tail
    let lp = 0, hp = 0, prev = 0;
    for (let i = pd; i < n; i++) {
      const t = (i - pd) / sr;
      const env = Math.exp(-dk * t);
      // build-up over the first ~25 ms so the tail swells instead of clicking
      const build = 1 - Math.exp(-t * 90);
      let x = (rnd() * 2 - 1) * env * build;

      // progressive LP: coefficient shrinks as the tail ages
      const a = clamp(1 - damping * (0.15 + 0.85 * (1 - env)), 0.04, 1);
      lp += a * (x - lp);
      x = lp;

      // one-pole HP at ~45 Hz
      hp = 0.995 * (hp + x - prev);
      prev = x;
      d[i] = hp;
    }

    // early reflections, slightly offset per channel for width
    for (let k = 0; k < taps.length; k++) {
      const [tt, g] = taps[k];
      const jitter = (c === 0 ? 1 : 1.07 + rnd() * 0.05);
      const idx = pd + Math.floor(tt * jitter * sr);
      if (idx < n - 1) {
        d[idx] += g * earlyGain;
        d[idx + 1] += g * earlyGain * 0.5;   // tiny smear, avoids a naked click
      }
    }

    normalise(d, 1.0);
  }
  return buf;
}

// ---------------------------------------------------------------------------
// waveshaper curves
// ---------------------------------------------------------------------------

/**
 * Curve for a bounded soft-clip limiter.
 *
 * WaveShaperNode maps input [-1,1] across the curve. We want the *net*
 * transfer to be y = tanh(x) over a much wider input range, so the signal is
 * pre-scaled by `pre` and the curve stores tanh(u / pre):
 *
 *     out = tanh(pre * x / pre) = tanh(x)      for |x| <= 1/pre
 *
 * Unity slope at the origin (transparent at normal levels) and a hard
 * mathematical ceiling of tanh(1/pre) < 1.0, which is what makes the
 * "never clips" assertion in the test a guarantee rather than a hope.
 */
export function makeTanhCurve(n = 8192, pre = 0.25) {
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(u / pre);
  }
  return curve;
}

/** Gentle asymmetric drive for the bass — adds harmonics without fizz. */
export function makeDriveCurve(n = 4096, k = 2.2) {
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  return curve;
}

// ---------------------------------------------------------------------------
// internal
// ---------------------------------------------------------------------------

function normalise(d, target) {
  let peak = 0;
  for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
  if (peak > 1e-9) { const g = target / peak; for (let i = 0; i < d.length; i++) d[i] *= g; }
}

/**
 * Equal-power crossfade of the buffer tail into its head so a looping
 * BufferSource has no seam. A click every 4 seconds is very audible under an
 * otherwise steady hiss.
 */
function crossfadeLoop(d, fadeSamples) {
  const f = Math.min(Math.floor(fadeSamples), Math.floor(d.length / 4));
  if (f < 2) return;
  const n = d.length;
  for (let i = 0; i < f; i++) {
    const t = i / f;
    const a = Math.cos(t * Math.PI * 0.5);
    const b = Math.sin(t * Math.PI * 0.5);
    d[i] = d[i] * b + d[n - f + i] * a;
  }
}
