/**
 * OWNER: agent "vfx".
 * Shared GLSL fragments for the post stack. Everything here assumes:
 *   - the colour buffer is scene-linear HDR (half float) until OutputPass
 *   - depth comes from the half-res prepass in src/vfx/sceneDepth.js
 */

/** Full-screen triangle/quad vertex shader for FullScreenQuad (positions in NDC). */
export const FS_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

/** Depth helpers. Requires `#include <packing>` in the fragment shader. */
export const DEPTH_UTILS = /* glsl */`
float rawDepthAt(sampler2D tDepth, vec2 uv) {
  return texture2D(tDepth, uv).x;
}
/** Positive metres from the camera plane. */
float viewDepthAt(sampler2D tDepth, vec2 uv, float near, float far) {
  float d = texture2D(tDepth, uv).x;
  if (d >= 0.9999) return far;
  return -perspectiveDepthToViewZ(d, near, far);
}`;

export const LUMA = /* glsl */`
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }`;

/** Cheap hash suite — used for grain and blur dithering. */
export const HASH = /* glsl */`
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}`;
