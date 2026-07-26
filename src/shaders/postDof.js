import { FS_VERT, DEPTH_UTILS } from './postCommon.js';

/**
 * OWNER: agent "vfx".
 * Thin-lens depth of field. Half-res golden-angle disc gather, composited by
 * circle-of-confusion. Deliberately restrained: the rider stays sharp, the
 * far mountains get just enough softness to give the frame depth.
 */

export const DofGatherShader = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    uDepthParams: { value: null },
    uTexel: { value: null },
    uFocus: { value: 10.0 },
    uMaxCoC: { value: 2.4 },     // pixels, at half resolution
    uNearScale: { value: 0.55 },
  },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */`
    #include <packing>
    uniform sampler2D tDiffuse, tDepth;
    uniform vec4 uDepthParams;
    uniform vec2 uTexel;
    uniform float uFocus, uMaxCoC, uNearScale;
    varying vec2 vUv;
    ${DEPTH_UTILS}

    // Signed CoC in half-res pixels. Negative = in front of the focal plane.
    float cocAt(vec2 uv) {
      float dist = viewDepthAt(tDepth, uv, uDepthParams.x, uDepthParams.y);
      float c = 1.0 - uFocus / max(dist, 0.05);
      // Soften the far ramp so distant terrain does not turn to mush.
      c = sign(c) * pow(abs(c), 1.35);
      return clamp(c, -uNearScale, 1.0) * uMaxCoC;
    }

    #define TAPS 16
    const float GOLDEN = 2.39996323;

    void main() {
      float coc = cocAt(vUv);
      float r = abs(coc);
      vec3 sum = texture2D(tDiffuse, vUv).rgb;
      float total = 1.0;

      for (int i = 0; i < TAPS; i++) {
        float fi = float(i) + 1.0;
        float a = fi * GOLDEN;
        float rad = sqrt(fi / float(TAPS));
        vec2 offs = vec2(cos(a), sin(a)) * rad * r * uTexel;
        vec2 uv = vUv + offs;
        vec3 c = texture2D(tDiffuse, uv).rgb;
        float tapCoC = cocAt(uv);
        // A sharp foreground must not be smeared by a blurry background tap.
        float w = clamp((abs(tapCoC) - rad * r) * 2.0 + 1.0, 0.0, 1.0);
        // Bokeh weighting: bright samples spread more, like real defocus.
        w *= 1.0 / (1.0 + max(0.0, max(c.r, max(c.g, c.b)) - 1.0) * 0.35);
        sum += c * w;
        total += w;
      }
      gl_FragColor = vec4(sum / total, clamp(r / max(uMaxCoC, 1e-3), 0.0, 1.0));
    }`,
};

export const DofCompositeShader = {
  uniforms: {
    tDiffuse: { value: null },
    tBlur: { value: null },
    tDepth: { value: null },
    uDepthParams: { value: null },
    uFocus: { value: 10.0 },
    uMaxCoC: { value: 2.4 },
    uNearScale: { value: 0.55 },
    uStrength: { value: 1.0 },
  },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */`
    #include <packing>
    uniform sampler2D tDiffuse, tBlur, tDepth;
    uniform vec4 uDepthParams;
    uniform float uFocus, uMaxCoC, uNearScale, uStrength;
    varying vec2 vUv;
    ${DEPTH_UTILS}
    void main() {
      vec4 sharp = texture2D(tDiffuse, vUv);
      float dist = viewDepthAt(tDepth, vUv, uDepthParams.x, uDepthParams.y);
      float c = 1.0 - uFocus / max(dist, 0.05);
      c = sign(c) * pow(abs(c), 1.35);
      float coc = clamp(abs(clamp(c, -uNearScale, 1.0)), 0.0, 1.0);
      float mixAmt = smoothstep(0.05, 0.85, coc) * uStrength;
      vec3 blurred = texture2D(tBlur, vUv).rgb;
      gl_FragColor = vec4(mix(sharp.rgb, blurred, mixAmt), sharp.a);
    }`,
};
