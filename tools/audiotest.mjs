#!/usr/bin/env node
/**
 * Renders the audio graph offline and checks it numerically.
 *
 * Audio is the one subsystem nobody can eyeball, and init() only runs on a real
 * user gesture — so without this the whole engine (synthesis, music, mix bus)
 * is never executed by any test. GameAudio.init(ctx) accepts an
 * OfflineAudioContext and switches to a simulated clock driven by update()'s
 * dt, which is exactly what this needs.
 *
 *   node tools/audiotest.mjs
 */
import { chromium } from 'playwright';

const SECONDS = 6;
const SR = 44100;

const failures = [];
function expect(name, cond, detail = '') {
  if (cond) console.log(` PASS  ${name}${detail ? '  — ' + detail : ''}`);
  else { console.log(` FAIL  ${name}${detail ? '  — ' + detail : ''}`); failures.push(name); }
}

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--no-sandbox', '--disable-dev-shm-usage', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.stack || String(e)));

console.log('=== AUDIO TEST ===\n');
await page.goto('http://localhost:5173/', { waitUntil: 'load' });
await page.waitForFunction(() => !!globalThis.__game, null, { timeout: 30000 });

const result = await page.evaluate(async ({ seconds, sr }) => {
  const GameAudio = globalThis.__game.audio.constructor;
  const ctx = new OfflineAudioContext(2, Math.floor(sr * seconds), sr);

  const audio = new GameAudio();
  let initError = null;
  try {
    audio.init(ctx);
  } catch (e) {
    initError = String(e && e.stack || e);
    return { initError };
  }
  if (audio.failed) return { initError: 'GameAudio reported failed=true after init' };

  // Drive a plausible run: accelerate, carve hard, take air, land, crash.
  const DT = 1 / 120;
  const steps = Math.floor(seconds / DT);
  const marks = [];
  let updateError = null;
  try {
    for (let i = 0; i < steps; i++) {
      const t = i * DT;
      const phase = t / seconds;
      const body = {
        speed: 6 + 46 * Math.min(1, phase * 2.2),
        edge: phase > 0.25 && phase < 0.5 ? 0.9 : 0.05,
        grounded: !(phase > 0.55 && phase < 0.72),
        airTime: phase > 0.55 && phase < 0.72 ? (t - seconds * 0.55) : 0,
        crouch: 0,
        lastLandImpact: 0,
        crashed: phase > 0.88,
      };
      // one landing impact right at touchdown
      if (Math.abs(phase - 0.72) < DT / seconds) body.lastLandImpact = 22;
      const tricks = { phase: body.grounded ? 'ground' : 'air', combo: 1 + Math.floor(phase * 4), boost: phase };
      audio.update(DT, body, tricks);
      if (i % Math.floor(steps / 6) === 0) marks.push(+t.toFixed(2));
    }
  } catch (e) {
    updateError = String(e && e.stack || e);
  }

  const buf = await ctx.startRendering();
  const L = buf.getChannelData(0);
  const R = buf.getChannelData(1);

  // Per-window stats, so we can see the mix actually respond over time.
  const win = Math.floor(buf.length / 12);
  const windows = [];
  for (let w = 0; w < 12; w++) {
    let peak = 0, sum = 0;
    const s = w * win, e = Math.min(buf.length, s + win);
    for (let i = s; i < e; i++) {
      const v = Math.abs(L[i]);
      if (v > peak) peak = v;
      sum += L[i] * L[i];
    }
    windows.push({ peak: +peak.toFixed(4), rms: +Math.sqrt(sum / (e - s)).toFixed(4) });
  }

  let peak = 0, sum = 0, nonFinite = 0, clipped = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = L[i];
    if (!Number.isFinite(v)) nonFinite++;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    if (a > 0.999) clipped++;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / buf.length);

  // Crude spectral split: energy above/below ~2kHz via a one-pole difference.
  let lowE = 0, highE = 0, prev = 0;
  for (let i = 0; i < buf.length; i++) {
    const hp = L[i] - prev; prev = L[i];
    highE += hp * hp; lowE += L[i] * L[i];
  }

  // Stereo width: are the channels actually different?
  let diff = 0;
  for (let i = 0; i < buf.length; i += 7) diff += Math.abs(L[i] - R[i]);
  diff /= (buf.length / 7);

  return {
    initError, updateError, marks,
    length: buf.length, duration: +buf.duration.toFixed(2),
    peak: +peak.toFixed(4), rms: +rms.toFixed(5),
    clipped, nonFinite,
    highRatio: +(highE / Math.max(lowE, 1e-9)).toFixed(4),
    stereoDiff: +diff.toFixed(5),
    windows,
  };
}, { seconds: SECONDS, sr: SR });

if (result.initError) {
  console.log(` FAIL  GameAudio.init() threw\n        ${result.initError.split('\n').slice(0, 4).join('\n        ')}`);
  failures.push('init');
} else {
  expect('GameAudio.init() completes on an OfflineAudioContext', true);
  expect('update() runs a full simulated ride without throwing', !result.updateError,
    result.updateError ? result.updateError.split('\n')[0] : `${SECONDS}s simulated`);
  expect('rendered the expected buffer length', result.duration >= SECONDS - 0.05,
    `${result.duration}s @ ${SR}Hz`);
  expect('output is not silent', result.rms > 0.0005, `rms=${result.rms}`);
  expect('output contains no NaN/Inf samples', result.nonFinite === 0, `${result.nonFinite} bad samples`);
  expect('output does not clip', result.peak <= 1.0 && result.clipped < result.length * 0.0005,
    `peak=${result.peak}, ${result.clipped} samples at full scale`);
  expect('output has headroom (not slammed into the limiter)', result.rms < 0.5, `rms=${result.rms}`);
  expect('signal has high-frequency content (not just rumble)', result.highRatio > 0.001,
    `hf/lf=${result.highRatio}`);
  expect('mix is stereo, not dual mono', result.stereoDiff > 1e-5, `mean |L-R|=${result.stereoDiff}`);

  const rmsVals = result.windows.map((w) => w.rms);
  const varied = Math.max(...rmsVals) > Math.min(...rmsVals) * 1.25;
  expect('mix responds to the ride (level varies over time)', varied,
    `rms ${Math.min(...rmsVals)} .. ${Math.max(...rmsVals)}`);

  console.log('\n--- level over the run (rms per 0.5s window) ---');
  console.log('  ' + result.windows.map((w) => w.rms.toFixed(3)).join('  '));
}

if (pageErrors.length) {
  console.log('\n--- page errors ---');
  for (const e of [...new Set(pageErrors)].slice(0, 3)) console.log('  ' + e.split('\n')[0]);
}

console.log(`\nRESULT: ${failures.length ? 'FAIL (' + failures.join(', ') + ')' : 'PASS'}`);
await browser.close();
process.exit(failures.length ? 1 : 0);
