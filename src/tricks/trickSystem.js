// OWNER: agent "tricks". Placeholder — passes input straight through.
export class TrickSystem {
  constructor() { this.score = 0; this.combo = 0; this.boost = 0; this.current = null; this.tricks = []; }
  fixedUpdate(dt, input, body) { return { steer: input.axis.steer, pitch: input.axis.pitch }; }
  reset() { this.score = 0; this.combo = 0; this.boost = 0; }
}
