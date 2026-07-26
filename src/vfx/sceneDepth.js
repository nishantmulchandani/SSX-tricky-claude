import * as THREE from 'three';

/**
 * OWNER: agent "vfx".
 *
 * A single half-resolution depth prepass shared by the post stack (DOF,
 * god rays, motion blur) and by the particle materials (soft particles).
 *
 * The particle materials are created before the post stack exists, so they
 * bind these uniform *holder objects* by reference at construction time and
 * simply see the texture appear once the prepass starts running. If the post
 * stack is never created, `enabled` stays 0 and the shaders take the cheap
 * branch.
 */
export const SceneDepth = {
  texture: { value: null },
  /** x = near, y = far, z = 1/width, w = 1/height (of the prepass buffer). */
  params: { value: new THREE.Vector4(0.1, 12000, 1 / 640, 1 / 360) },
  enabled: { value: 0 },
};

/** Roots that must be hidden during the depth prepass (transparent VFX). */
const excluded = [];
export function excludeFromDepth(object3D) {
  if (object3D && excluded.indexOf(object3D) === -1) excluded.push(object3D);
}

export class DepthPrepass {
  constructor(renderer, scene, camera, scale = 0.5) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.scale = scale;

    // Depth-only: no shading, no colour writes. One geometry pass, cheap.
    this.overrideMaterial = new THREE.MeshBasicMaterial({ colorWrite: false });

    this.target = null;
    this._vis = [];
  }

  setSize(width, height) {
    const w = Math.max(2, Math.floor(width * this.scale));
    const h = Math.max(2, Math.floor(height * this.scale));
    if (this.target) {
      if (this.target.width === w && this.target.height === h) return;
      this.target.dispose();
      this.target.depthTexture?.dispose();
    }
    const depthTexture = new THREE.DepthTexture(w, h);
    depthTexture.type = THREE.UnsignedIntType;
    depthTexture.minFilter = THREE.NearestFilter;
    depthTexture.magFilter = THREE.NearestFilter;

    this.target = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      depthTexture,
      generateMipmaps: false,
    });

    SceneDepth.texture.value = depthTexture;
    SceneDepth.params.value.set(this.camera.near, this.camera.far, 1 / w, 1 / h);
    SceneDepth.enabled.value = 1;
  }

  render() {
    const r = this.renderer;
    const scene = this.scene;

    SceneDepth.params.value.x = this.camera.near;
    SceneDepth.params.value.y = this.camera.far;

    // Hide transparent VFX so they do not write the depth they sample.
    this._vis.length = 0;
    for (let i = 0; i < excluded.length; i++) {
      this._vis.push(excluded[i].visible);
      excluded[i].visible = false;
    }

    const prevOverride = scene.overrideMaterial;
    const prevBg = scene.background;
    const prevShadowAuto = r.shadowMap.autoUpdate;
    const prevTarget = r.getRenderTarget();

    scene.overrideMaterial = this.overrideMaterial;
    scene.background = null;
    r.shadowMap.autoUpdate = false;   // shadows are irrelevant to a depth-only pass

    r.setRenderTarget(this.target);
    r.clear(true, true, false);
    r.render(scene, this.camera);

    r.setRenderTarget(prevTarget);
    r.shadowMap.autoUpdate = prevShadowAuto;
    scene.overrideMaterial = prevOverride;
    scene.background = prevBg;

    for (let i = 0; i < excluded.length; i++) excluded[i].visible = this._vis[i];
  }

  dispose() {
    this.target?.depthTexture?.dispose();
    this.target?.dispose();
    this.overrideMaterial.dispose();
  }
}
