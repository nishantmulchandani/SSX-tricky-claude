// OWNER: agent "vfx". Placeholder — direct render, no post stack yet.
export function createPostStack(engine) {
  return {
    render() { engine.renderer.render(engine.scene, engine.camera); },
    resize() {},
  };
}
