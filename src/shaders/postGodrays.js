import { FS_VERT, DEPTH_UTILS } from './postCommon.js';

/**
 * OWNER: agent "vfx".
 * Screen-space light shafts. Two stages:
 *   1. occlusion buffer — sky radiance near the sun, zeroed wherever geometry
 *      occludes it (read from the half-res depth prepass)
 *   2. iterative radial blur from the sun's screen position
 * Composited additively with a wavelength-ish tint so the shafts read warm.
 */

export const GodRaySourceShader = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    uDepthParams: { value: null },   // near, far, 1/w, 1/h
    uSunUv: { value: null },
    uAspect: { value: 1.0 },
    uSunRadius: { value: 0.055 },
    uSunGlare: { value: 6.0 },
    uProximity: { value: 2.2 },
    uSkyGain: { value: 0.35 },
  },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */`
    #include <packing>
    uniform sampler2D tDiffuse, tDepth;
    uniform vec4 uDepthParams;
    uniform vec2 uSunUv;
    uniform float uAspect, uSunRadius, uSunGlare, uProximity, uSkyGain;
    varying vec2 vUv;
    ${DEPTH_UTILS}

    void main() {
      float raw = texture2D(tDepth, vUv).x;
      // Sky = nothing written to depth. Anything else fully occludes the shaft.
      float sky = step(0.9995, raw);

      vec2 d2 = (vUv - uSunUv) * vec2(uAspect, 1.0);
      float d = length(d2);

      // Only radiance close to the sun feeds the shafts, otherwise the whole
      // sky smears and it reads as a bug rather than as light.
      float prox = exp(-d * d * uProximity);

      vec3 sceneCol = texture2D(tDiffuse, vUv).rgb;
      vec3 src = sceneCol * uSkyGain * prox;

      // The sun's own direct radiance. This is what actually throws the shafts;
      // it is occluded by the same depth test so ridgelines cut the beams.
      float disc = smoothstep(uSunRadius, uSunRadius * 0.15, d);
      src += vec3(1.0, 0.88, 0.72) * disc * uSunGlare;

      gl_FragColor = vec4(src * sky, 1.0);
    }`,
};

export const GodRayBlurShader = {
  uniforms: {
    tDiffuse: { value: null },
    uSunUv: { value: null },
    uStep: { value: 1.0 },      // how far this iteration reaches
    uDensity: { value: 0.85 },
    uDecay: { value: 0.94 },
  },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 uSunUv;
    uniform float uStep, uDensity, uDecay;
    varying vec2 vUv;

    #define TAPS 10

    void main() {
      vec2 delta = (vUv - uSunUv) * (uDensity * uStep / float(TAPS));
      vec2 uv = vUv;
      vec3 sum = vec3(0.0);
      float w = 1.0;
      float total = 0.0;
      for (int i = 0; i < TAPS; i++) {
        sum += texture2D(tDiffuse, uv).rgb * w;
        total += w;
        uv -= delta;
        w *= uDecay;
      }
      gl_FragColor = vec4(sum / total, 1.0);
    }`,
};

export const GodRayCompositeShader = {
  uniforms: {
    tDiffuse: { value: null },
    tRays: { value: null },
    uIntensity: { value: 0.5 },
    uTint: { value: null },
    uSunUv: { value: null },
    uAspect: { value: 1.0 },
    uVisibility: { value: 0.0 },
  },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse, tRays;
    uniform float uIntensity, uAspect, uVisibility;
    uniform vec3 uTint;
    uniform vec2 uSunUv;
    varying vec2 vUv;
    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      vec3 rays = texture2D(tRays, vUv).rgb;
      // Shafts thin out with angular distance from the sun.
      float d = length((vUv - uSunUv) * vec2(uAspect, 1.0));
      float falloff = exp(-d * d * 1.1);
      gl_FragColor = vec4(base.rgb + rays * uTint * (uIntensity * uVisibility * falloff), base.a);
    }`,
};
