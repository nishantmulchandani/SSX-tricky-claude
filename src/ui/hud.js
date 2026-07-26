/**
 * OWNER: agent "ui".
 *
 * The heads-up display. DOM + CSS, deliberately: the centrepiece of this HUD is
 * *type*, and nothing rasterises type like the browser does.
 *
 * ── Performance contract ───────────────────────────────────────────────────
 * `update()` runs on every rendered frame. The rules it obeys:
 *   • never read layout (no offsetWidth / getBoundingClientRect) in update();
 *     the only reflow flushes are in dom.js `replay`/`pulse`, which are called
 *     from discrete trick events, never per frame.
 *   • never build DOM per frame. Character spans are built when a trick name
 *     actually changes, combo rows when a trick actually lands.
 *   • every write is diffed against a cached value first (`_c`), so a steady
 *     frame writes nothing at all.
 *   • animated properties are transform / opacity / colour only. Nothing in
 *     here animates width, height, top or left.
 *
 * ── State ──────────────────────────────────────────────────────────────────
 * Screens are driven by `run` (src/core/gameState.js, owner: integration):
 * title / countdown / riding / paused / finished. The HUD renders that state
 * and never mutates it. `run` may legitimately be missing in isolated tests,
 * in which case everything falls back to 'riding'.
 */

import { el, clamp, comma, clock, kineticText, streamText, replay, pulse } from './dom.js';
import { COURSE_LENGTH, progressAt } from '../world/terrain.js';

const MAX_KMH = 260;         // dial range; the physics soft cap is ~238 km/h
const SWEEP = 244;           // degrees of needle travel
const BLIPS = 34;            // arc segments around the dial
const COMBO_WINDOW = 3.6;    // must match comboScorer TUNING.COMBO_WINDOW
const MAX_ROWS = 6;

/** Keybindings mirrored from src/core/input.js KEYMAP. */
const CONTROLS = [
  ['W  /  ↑', 'Tuck — go faster'],
  ['S  /  ↓', 'Brake'],
  ['A D  /  ← →', 'Carve · air spin'],
  ['SPACE', 'Hold to charge, release to ollie'],
  ['SHIFT', 'Prewind on ground · tuck spin in air'],
  ['J  K  L  I', 'Grabs'],
  ['Q  /  E', 'Spin left / right'],
  ['U', 'UBER trick — needs a full meter'],
  ['R', 'Reset to the slope'],
  ['ESC', 'Pause'],
];

const GRADE_WORD = {
  perfect: 'PERFECT', clean: 'CLEAN', sloppy: 'SKETCHY', crash: 'BAIL', grind: 'GRIND',
};

export class HUD {
  constructor(root) {
    this.root = root || document.body;
    this.state = 'title';       // mirror of run.state
    this.time = 0;              // elapsed run time, seconds (mirrors run.time)
    this.w = (typeof innerWidth === 'number' ? innerWidth : 1280);
    this.h = (typeof innerHeight === 'number' ? innerHeight : 720);
    this.scale = 1;

    // Every value the per-frame update diffs against.
    this._c = {
      kmh: -1, needle: -999, lit: -1, danger: false,
      score: -1, pending: -1, mult: -1, multBucket: -1, chain: false, decay: -1,
      boost: -1, full: null, prog: -1, dist: -1, clockStr: '',
      air: null, airT: '', airDeg: '', crashed: false, grind: null, bal: -999,
      current: '', state: '', fit: -1, qtime: -1, count: -99,
    };
    this._evT = -1;
    this._lastTrick = null;
    this._banner = 0;
    this._ghost = 0;
    this._rows = 0;

    this._build();
    this.resize(this.w, this.h);
  }

  // ═══════════════════════════════════════════════════════════ construction
  _build() {
    this.root.textContent = '';
    const hud = this.hud = el('div', 'hud', this.root);
    hud.dataset.state = 'title';

    el('div', 'hud__scrim hud__scrim--top', hud);
    el('div', 'hud__scrim hud__scrim--bottom', hud);
    el('div', 'hud__scrim hud__scrim--left', hud);

    // ── score / time, top left ────────────────────────────────────────────
    const score = el('div', 'block score', hud);
    el('div', 'lbl', score, 'SCORE');
    this.elScore = el('div', 'score__val', score, '0');
    const tm = el('div', 'block clockblk', hud);
    el('div', 'lbl', tm, 'TIME');
    this.elClock = el('div', 'clockblk__val', tm, '0:00.00');

    // ── run progress, right edge ──────────────────────────────────────────
    const prog = el('div', 'prog', hud);
    el('div', 'lbl prog__cap prog__cap--top', prog, 'DROP');
    const track = el('div', 'prog__track', prog);
    this.elProgFill = el('div', 'prog__fill', track);
    for (let i = 1; i < 4; i++) el('div', 'prog__gate', track).style.top = (i * 25) + '%';
    this.elProgMark = el('div', 'prog__mark', track);
    el('div', 'prog__chev', this.elProgMark);
    this.elDist = el('div', 'prog__dist', this.elProgMark, '0 m');
    el('div', 'lbl prog__cap prog__cap--bot', prog, 'BASE');

    // ── speedometer, bottom left ──────────────────────────────────────────
    const sp = el('div', 'speedo', hud);
    this.elSpeedo = sp;
    this.canvas = el('canvas', 'speedo__dial', sp);
    const blips = el('div', 'speedo__blips', sp);
    this.blips = [];
    for (let i = 0; i < BLIPS; i++) {
      const b = el('i', 'speedo__blip', blips);
      b.style.setProperty('--a', (-SWEEP / 2 + SWEEP * (i / (BLIPS - 1))).toFixed(2) + 'deg');
      if (i / (BLIPS - 1) > 0.74) b.classList.add('is-hot');
      this.blips.push(b);
    }
    this.elNeedle = el('div', 'speedo__needle', sp);
    el('i', '', this.elNeedle);
    const read = el('div', 'speedo__read', sp);
    this.elKmh = el('div', 'speedo__num', read, '0');
    el('div', 'speedo__unit', read, 'KM / H');

    // ── boost / uber meter, bottom centre ─────────────────────────────────
    const boost = this.elBoost = el('div', 'boost', hud);
    const bhead = el('div', 'boost__head', boost);
    el('div', 'lbl', bhead, 'UBER METER');
    this.elBoostPct = el('div', 'boost__pct', bhead, '0%');
    const bar = el('div', 'boost__bar', boost);
    this.elBoostFill = el('div', 'boost__fill', bar);
    el('div', 'boost__segs', bar);
    el('div', 'boost__ready', boost, 'IT’S TRICKY  —  PRESS  U');

    // ── air / grind readout, top centre ───────────────────────────────────
    const air = this.elAir = el('div', 'air', hud);
    const at = el('div', 'air__cell', air);
    el('div', 'lbl', at, 'AIR');
    this.elAirTime = el('div', 'air__val', at, '0.00');
    const ar = el('div', 'air__cell air__cell--rot', air);
    el('div', 'lbl', ar, 'ROTATION');
    this.elAirDeg = el('div', 'air__val', ar, '0°');

    const gr = this.elGrind = el('div', 'grind', hud);
    this.elGrindName = el('div', 'grind__name', gr, 'GRIND');
    const gbar = el('div', 'grind__bar', gr);
    this.elGrindBal = el('div', 'grind__bal', gbar);

    // ── the trick column ──────────────────────────────────────────────────
    const trick = el('div', 'trick', hud);
    this.elBanner = el('div', 'trick__banner', trick);
    this.elList = el('div', 'combo', trick);
    this.elCurrent = el('div', 'trick__current', trick);
    const mrow = el('div', 'trick__multrow', trick);
    this.elMult = el('div', 'mult', mrow);
    this.elMultVal = el('div', 'mult__val', this.elMult, '×1');
    const decay = el('div', 'mult__decay', this.elMult);
    this.elDecay = el('div', 'mult__decaybar', decay);
    this.elPending = el('div', 'mult__pending', mrow, '');

    this.elGhost = el('div', 'ghost', hud);

    // ── crash ─────────────────────────────────────────────────────────────
    this.elCrash = el('div', 'crash', hud);
    el('div', 'crash__vig', this.elCrash);
    this.elCrashWord = el('div', 'crash__word', this.elCrash);

    // ── hint strip ────────────────────────────────────────────────────────
    const hint = el('div', 'hint', hud);
    el('span', 'key', hint, 'ESC');
    el('span', '', hint, 'pause');
    el('span', 'key', hint, 'R');
    el('span', '', hint, 'reset');

    this._buildOverlays(hud);
  }

  _buildOverlays(hud) {
    // Title -----------------------------------------------------------------
    const t = el('div', 'ov ov--title', hud);
    const ti = el('div', 'ov__inner', t);
    const logo = el('div', 'logo', ti);
    el('span', 'logo__a', logo, 'SNOW');
    el('span', 'logo__b', logo, 'BLITZ');
    el('div', 'logo__rule', ti);
    el('div', 'logo__sub', ti, 'ALPINE TRICK RUN  ·  6 400 M  ·  ONE DROP');
    this.elCta = el('div', 'ov__cta', ti, 'PRESS ANY KEY TO DROP IN');
    this._controlGrid(el('div', 'ov__cols', ti));

    // Pause -----------------------------------------------------------------
    const p = el('div', 'ov ov--pause', hud);
    const pi = el('div', 'ov__inner', p);
    el('div', 'ov__title', pi, 'PAUSED');
    el('div', 'logo__rule', pi);
    this._controlGrid(el('div', 'ov__cols', pi));
    el('div', 'ov__cta', pi, 'ESC TO RESUME  ·  R TO RESTART');

    // Results ---------------------------------------------------------------
    const r = el('div', 'ov ov--done', hud);
    const ri = el('div', 'ov__inner ov__inner--wide', r);
    el('div', 'ov__title', ri, 'RUN COMPLETE');
    el('div', 'logo__rule', ri);
    const cols = el('div', 'res', ri);
    this.elResStats = el('div', 'res__stats', cols);
    const best = el('div', 'res__best', cols);
    el('div', 'lbl', best, 'BEST TRICKS');
    this.elResList = el('div', 'res__list', best);
    el('div', 'ov__cta', ri, 'PRESS R TO RIDE IT AGAIN');
  }

  _controlGrid(host) {
    el('div', 'lbl lbl--wide', host, 'CONTROLS');
    const g = el('div', 'ctl', host);
    for (const [k, d] of CONTROLS) {
      const row = el('div', 'ctl__row', g);
      const keys = el('div', 'ctl__keys', row);
      for (const part of k.split('  ')) {
        if (part === '/' || part === '') el('span', 'ctl__sep', keys, '/');
        else el('span', 'key', keys, part);
      }
      el('div', 'ctl__desc', row, d);
    }
  }

  // ═══════════════════════════════════════════════════════════════ lifecycle
  /** Render a screen change. Called from update() when `run.state` moves. */
  _setScreen(s, tricks, run) {
    if (s === this.state) return;
    const from = this.state;
    this.state = s;
    this.hud.dataset.state = s;

    if (s === 'countdown' && from !== 'paused') this._clearRun();
    if (s === 'finished') this._results(tricks, run);
    if (s === 'countdown' || s === 'riding') this._c.count = -99;
  }

  /** Wipe the run-scoped visuals. main.js owns the body/tricks reset. */
  _clearRun() {
    this._evT = -1;
    this._lastTrick = null;
    this.elList.textContent = '';
    this._rows = 0;
    this._banner = 0; this._ghost = 0;
    this.elBanner.classList.remove('is-on');
    this.elGhost.classList.remove('is-on');
    this._c.current = '';
    this._c.crashed = false;
    this.elCrash.classList.remove('is-on');
    streamText(this.elCurrent, '');
    this.elCurrent.classList.remove('is-on');
  }

  // ═══════════════════════════════════════════════════════════════════ resize
  resize(w, h) {
    this.w = w || this.w; this.h = h || this.h;
    // Damped scale: readable at 720p, not comically large at 4K.
    const base = Math.min(this.w / 1280, this.h / 720);
    this.scale = clamp(Math.pow(base, 0.6), 0.62, 2.2);
    this.hud.style.setProperty('--s', this.scale.toFixed(4));
    this._drawDial();
  }

  /** Static dial art — ticks, numerals, danger arc. Drawn on resize only. */
  _drawDial() {
    const cv = this.canvas;
    if (!cv) return;
    const s = this.scale;
    const css = Math.round(220 * s);
    const dpr = clamp(typeof devicePixelRatio === 'number' ? devicePixelRatio : 1, 1, 2);
    cv.width = Math.round(css * dpr);
    cv.height = Math.round(css * dpr);
    cv.style.width = css + 'px';
    cv.style.height = css + 'px';
    const g = cv.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, css, css);

    const cx = css / 2, cy = css / 2;
    const R = css * 0.455;
    const a0 = (-90 - SWEEP / 2) * Math.PI / 180;
    const a1 = (-90 + SWEEP / 2) * Math.PI / 180;

    // dark backing plate so the dial survives white snow
    g.beginPath();
    g.arc(cx, cy, R + 6 * s, a0 - 0.08, a1 + 0.08);
    g.arc(cx, cy, R * 0.60, a1 + 0.08, a0 - 0.08, true);
    g.closePath();
    g.fillStyle = 'rgba(6,8,14,0.62)';
    g.fill();

    // outer rail
    g.lineWidth = 2 * s;
    g.strokeStyle = 'rgba(255,255,255,0.34)';
    g.beginPath(); g.arc(cx, cy, R + 6 * s, a0 - 0.08, a1 + 0.08); g.stroke();

    // danger arc
    const dz = 0.74;
    g.lineWidth = 3 * s;
    g.strokeStyle = '#ff2d6f';
    g.beginPath();
    g.arc(cx, cy, R + 6 * s, a0 + (a1 - a0) * dz, a1 + 0.08);
    g.stroke();

    // ticks + numerals
    const majors = 6;
    g.font = `700 ${Math.round(11 * s)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let i = 0; i <= majors * 2; i++) {
      const u = i / (majors * 2);
      const a = a0 + (a1 - a0) * u;
      const major = i % 2 === 0;
      const r0 = R * (major ? 0.68 : 0.74);
      const r1 = R * 0.80;
      g.lineWidth = (major ? 2.4 : 1.2) * s;
      g.strokeStyle = u > dz ? 'rgba(255,60,110,0.95)' : 'rgba(255,255,255,0.68)';
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      g.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      g.stroke();
      if (major) {
        const v = Math.round(MAX_KMH * u);
        const rr = R * 0.545;
        g.fillStyle = u > dz ? 'rgba(255,120,160,0.95)' : 'rgba(255,255,255,0.62)';
        g.fillText(String(v), cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════ update
  update(dt, body, tricks, run) {
    dt = Number.isFinite(dt) ? Math.min(dt, 0.1) : 0;
    const state = run?.state ?? 'riding';
    this._setScreen(state, tricks, run);

    if (run) this.time = state === 'finished' ? (run.finalTime || run.time || 0) : (run.time || 0);
    else if (state === 'riding') this.time += dt;

    if (state === 'countdown') this._countdown(run);
    if (state === 'paused' || state === 'title') { this._clock(); return; }

    this._events(tricks);
    this._speed(body);
    this._scoreboard(tricks);
    this._boost(tricks);
    this._progress(body);
    this._airline(body, tricks);
    this._crash(body);
    this._clock();
    this._live(tricks);

    if (this._banner > 0 && (this._banner -= dt) <= 0) this.elBanner.classList.remove('is-on');
    if (this._ghost > 0 && (this._ghost -= dt) <= 0) this.elGhost.classList.remove('is-on');
  }

  // ── 3 · 2 · 1 · DROP ─────────────────────────────────────────────────────
  _countdown(run) {
    const c = this._c;
    const left = Number.isFinite(run?.countdown) ? run.countdown : 0;
    const n = Math.max(0, Math.ceil(left - 0.2));
    if (n === c.count) return;
    c.count = n;
    const word = n > 0 ? String(n) : 'DROP!';
    this.elCount.dataset.go = n > 0 ? '0' : '1';
    kineticText(this.elCount, word, { stagger: 0.04 });
    replay(this.elCount);
  }

  // ── discrete trick events ────────────────────────────────────────────────
  _events(tricks) {
    const evs = tricks?.events;
    if (!Array.isArray(evs) || evs.length === 0) return;
    const last = evs[evs.length - 1];
    if (Number.isFinite(last?.t) && last.t < this._evT) this._evT = -1;   // tricks.reset()
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      if (!e || !(e.t > this._evT)) continue;
      this._onEvent(e);
    }
    if (Number.isFinite(last?.t)) this._evT = Math.max(this._evT, last.t);
  }

  _onEvent(e) {
    switch (e.type) {
      case 'trick':
        if (e.points > 0) this._addRow(e.name, e.points, e.landing, e.repeats);
        break;
      case 'combo':
        if (e.points > 0) this._flash('COMBO BANKED', '+' + comma(e.points), 'is-bank');
        this._clearRowsSoon();
        break;
      case 'crash':
        this._flash('WIPEOUT', e.lost > 0 ? '−' + comma(e.lost) : 'CHAIN LOST', 'is-bad');
        this._clearRowsSoon(0);
        break;
      case 'uber':
        this._flash('UBER', e.name || '', 'is-uber');
        break;
      case 'uberDenied':
        this._say('NOT ENOUGH AIR');
        break;
      case 'grindStart':
        this._say(e.name || 'GRIND');
        break;
      default: break;
    }
  }

  _addRow(name, points, landing, repeats) {
    const row = el('div', 'combo__row', this.elList);
    if (landing === 'perfect') row.classList.add('is-perfect');
    if (repeats > 0) row.classList.add('is-repeat');
    const n = el('span', 'combo__name', row);
    kineticText(n, String(name || 'TRICK').toUpperCase(), { stagger: 0.014 });
    el('span', 'combo__grade', row, GRADE_WORD[landing] || '');
    el('span', 'combo__pts', row, '+' + comma(points));
    this._rows++;
    while (this.elList.children.length > MAX_ROWS) {
      this.elList.removeChild(this.elList.firstChild);
    }
    pulse(this.elMult, 'is-bump');
  }

  _clearRowsSoon(delay = 900) {
    const list = this.elList;
    const gen = ++this._clearGen;
    for (const ch of list.children) ch.classList.add('is-out');
    setTimeout(() => {
      if (gen !== this._clearGen) return;
      list.textContent = '';
      this._rows = 0;
    }, delay + 420);
  }

  _flash(word, sub, cls) {
    const b = this.elBanner;
    b.className = 'trick__banner ' + (cls || '');
    b.textContent = '';
    kineticText(el('span', 'trick__bannerword', b), word, { stagger: 0.02 });
    if (sub) el('span', 'trick__bannersub', b, sub);
    b.classList.add('is-on');
    replay(b);
    this._banner = 2.2;
  }

  _say(text) {
    this.elGhost.textContent = text;
    this.elGhost.classList.add('is-on');
    replay(this.elGhost);
    this._ghost = 1.1;
  }

  // ── speedometer ──────────────────────────────────────────────────────────
  _speed(body) {
    const c = this._c;
    const ms = Number.isFinite(body?.speed) ? body.speed : 0;
    const kmh = Math.max(0, ms * 3.6);
    const u = clamp(kmh / MAX_KMH, 0, 1);

    const iv = Math.round(kmh);
    if (iv !== c.kmh) { c.kmh = iv; this.elKmh.textContent = String(iv); }

    const deg = -SWEEP / 2 + SWEEP * u;
    if (Math.abs(deg - c.needle) > 0.12) {
      c.needle = deg;
      this.elNeedle.style.transform = 'rotate(' + deg.toFixed(2) + 'deg)';
    }

    const lit = Math.round(u * BLIPS);
    if (lit !== c.lit) {
      const from = Math.min(lit, c.lit < 0 ? 0 : c.lit);
      const to = Math.max(lit, c.lit);
      for (let i = from; i < to; i++) this.blips[i]?.classList.toggle('is-on', i < lit);
      c.lit = lit;
    }

    const danger = u > 0.74;
    if (danger !== c.danger) { c.danger = danger; this.elSpeedo.classList.toggle('is-danger', danger); }
  }

  // ── score / combo ────────────────────────────────────────────────────────
  _scoreboard(tricks) {
    const c = this._c;
    const score = Math.round(tricks?.score ?? 0);
    if (score !== c.score) { c.score = score; this.elScore.textContent = comma(score); pulse(this.elScore, 'is-tick'); }

    const pending = Math.round(tricks?.pending ?? 0);
    const mult = Number.isFinite(tricks?.combo) ? tricks.combo : 1;
    const chain = pending > 0 && mult >= 1 && (tricks?.comboCount ?? 0) > 0;

    if (chain !== c.chain) { c.chain = chain; this.hud.classList.toggle('has-chain', chain); }
    if (pending !== c.pending) {
      c.pending = pending;
      this.elPending.textContent = pending > 0 ? '+' + comma(pending) : '';
    }
    const mb = Math.round(mult * 10);
    if (mb !== c.multBucket) {
      c.multBucket = mb;
      this.elMultVal.textContent = '×' + (mult % 1 ? mult.toFixed(1) : mult.toFixed(0));
      const tier = mult >= 5 ? 3 : mult >= 3 ? 2 : mult >= 2 ? 1 : 0;
      if (tier !== c.mult) { c.mult = tier; this.elMult.dataset.tier = String(tier); }
    }

    const timer = Number.isFinite(tricks?.comboTimer) ? tricks.comboTimer : 0;
    const d = clamp(timer / COMBO_WINDOW, 0, 1);
    if (Math.abs(d - c.decay) > 0.004) {
      c.decay = d;
      this.elDecay.style.transform = 'scaleX(' + d.toFixed(3) + ')';
    }
  }

  // ── boost / uber ─────────────────────────────────────────────────────────
  _boost(tricks) {
    const c = this._c;
    const b = clamp(Number.isFinite(tricks?.boost) ? tricks.boost : 0, 0, 1);
    if (Math.abs(b - c.boost) > 0.002) {
      c.boost = b;
      this.elBoostFill.style.transform = 'scaleX(' + b.toFixed(3) + ')';
      this.elBoostPct.textContent = Math.round(b * 100) + '%';
    }
    const full = !!tricks?.tricky || b >= 1;
    if (full !== c.full) {
      c.full = full;
      this.elBoost.classList.toggle('is-full', full);
      this.hud.classList.toggle('is-tricky', full);
      if (full) this._say('UBER READY');
    }
  }

  // ── run progress ─────────────────────────────────────────────────────────
  _progress(body) {
    const c = this._c;
    const z = Number.isFinite(body?.pos?.z) ? body.pos.z : 0;
    const p = clamp(progressAt(z), 0, 1);
    if (Math.abs(p - c.prog) > 0.0012) {
      c.prog = p;
      this.elProgMark.style.transform = 'translate3d(0,' + (p * 100).toFixed(2) + 'cqh,0)';
      this.elProgFill.style.transform = 'scaleY(' + p.toFixed(4) + ')';
    }
    const m = Math.round(p * COURSE_LENGTH / 10) * 10;
    if (m !== c.dist) { c.dist = m; this.elDist.textContent = comma(m) + ' m'; }
  }

  // ── air / grind ──────────────────────────────────────────────────────────
  _airline(body, tricks) {
    const c = this._c;
    const phase = tricks?.phase;
    const grinding = phase === 'grind' || !!tricks?.grindInfo?.active;
    const airborne = !grinding && (phase === 'air' || (body ? body.grounded === false : false)) && !body?.crashed;

    if (airborne !== c.air) { c.air = airborne; this.elAir.classList.toggle('is-on', airborne); }
    if (airborne) {
      const at = Number.isFinite(tricks?.airTime) ? tricks.airTime : (body?.airTime ?? 0);
      const s = at.toFixed(2);
      if (s !== c.airT) { c.airT = s; this.elAirTime.textContent = s; }
      const rev = tricks?.rev;
      const spin = Math.abs(rev?.yaw ?? 0) * 360;
      const flip = Math.abs(rev?.flip ?? 0) * 360;
      const total = Math.round(Math.max(spin, flip) / 5) * 5;
      const ds = total + '°';
      if (ds !== c.airDeg) { c.airDeg = ds; this.elAirDeg.textContent = ds; }
    }

    if (grinding !== c.grind) {
      c.grind = grinding;
      this.elGrind.classList.toggle('is-on', grinding);
      if (grinding) this.elGrindName.textContent = String(tricks?.grindInfo?.name || 'GRIND').toUpperCase();
    }
    if (grinding) {
      const bal = clamp(Number(tricks?.grindInfo?.balance) || 0, -1, 1);
      if (Math.abs(bal - c.bal) > 0.01) {
        c.bal = bal;
        this.elGrindBal.style.transform = 'translate3d(' + (bal * 46).toFixed(1) + 'cqw,0,0)';
      }
    }
  }

  // ── crash ────────────────────────────────────────────────────────────────
  _crash(body) {
    const c = this._c;
    const crashed = !!body?.crashed;
    if (crashed === c.crashed) return;
    c.crashed = crashed;
    this.elCrash.classList.toggle('is-on', crashed);
    if (crashed) {
      kineticText(this.elCrashWord, 'WIPEOUT', { stagger: 0.035 });
      replay(this.elCrash);
    }
  }

  // ── clock ────────────────────────────────────────────────────────────────
  _clock() {
    const c = this._c;
    // Quantised to 20 Hz: still reads as ticking hundredths, one write per 3 frames.
    const q = Math.round(this.time * 20) / 20;
    if (q === c.qtime) return;
    c.qtime = q;
    const s = clock(q);
    if (s !== c.clockStr) { c.clockStr = s; this.elClock.textContent = s; }
  }

  // ── live trick name ──────────────────────────────────────────────────────
  _live(tricks) {
    const c = this._c;
    const uber = tricks?.uber?.name;
    const raw = uber || tricks?.current || '';
    const text = String(raw).toUpperCase();
    if (text === c.current) return;
    c.current = text;

    if (streamText(this.elCurrent, text, { stagger: 0.024 })) {
      // Long names shrink instead of running off the screen. One write, on change.
      const fit = text.length > 20 ? clamp(20 / text.length, 0.42, 1) : 1;
      const q = Math.round(fit * 20);
      if (q !== c.fit) { c.fit = q; this.elCurrent.style.setProperty('--fit', (q / 20).toFixed(2)); }
    }
    this.elCurrent.classList.toggle('is-uber', !!uber);
    this.elCurrent.classList.toggle('is-on', !!text);
  }

  // ── results ──────────────────────────────────────────────────────────────
  _finish(tricks) {
    const list = Array.isArray(tricks?.tricks) ? tricks.tricks : [];
    const total = Math.round((tricks?.score ?? 0) + (tricks?.pending ?? 0) * (tricks?.combo ?? 1));
    const best = list.reduce((m, t) => Math.max(m, t?.points ?? 0), 0);
    const air = list.reduce((m, t) => m + (t?.airTime ?? 0), 0);

    const stats = [
      ['TIME', clock(this.time)],
      ['TRICKS LANDED', comma(list.length)],
      ['BEST SINGLE TRICK', comma(best)],
      ['AIR TIME', air.toFixed(1) + ' s'],
      ['BIGGEST CHAIN', comma(tricks?.scorer?.best ?? 0)],
      ['TOTAL', comma(total)],
    ];
    this.elResStats.textContent = '';
    for (const [k, v] of stats) {
      const row = el('div', 'res__row' + (k === 'TOTAL' ? ' res__row--total' : ''), this.elResStats);
      el('span', 'res__k', row, k);
      el('span', 'res__v', row, v);
    }

    const top = list.slice().sort((a, b) => (b?.points ?? 0) - (a?.points ?? 0)).slice(0, 5);
    this.elResList.textContent = '';
    if (!top.length) el('div', 'res__trick', this.elResList, 'No tricks landed — go bigger.');
    for (const t of top) {
      const row = el('div', 'res__trick', this.elResList);
      el('span', 'res__tn', row, String(t?.name || 'Trick').toUpperCase());
      el('span', 'res__tp', row, '+' + comma(t?.points ?? 0));
    }
    this.setState('done');
  }
}

export default HUD;
