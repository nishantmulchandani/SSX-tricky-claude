import { FS_VERT, LUMA } from './postCommon.js';

/**
 * OWNER: agent "vfx".
 * Physically thresholded bloom: Call-of-Duty style progressive down/up sample
 * with a Karis-averaged prefilter. Operates on scene-linear HDR, so the
 * threshold is a real radiance value — only genuine highlights (sun disc,
 * specular snow glints) survive, everything else is untouched.
 */

/** Soft-knee threshold + firefly-suppressing 4-tap Karis average. */
export const BloomPrefilterShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTexel: { value: null },
    uThreshold: { value: 1.0 },
    uKnee: { value: 0.55 },
    uClamp: { value: 24.0 },
  },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 uTexel;
    uniform float uThreshold, uKnee, uClamp;
    varying vec2 vUv;
    ${LUMA}

    vec3 tap(vec2 uv) { return min(texture2D(tDiffuse, uv).rgb, vec3(uClamp)); }

    void main() {
      // 4 bilinear taps, weighted by inverse luminance (Karis) so a single
      // blown-out pixel cannot dominate a whole bloom mip.
      vec3 a = tap(vUv + uTexel * vec2(-1.0, -1.0));
      vec3 b = tap(vUv + uTexel * vec2( 1.0, -1.0));
      vec3 c = tap(vUv + uTexel * vec2(-1.0,  1.0));
      vec3 d = tap(vUv + uTexel * vec2( 1.0,  1.0));
      float wa = 1.0 / (1.0 + luma(a));
      float wb = 1.0 / (1.0 + luma(b));
      float wc = 1.0 / (1.0 + luma(c));
      float wd = 1.0 / (1.0 + luma(d));
      vec3 col = (a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd);

      // Soft-knee curve (Jimenez / Unity): quadratic ramp through the knee.
      float l = max(max(col.r, col.g), col.b);
      float soft = clamp(l - uThreshold + uKnee, 0.0, 2.0 * uKnee);
      soft = soft * soft / (4.0 * uKnee + 1e-5);
      float contrib = max(soft, l - uThreshold) / max(l, 1e-5);

      gl_FragColor = vec4(col * contrib, 1.0);
    }`,
};

/** 13-tap downsample — no aliasing on the way down the pyramid. */
export const BloomDownShader = {
  uniforms: { tDiffuse: { value: null }, uTexel: { value: null } },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 uTexel;
    varying vec2 vUv;
    vec3 T(vec2 o) { return texture2D(tDiffuse, vUv + o * uTexel).rgb; }
    void main() {
      vec3 a = T(vec2(-2.0,  2.0)), b = T(vec2( 0.0,  2.0)), c = T(vec2( 2.0,  2.0));
      vec3 d = T(vec2(-2.0,  0.0)), e = T(vec2( 0.0,  0.0)), f = T(vec2( 2.0,  0.0));
      vec3 g = T(vec2(-2.0, -2.0)), h = T(vec2( 0.0, -2.0)), i = T(vec2( 2.0, -2.0));
      vec3 j = T(vec2(-1.0,  1.0)), k = T(vec2( 1.0,  1.0));
      vec3 l = T(vec2(-1.0, -1.0)), m = T(vec2( 1.0, -1.0));
      vec3 col = e * 0.125;
      col += (a + c + g + i) * 0.03125;
      col += (b + d + f + h) * 0.0625;
      col += (j + k + l + m) * 0.125;
      gl_FragColor = vec4(col, 1.0);
    }`,
};

/** 9-tap tent upsample, additively blended into the finer mip. */
export const BloomUpShader = {
  uniforms: { tDiffuse: { value: null }, uTexel: { value: null }, uRadius: { value: 1.0 } },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 uTexel;
    uniform float uRadius;
    varying vec2 vUv;
    vec3 T(vec2 o) { return texture2D(tDiffuse, vUv + o * uTexel * uRadius).rgb; }
    void main() {
      vec3 col = T(vec2(0.0, 0.0)) * 4.0;
      col += (T(vec2(-1.0, 0.0)) + T(vec2(1.0, 0.0)) + T(vec2(0.0, -1.0)) + T(vec2(0.0, 1.0))) * 2.0;
      col += T(vec2(-1.0, -1.0)) + T(vec2(1.0, -1.0)) + T(vec2(-1.0, 1.0)) + T(vec2(1.0, 1.0));
      gl_FragColor = vec4(col / 16.0, 1.0);
    }`,
};

/** Final composite: scene + weighted bloom, with a mild lens-dirt-free falloff. */
export const BloomCompositeShader = {
  uniforms: {
    tDiffuse: { value: null },
    tBloom: { value: null },
    uIntensity: { value: 0.055 },
    uTint: { value: null },
  },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse, tBloom;
    uniform float uIntensity;
    uniform vec3 uTint;
    varying vec2 vUv;
    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      vec3 bloom = texture2D(tBloom, vUv).rgb;
      gl_FragColor = vec4(base.rgb + bloom * uTint * uIntensity, base.a);
    }`,
};
