/**
 * Unified input: keyboard + gamepad, exposed as an SSX-style action set.
 * Analog where the hardware allows, digital-smoothed where it doesn't.
 */
const KEYMAP = {
  KeyW: 'tuck', ArrowUp: 'tuck',
  KeyS: 'brake', ArrowDown: 'brake',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  Space: 'jump',
  ShiftLeft: 'prewind', ShiftRight: 'prewind',
  KeyJ: 'grab1', KeyK: 'grab2', KeyL: 'grab3', KeyI: 'grab4',
  KeyQ: 'spinL', KeyE: 'spinR',
  KeyR: 'reset',
  KeyU: 'uber',
  Escape: 'pause',
};

export class Input {
  constructor() {
    this.actions = Object.create(null);
    this.pressed = Object.create(null); // edge-triggered, cleared each frame
    this.released = Object.create(null);
    this.axis = { steer: 0, pitch: 0 };
    this._raw = { steer: 0, pitch: 0 };
    this.gamepadIndex = null;

    addEventListener('keydown', (e) => {
      const a = KEYMAP[e.code];
      if (!a) return;
      e.preventDefault();
      if (!this.actions[a]) this.pressed[a] = true;
      this.actions[a] = true;
    });
    addEventListener('keyup', (e) => {
      const a = KEYMAP[e.code];
      if (!a) return;
      e.preventDefault();
      this.actions[a] = false;
      this.released[a] = true;
    });
    addEventListener('blur', () => { this.actions = Object.create(null); });
    addEventListener('gamepadconnected', (e) => { this.gamepadIndex = e.gamepad.index; });
    addEventListener('gamepaddisconnected', () => { this.gamepadIndex = null; });
  }

  down(a) { return !!this.actions[a]; }
  justPressed(a) { return !!this.pressed[a]; }
  justReleased(a) { return !!this.released[a]; }

  /** Called once per fixed step, before gameplay reads input. */
  poll(dt) {
    let steer = (this.down('right') ? 1 : 0) - (this.down('left') ? 1 : 0);
    let pitch = (this.down('brake') ? 1 : 0) - (this.down('tuck') ? 1 : 0);

    const pads = navigator.getGamepads?.() ?? [];
    const pad = this.gamepadIndex != null ? pads[this.gamepadIndex] : pads.find(Boolean);
    if (pad) {
      const dz = (v) => (Math.abs(v) < 0.16 ? 0 : (v - Math.sign(v) * 0.16) / 0.84);
      const lx = dz(pad.axes[0] ?? 0), ly = dz(pad.axes[1] ?? 0);
      if (lx) steer = lx;
      if (ly) pitch = ly;
      const b = pad.buttons;
      this._padHold('jump', b[0]?.pressed);
      this._padHold('grab1', b[2]?.pressed);
      this._padHold('grab2', b[3]?.pressed);
      this._padHold('grab3', b[1]?.pressed);
      this._padHold('prewind', (b[6]?.value ?? 0) > 0.4);
      this._padHold('spinL', b[4]?.pressed);
      this._padHold('spinR', b[5]?.pressed);
      this._padHold('uber', (b[7]?.value ?? 0) > 0.6);
    }

    // Digital keys get eased so keyboard carving still feels analog.
    const rate = 1 - Math.exp(-14 * dt);
    this._raw.steer += (steer - this._raw.steer) * rate;
    this._raw.pitch += (pitch - this._raw.pitch) * rate;
    this.axis.steer = this._raw.steer;
    this.axis.pitch = this._raw.pitch;
  }

  _padHold(action, isDown) {
    if (isDown && !this.actions[action]) this.pressed[action] = true;
    if (!isDown && this.actions[action]) this.released[action] = true;
    if (isDown) this.actions[action] = true;
    else if (this.actions[action]) this.actions[action] = false;
  }

  /** Called at the very end of the frame. */
  endFrame() {
    this.pressed = Object.create(null);
    this.released = Object.create(null);
  }
}
