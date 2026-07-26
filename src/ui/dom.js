// OWNER: agent "ui". Tiny DOM helpers — no framework, no allocation in hot paths.

/** Create an element, optionally classed, parented and filled. */
export function el(tag, cls, parent, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  if (parent) parent.appendChild(n);
  return n;
}

export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

/** 1234567 -> "1,234,567". Only called when a value actually changed. */
export function comma(n) {
  n = Math.round(n);
  if (!Number.isFinite(n)) n = 0;
  const neg = n < 0;
  let s = String(neg ? -n : n);
  if (s.length > 3) {
    let out = '';
    let c = 0;
    for (let i = s.length - 1; i >= 0; i--) {
      out = s[i] + out;
      if (++c % 3 === 0 && i > 0) out = ',' + out;
    }
    s = out;
  }
  return neg ? '-' + s : s;
}

/** 83.4 -> "1:23.40" */
export function clock(t) {
  if (!(t > 0)) t = 0;
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  const ss = s < 10 ? '0' + s.toFixed(2) : s.toFixed(2);
  return m + ':' + ss;
}

const NBSP = ' ';

function charSpan(host, ch, cls, delay) {
  const isSpace = ch === ' ';
  let c = cls;
  if (isSpace) c += ' kc--sp';
  else if (ch >= '0' && ch <= '9') c += ' kc--n';
  const s = el('span', c, host);
  s.textContent = isSpace ? NBSP : ch;
  s.style.animationDelay = delay.toFixed(3) + 's';
  return s;
}

/**
 * Explode `text` into per-character spans so type can animate with a stagger.
 * Built once per trick event, never per frame.
 */
export function kineticText(host, text, { stagger = 0.028, delay = 0, cls = 'kc' } = {}) {
  host.textContent = '';
  const str = String(text ?? '');
  const spans = [];
  for (let i = 0; i < str.length; i++) spans.push(charSpan(host, str[i], cls, delay + i * stagger));
  host.__spans = spans;
  host.__txt = str;
  return host;
}

/**
 * Incremental version of `kineticText`: keeps the characters that did not
 * change and only animates the tail in. That is what makes a live trick name
 * read as *streaming* — "Frontside 360" becoming "Frontside 540" re-animates
 * three characters, not the whole line.
 * Returns true if the DOM was touched.
 */
export function streamText(host, text, { stagger = 0.03, cls = 'kc' } = {}) {
  const str = String(text ?? '');
  const prev = host.__txt ?? '';
  if (prev === str) return false;
  const spans = host.__spans || (host.__spans = []);

  let common = 0;
  const n = Math.min(prev.length, str.length);
  while (common < n && prev[common] === str[common]) common++;

  while (spans.length > common) {
    const s = spans.pop();
    if (s.parentNode === host) host.removeChild(s);
  }
  for (let i = common; i < str.length; i++) {
    spans.push(charSpan(host, str[i], cls, (i - common) * stagger));
  }
  host.__txt = str;
  return true;
}

/** Force a restart of any CSS animations declared on `node`. */
export function replay(node) {
  node.style.animation = 'none';
  // Reading offsetWidth is the standard reflow-flush; only ever done on discrete
  // events (trick landed, combo bumped), never inside the per-frame update.
  void node.offsetWidth;
  node.style.animation = '';
}

/** Re-trigger a one-shot state class (removes, flushes, re-adds). */
export function pulse(node, cls) {
  node.classList.remove(cls);
  void node.offsetWidth;
  node.classList.add(cls);
}
