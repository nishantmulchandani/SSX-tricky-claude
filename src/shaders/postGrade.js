import { FS_VERT, LUMA, HASH } from './postCommon.js';

/**
 * OWNER: agent "vfx".
 * Final display-referred pass. Runs after tone mapping and AA, so this is the
 * "print" stage: lens (distortion + chromatic aberration), a filmic LUT-style
 * grade, vignette and film grain.
 *
 * Snow is the hardest subject for a grade: everything wants to collapse into
 * one flat white. The grade therefore (a) keeps a cool shadow / warm highlight
 * split so the snow reads as a *surface* rather than as paper, (b) applies a
 * gentle S-curve that protects the highlight shoulder, and (c) never lifts
 * saturation globally, only in the mid-tones.
 */
export const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: null },
    uTime: { value: 0 },
    uRush: { value: 0 },            // 0..1 speed rush
    uAberration: { value: 0.0022 }, // base CA at the frame edge, in uv
    uDistort: { value: 0.0 },       // extra barrel with rush
    uVignette: { value: 0.42 },
    uGrain: { value: 0.022 },
    uContrast: { value: 1.075 },
    uShoulder: { value: 0.80 },     // where the highlight roll-off begins
    uSaturation: { value: 1.06 },
    uShadowTint: { value: null },
    uHighlightTint: { value: null },
    uLift: { value: null },
    uExposure: { value: 1.0 },
  },
  vertexShader: FS_VERT,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 uResolution;
    uniform float uTime, uRush, uAberration, uDistort, uVignette, uGrain;
    uniform float uContrast, uSaturation, uExposure, uShoulder;
    uniform vec3 uShadowTint, uHighlightTint, uLift;
    varying vec2 vUv;
    ${LUMA}
    ${HASH}

    void main() {
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);

      // --- lens: barrel stretch that ramps with speed -----------------------
      float distort = 1.0 + (uDistort + uRush * 0.055) * r2;
      vec2 uv = 0.5 + c * distort;

      // --- chromatic aberration: transverse, so zero in the centre ---------
      float ca = uAberration * (1.0 + uRush * 6.0) * (0.35 + r2 * 4.0);
      vec2 dir = c * ca;
      vec3 col;
      col.r = texture2D(tDiffuse, uv + dir).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - dir).b;

      col = max(col, 0.0) * uExposure;

      // --- filmic grade -----------------------------------------------------
      float l = luma(col);

      // Split tone: sky-lit snow shadows are genuinely blue, sunlit snow warm.
      col *= mix(uShadowTint, uHighlightTint, smoothstep(0.12, 0.92, l));

      // S-curve around a low pivot: keeps the highlight shoulder intact so the
      // snow retains modelling instead of clipping to paper white.
      col = (col - 0.42) * uContrast + 0.42;
      col = clamp(col, 0.0, 1.6);
      vec3 s = clamp(col, 0.0, 1.0);
      col = mix(col, s * s * (3.0 - 2.0 * s), 0.28);

      // Lifted, slightly cool blacks — the single biggest "not-WebGL" cue.
      col = uLift + col * (1.0 - uLift);

      // Mid-tone saturation only; leave the highlights alone.
      float l2 = luma(col);
      float satMask = 1.0 - smoothstep(0.55, 1.0, l2);
      col = mix(vec3(l2), col, mix(1.0, uSaturation, satMask));

      // --- highlight shoulder -----------------------------------------------
      // Everything above uses a contrast expansion around a low pivot, which
      // pushes sunlit snow past 1.0 and the final clamp then flattens it into
      // paper white. Roughly a fifth of a typical frame was landing there, so
      // the corduroy, sastrugi and wind polish the snow shader computes were
      // being thrown away over the brightest — and largest — part of the image.
      //
      // This is an exponential shoulder: below uShoulder nothing is touched at
      // all, and above it the response rolls off asymptotically towards 1.0 and
      // never reaches it. Two values that both used to clamp to pure white now
      // land on two different greys, which is the whole point — the snow keeps
      // its modelling and the frame keeps its brightness.
      vec3 over = max(col - uShoulder, 0.0);
      float range = max(1.0 - uShoulder, 1e-4);
      col = min(col, uShoulder) + range * (1.0 - exp(-over / range));

      // --- vignette ---------------------------------------------------------
      float vig = 1.0 - uVignette * pow(clamp(r2 * 2.0, 0.0, 1.0), 1.35);
      col *= vig;

      // --- grain: stronger in the shadows, like real film -------------------
      float g = hash13(vec3(gl_FragCoord.xy, floor(uTime * 24.0)));
      col += (g - 0.5) * uGrain * mix(1.7, 0.35, smoothstep(0.0, 0.7, luma(col)));

      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }`,
};
