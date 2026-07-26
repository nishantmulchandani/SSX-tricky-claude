import { FS_VERT, DEPTH_UTILS } from './postCommon.js';

/**
 * OWNER: agent "vfx".
 * Depth of field. Half-res golden-angle disc gather, composited by circle of
 * confusion. Deliberately restrained: the rider and the whole rideable
 * mid-ground stay sharp, only the far peaks and the very near foreground get
 * softened — enough to separate the planes, never enough to read as "blurry".
 *
 * The CoC is authored with explicit metre ranges rather than a true thin lens,
 * because a real lens focused at 10 m would blur a 2 km mountain into paste.
 */
const COC_GLSL = /* glsl */`
  // Signed CoC in [-1, 1]. Negative = nearer than the focal plane.
  float cocNorm(float dist) {
    float far01  = smoothstep(uFocus * 2.2, uFocus * 2.2 + uFarRange, dist);
    float near01 = 1.0 - smoothstep(uFocus * 0.18, uFocus * 0.82, dist);
    return far01 * far01 * uFarScale - near01 * uNearScale;
  }`;

export const DofGatherShader = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    uDepthParams: { value: null },
    uTexel: { value: null },
    uFocus: { value: 10.0 },
    uFarRange: { value: 520.0 },
    uFarScale: { value: 1.0 },
    uNearScale: { value: 0.42 },
    uMaxCoC: { value: 3.0 },     // half-res pixels
  },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */`
    #include <packing>
    uniform sampler2D tDiffuse, tDepth;
    uniform vec4 uDepthParams;
    uniform vec2 uTexel;
    uniform float uFocus, uFarRange, uFarScale, uNearScale, uMaxCoC;
    varying vec2 vUv;
    ${DEPTH_UTILS}
    ${COC_GLSL}

    #define TAPS 12
    const float GOLDEN = 2.39996323;

    void main() {
      float dist = viewDepthAt(tDepth, vUv, uDepthParams.x, uDepthParams.y);
      float r = abs(cocNorm(dist)) * uMaxCoC;

      vec3 sum = texture2D(tDiffuse, vUv).rgb;
      float total = 1.0;

      for (int i = 0; i < TAPS; i++) {
        float fi = float(i) + 1.0;
        float a = fi * GOLDEN;
        float rad = sqrt(fi / float(TAPS));
        vec2 uv = vUv + vec2(cos(a), sin(a)) * rad * r * uTexel;
        vec3 c = texture2D(tDiffuse, uv).rgb;
        float tapDist = viewDepthAt(tDepth, uv, uDepthParams.x, uDepthParams.y);
        float tapR = abs(cocNorm(tapDist)) * uMaxCoC;
        // A sharp neighbour must not be smeared in by a blurry centre pixel.
        float w = clamp((tapR - rad * r) * 1.5 + 1.0, 0.0, 1.0);
        sum += c * w;
        total += w;
      }
      gl_FragColor = vec4(sum / total, 1.0);
    }`,
};

export const DofCompositeShader = {
  uniforms: {
    tDiffuse: { value: null },
    tBlur: { value: null },
    tDepth: { value: null },
    uDepthParams: { value: null },
    uFocus: { value: 10.0 },
    uFarRange: { value: 520.0 },
    uFarScale: { value: 1.0 },
    uNearScale: { value: 0.42 },
    uStrength: { value: 1.0 },
  },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */`
    #include <packing>
    uniform sampler2D tDiffuse, tBlur, tDepth;
    uniform vec4 uDepthParams;
    uniform float uFocus, uFarRange, uFarScale, uNearScale, uStrength;
    varying vec2 vUv;
    ${DEPTH_UTILS}
    ${COC_GLSL}
    void main() {
      vec4 sharp = texture2D(tDiffuse, vUv);
      float dist = viewDepthAt(tDepth, vUv, uDepthParams.x, uDepthParams.y);
      float coc = abs(cocNorm(dist));
      float mixAmt = smoothstep(0.04, 0.75, coc) * uStrength;
      gl_FragColor = vec4(mix(sharp.rgb, texture2D(tBlur, vUv).rgb, mixAmt), sharp.a);
    }`,
};
