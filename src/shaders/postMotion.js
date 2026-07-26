import { FS_VERT, DEPTH_UTILS, HASH } from './postCommon.js';

/**
 * OWNER: agent "vfx".
 * Camera motion blur from depth reprojection, plus a speed-driven radial
 * "rush" component. One pass, 11 dithered taps along the combined vector.
 *
 * The reprojection term gives true per-pixel parallax blur (near terrain
 * streaks, distant peaks stay sharp); the radial term is the SSX arcade
 * exaggeration on top of it.
 */
export const MotionRushShader = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    uDepthParams: { value: null },
    uInvViewProj: { value: null },
    uPrevViewProj: { value: null },
    uVelScale: { value: 0.55 },
    uRush: { value: 0.0 },
    uCenter: { value: null },
    uMaxVel: { value: 0.055 },
    uSeed: { value: 0.0 },
  },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */`
    #include <packing>
    uniform sampler2D tDiffuse, tDepth;
    uniform vec4 uDepthParams;
    uniform mat4 uInvViewProj, uPrevViewProj;
    uniform vec2 uCenter;
    uniform float uVelScale, uRush, uMaxVel, uSeed;
    varying vec2 vUv;
    ${DEPTH_UTILS}
    ${HASH}

    #define TAPS 11

    void main() {
      float raw = min(texture2D(tDepth, vUv).x, 0.99995);

      vec4 clip = vec4(vUv * 2.0 - 1.0, raw * 2.0 - 1.0, 1.0);
      vec4 world = uInvViewProj * clip;
      world /= world.w;
      vec4 prevClip = uPrevViewProj * vec4(world.xyz, 1.0);
      vec2 prevUv = (prevClip.xy / max(abs(prevClip.w), 1e-4) * sign(prevClip.w)) * 0.5 + 0.5;

      vec2 vel = (vUv - prevUv) * uVelScale;

      // Radial rush: zero at the focal centre, strongest at the frame edge.
      vec2 dir = vUv - uCenter;
      float rr = dot(dir, dir);
      vec2 radial = dir * uRush * (0.25 + 1.9 * rr);

      vec2 total = vel + radial;
      float len = length(total);
      if (len > uMaxVel) total *= uMaxVel / len;
      if (len < 0.0008) { gl_FragColor = texture2D(tDiffuse, vUv); return; }

      // Dither the tap positions so the blur does not band.
      float j = hash12(gl_FragCoord.xy + uSeed);
      vec3 sum = vec3(0.0);
      for (int i = 0; i < TAPS; i++) {
        float t = (float(i) + j) / float(TAPS) - 0.5;
        sum += texture2D(tDiffuse, vUv + total * t).rgb;
      }
      gl_FragColor = vec4(sum / float(TAPS), 1.0);
    }`,
};
