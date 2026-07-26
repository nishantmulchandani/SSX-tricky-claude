/**
 * OWNER: agent "tricks".
 *
 * The trick *vocabulary*: grabs, rotation classification and name composition.
 * Pure data + pure functions — no THREE, no state, no side effects. Everything
 * here is unit-testable in isolation and is what makes a trick read as
 * "Backside 900 Melon" instead of "spin_2.5_grab_3".
 *
 * ── Naming grammar ────────────────────────────────────────────────────────
 *   [stance/side prefix] [axis word] [degrees] [grab(s)] [" to Switch"]
 *
 *   Frontside 540 Melon
 *   Cab 720 Stalefish to Switch
 *   Backside Rodeo 720 Mute
 *   Misty 900 Roast Beef
 *   Double Backflip Tailgrab
 *   Switch Corkscrew 1080 Crail
 *
 * ── Spin sign convention ──────────────────────────────────────────────────
 * board.js builds forward as (sin(yaw), 0, -cos(yaw)) and steers with
 * `yaw -= steer * rate`, so pushing the stick right *decreases* yaw. We keep
 * air spin consistent with that: stick right => yaw decreasing. A regular
 * footed rider spinning that way leads with the chest, so:
 *
 *      yaw DECREASING  ->  Frontside      (FRONTSIDE_SIGN = -1)
 *      yaw INCREASING  ->  Backside
 *
 * Flip sign: stick up / tuck (input.pitch < 0) pulls the nose down and rotates
 * the rider forwards => FRONT flip => rotation.pitch increases.
 */

export const FRONTSIDE_SIGN = -1;

// ── Grabs ──────────────────────────────────────────────────────────────────
// 4 buttons x 5 directions. The 10 classics live on grab1/grab2 (the two
// "hands"); grab3/grab4 are the technical and extreme families.
//
//   grab1 = rear hand      grab2 = front hand
//   grab3 = technical      grab4 = extreme / board-off
//
// `diff` is the score difficulty coefficient, `style` is a hint for the
// character rig (see docs/REQUESTS-tricks.md).

export const GRAB_TABLE = {
  grab1: {
    family: 'Rear hand',
    neutral: { name: 'Indy',          diff: 1.00, hand: 'rear',  edge: 'toe',  where: 'between' },
    up:      { name: 'Crail',         diff: 1.30, hand: 'rear',  edge: 'toe',  where: 'nose' },
    down:    { name: 'Tailgrab',      diff: 1.10, hand: 'rear',  edge: 'tail', where: 'tail' },
    left:    { name: 'Stalefish',     diff: 1.25, hand: 'rear',  edge: 'heel', where: 'behind' },
    right:   { name: 'Roast Beef',    diff: 1.35, hand: 'rear',  edge: 'heel', where: 'through' },
  },
  grab2: {
    family: 'Front hand',
    neutral: { name: 'Melon',         diff: 1.05, hand: 'front', edge: 'heel', where: 'between' },
    up:      { name: 'Nosegrab',      diff: 1.15, hand: 'front', edge: 'nose', where: 'nose' },
    down:    { name: 'Seatbelt',      diff: 1.40, hand: 'front', edge: 'toe',  where: 'tail' },
    left:    { name: 'Method',        diff: 1.30, hand: 'front', edge: 'heel', where: 'between', tweak: 'arch' },
    right:   { name: 'Mute',          diff: 1.10, hand: 'front', edge: 'toe',  where: 'between' },
  },
  grab3: {
    family: 'Technical',
    neutral: { name: 'Japan',         diff: 1.45, hand: 'front', edge: 'toe',  where: 'nose', tweak: 'boned' },
    up:      { name: 'Chicken Salad', diff: 1.50, hand: 'rear',  edge: 'heel', where: 'between', tweak: 'reach' },
    down:    { name: 'Canadian Bacon',diff: 1.55, hand: 'rear',  edge: 'heel', where: 'through' },
    left:    { name: 'Truck Driver',  diff: 1.60, hand: 'both',  edge: 'both', where: 'between' },
    right:   { name: 'Tindy',         diff: 1.20, hand: 'rear',  edge: 'toe',  where: 'tail' },
  },
  grab4: {
    family: 'Extreme',
    neutral: { name: 'Nuclear',       diff: 1.65, hand: 'front', edge: 'tail', where: 'tail',  tweak: 'reach' },
    up:      { name: 'Rocket Air',    diff: 1.55, hand: 'both',  edge: 'nose', where: 'nose',  tweak: 'vertical' },
    down:    { name: 'Suitcase',      diff: 1.50, hand: 'rear',  edge: 'toe',  where: 'through' },
    left:    { name: 'Bloody Dracula',diff: 1.75, hand: 'rear',  edge: 'nose', where: 'nose',  tweak: 'behindhead' },
    right:   { name: 'Tail Fish',     diff: 1.35, hand: 'rear',  edge: 'heel', where: 'tail' },
  },
};

/** Two grab buttons at once = a named double grab. Keys are sorted+joined. */
export const GRAB_PAIRS = {
  'grab1|grab2': { name: 'Twin Grab',      diff: 1.70, hand: 'both' },
  'grab1|grab3': { name: 'Beef Carpaccio', diff: 1.75, hand: 'both' },
  'grab1|grab4': { name: 'Board Off',      diff: 1.90, hand: 'both', tweak: 'boardoff' },
  'grab2|grab3': { name: 'Superman',       diff: 1.80, hand: 'both', tweak: 'superman' },
  'grab2|grab4': { name: 'Stiffy',         diff: 1.60, hand: 'both', tweak: 'stiff' },
  'grab3|grab4': { name: 'Christ Air',     diff: 2.00, hand: 'none', tweak: 'christ' },
};

export const GRAB_BUTTONS = ['grab1', 'grab2', 'grab3', 'grab4'];

/**
 * Direction modifier from the analog stick at the moment the grab is pressed.
 * Priority goes to the dominant axis so diagonals don't flicker.
 */
export function grabDirection(steer, pitch, dead = 0.42) {
  const as = Math.abs(steer), ap = Math.abs(pitch);
  if (as < dead && ap < dead) return 'neutral';
  if (as >= ap) return steer > 0 ? 'right' : 'left';
  return pitch < 0 ? 'up' : 'down'; // pitch < 0 == tuck == "up"
}

/**
 * Resolve held buttons + direction to a grab descriptor.
 * @param {string[]} buttons held grab buttons, e.g. ['grab1','grab3']
 */
export function resolveGrab(buttons, dir) {
  if (!buttons || buttons.length === 0) return null;
  if (buttons.length >= 2) {
    const key = [...buttons].sort().slice(0, 2).join('|');
    const pair = GRAB_PAIRS[key];
    if (pair) return { ...pair, dir, buttons: [...buttons] };
  }
  const g = GRAB_TABLE[buttons[0]]?.[dir] ?? GRAB_TABLE[buttons[0]]?.neutral;
  return g ? { ...g, dir, buttons: [...buttons] } : null;
}

// ── Rotation classification ────────────────────────────────────────────────

export const AXIS = {
  AIR: 'air',
  SPIN: 'spin',
  FLIP: 'flip',
  BARREL: 'barrel',
  CORK: 'cork',
  MISTY: 'misty',
  RODEO: 'rodeo',
  UNDERFLIP: 'underflip',
};

/** Off-axis families score more than a flat spin of the same magnitude. */
export const AXIS_DIFFICULTY = {
  [AXIS.AIR]: 1.0,
  [AXIS.SPIN]: 1.0,
  [AXIS.FLIP]: 1.15,
  [AXIS.BARREL]: 1.30,
  [AXIS.CORK]: 1.35,
  [AXIS.RODEO]: 1.40,
  [AXIS.MISTY]: 1.45,
  [AXIS.UNDERFLIP]: 1.60,
};

/**
 * @param rev { yaw, flip, roll } signed revolutions accumulated in the air.
 * @returns one of AXIS.*
 */
export function classifyAxis(rev) {
  const yr = Math.abs(rev.yaw), fr = Math.abs(rev.flip), rr = Math.abs(rev.roll);
  const off = Math.max(fr, rr);

  if (yr < 0.22 && off < 0.30) return AXIS.AIR;
  if (yr < 0.40) {
    if (rr >= 0.45 && rr > fr) return AXIS.BARREL;
    if (fr >= 0.55) return AXIS.FLIP;
    return yr >= 0.22 ? AXIS.SPIN : AXIS.AIR;
  }
  if (off < 0.18) return AXIS.SPIN;

  // Spin + off-axis: which off-axis family?
  if (rr > fr * 1.30) return AXIS.CORK;
  const frontFlip = rev.flip > 0;
  const backside = Math.sign(rev.yaw) !== FRONTSIDE_SIGN;
  if (frontFlip) return backside ? AXIS.MISTY : AXIS.UNDERFLIP;
  return AXIS.RODEO;
}

const MULT_WORD = ['', '', 'Double ', 'Triple ', 'Quad ', 'Quint '];

export function multiplierWord(n) {
  return MULT_WORD[Math.min(n, MULT_WORD.length - 1)] ?? `${n}x `;
}

/** Snap accumulated yaw to the nearest legal spin value (multiples of 180). */
export function spinDegrees(yawRev) {
  return Math.round(Math.abs(yawRev) * 2) * 180;
}

/**
 * Side prefix — "Frontside"/"Backside", or "Cab"/"Switch Backside" from switch.
 * @param stance 0 = regular, 1 = switch (riding tail-first)
 */
export function sidePrefix(yawRev, stance) {
  const frontside = Math.sign(yawRev || 1) === FRONTSIDE_SIGN;
  if (stance) return frontside ? 'Cab' : 'Switch Backside';
  return frontside ? 'Frontside' : 'Backside';
}

/**
 * Compose the rotation half of the trick name.
 * @param rev    { yaw, flip, roll } signed revolutions
 * @param stance 0 regular / 1 switch at TAKEOFF
 * @returns { name, axis, deg, flips, rolls }
 */
export function rotationName(rev, stance = 0) {
  const axis = classifyAxis(rev);
  const deg = spinDegrees(rev.yaw);
  const flips = Math.round(Math.abs(rev.flip));
  const rolls = Math.round(Math.abs(rev.roll));
  const sw = stance ? 'Switch ' : '';
  let name;

  switch (axis) {
    case AXIS.AIR:
      name = '';
      break;
    case AXIS.SPIN:
      name = `${sidePrefix(rev.yaw, stance)} ${deg}`;
      break;
    case AXIS.FLIP:
      name = `${sw}${multiplierWord(flips)}${rev.flip > 0 ? 'Frontflip' : 'Backflip'}`;
      break;
    case AXIS.BARREL:
      name = `${sw}${multiplierWord(rolls)}Barrel Roll`;
      break;
    case AXIS.CORK:
      name = `${sidePrefix(rev.yaw, stance)} ${rolls >= 2 ? multiplierWord(rolls) : ''}Corkscrew ${deg}`.replace('  ', ' ');
      break;
    case AXIS.MISTY:
      name = `${stance ? 'Cab ' : ''}Misty ${deg}`;
      break;
    case AXIS.UNDERFLIP:
      name = `${sw}Underflip ${deg}`;
      break;
    case AXIS.RODEO:
      name = `${sidePrefix(rev.yaw, stance)} Rodeo ${deg}`;
      break;
    default:
      name = '';
  }
  return { name: name.trim(), axis, deg, flips, rolls };
}

/**
 * Full trick name.
 * @param rev      signed revolutions { yaw, flip, roll }
 * @param grabs    ordered list of grab descriptors used during the air
 * @param stance   0/1 at takeoff
 * @param toSwitch true when the rider lands riding switch
 */
export function composeTrickName(rev, grabs, stance = 0, toSwitch = false) {
  const rot = rotationName(rev, stance);
  const grabNames = [];
  for (const g of grabs || []) {
    if (!g) continue;
    if (grabNames[grabNames.length - 1] !== g.name) grabNames.push(g.name);
  }
  const grabPart = grabNames.join(' to ');

  let name;
  if (rot.name && grabPart) name = `${rot.name} ${grabPart}`;
  else if (rot.name) name = rot.name;
  else if (grabPart) name = grabPart;
  else name = 'Straight Air';

  if (toSwitch) name += ' to Switch';
  return { name, ...rot, grabNames };
}

// ── Landing grades ─────────────────────────────────────────────────────────

export const LANDING = {
  PERFECT: { key: 'perfect', label: 'Perfect Landing', mult: 1.30, speed: 1.02, boost: 0.10 },
  CLEAN:   { key: 'clean',   label: 'Clean Landing',   mult: 1.00, speed: 1.00, boost: 0.05 },
  SLOPPY:  { key: 'sloppy',  label: 'Sketchy!',        mult: 0.45, speed: 0.74, boost: 0.00 },
  CRASH:   { key: 'crash',   label: 'Bail!',           mult: 0.00, speed: 0.00, boost: 0.00 },
};

// ── Grind vocabulary ───────────────────────────────────────────────────────

/**
 * Name a grind from the board's angle across the rail plus nose/tail press.
 * @param angleDeg signed angle between board heading and rail tangent (-180..180)
 * @param press    -1 nose, 0 flat, +1 tail
 * @param dark     board inverted on the rail
 * @param stance   0 regular / 1 switch
 */
export function grindName(angleDeg, press, dark, stance = 0) {
  let a = ((angleDeg % 360) + 540) % 360 - 180;   // -180..180
  const side = Math.sign(a) || 1;
  a = Math.abs(a);
  if (a > 90) a = 180 - a;                        // riding the rail backwards is the same shape

  const sw = stance ? 'Switch ' : '';
  if (dark) return `${sw}Darkslide`;

  let base;
  if (a < 18) base = press < 0 ? 'Nose Press' : press > 0 ? 'Tail Press' : '50-50';
  else if (a < 42) base = side > 0 ? 'Crooked Grind' : 'Feeble Grind';
  else if (a < 68) base = side > 0 ? 'Smith Grind' : 'Suski Grind';
  else {
    const lip = side < 0;
    if (press > 0) base = lip ? 'Bluntslide' : 'Tail Bluntslide';
    else if (press < 0) base = lip ? 'Nose Bluntslide' : 'Nosebluntslide';
    else base = lip ? 'Lipslide' : 'Boardslide';
  }
  return `${sw}${base}`;
}

export const GRIND_DIFFICULTY = {
  '50-50': 1.0, 'Nose Press': 1.35, 'Tail Press': 1.30,
  'Crooked Grind': 1.45, 'Feeble Grind': 1.45, 'Smith Grind': 1.55, 'Suski Grind': 1.55,
  'Boardslide': 1.30, 'Lipslide': 1.50, 'Bluntslide': 1.70, 'Tail Bluntslide': 1.70,
  'Nose Bluntslide': 1.75, 'Nosebluntslide': 1.75, 'Darkslide': 2.10,
};

export function grindDifficulty(name) {
  const bare = name.replace(/^Switch /, '');
  return GRIND_DIFFICULTY[bare] ?? 1.0;
}

// ── Small maths helpers shared by the trick modules ────────────────────────

export const TAU = Math.PI * 2;
export function wrapPi(a) { return a - TAU * Math.floor((a + Math.PI) / TAU); }
export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
export function deg(r) { return r * 180 / Math.PI; }
export function rad(d) { return d * Math.PI / 180; }
