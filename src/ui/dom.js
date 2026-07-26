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

/**
 * Explode `text` into per-character spans so type can animate with a stagger.
 * Built once per trick event, never per frame.
 */
export function kineticText(host, text, { stagger = 0.028, delay = 0, cls = 'kc' } = {}) {
  host.textContent = '';
  const chars = String(text).split('');
  let visible = 0;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === ' ') {
      const sp = el('span', cls + ' kc--sp', host);
      sp.textContent = ' ';
      continue;
    }
    const s = el('span', cls, host, ch);
    s.style.animationDelay = (delay + visible * stagger).toFixed(3) + 's';
    visible++;
  }
  return host;
}

/** Force a restart of any CSS animations declared on `node`. */
export function replay(node) {
  node.style.animation = 'none';
  // Reading offsetWidth is the standard reflow-flush; only ever done on discrete
  // events (trick landed, combo bumped), never inside the per-frame update.
  void node.offsetWidth;
  node.style.animation = '';
}
