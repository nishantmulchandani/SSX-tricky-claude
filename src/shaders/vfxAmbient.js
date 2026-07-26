/**
 * OWNER: agent "vfx".
 *
 * Ambient airborne snow: drifting crystals and light snowfall.
 *
 * This one is not pooled and never respawns — the particles live in an
 * INFINITE wrapped domain. Each instance has a fixed base position inside a
 * box; the vertex shader drifts it with the wind and then folds it back into
 * a box centred on the camera with a single `mod`. The result is an endless
 * snowfield that costs exactly one uniform update per frame on the CPU and
 * never pops, because a wrapped particle re-enters at the far side of a box
 * that is always ~40 m away from the eye and behind a distance fade.
 *
 * Crystals also glint: a tiny specular flash keyed on the seed and the sun
 * angle, so the air has sparkle rather than a uniform haze of dots.
 *
 * GLSL ES 1.00.
 */

export const VFX_AMBIENT_VERT = /* glsl */`
attribute vec3 aOrigin;   // base position inside the wrap box
attribute vec4 aParam;    // seed, size, alpha, kind (0 = crystal, 1 = flake)

uniform float uTime;
uniform vec3 uCamPos;
uniform vec3 uCamVel;
uniform vec3 uWind;
uniform float uBox;        // wrap box edge length, metres
uniform float uFall;       // base fall speed
uniform vec2 uStretch;     // camera-motion stretch per (m/s), max
uniform float uAmount;     // global density 0..1 (culls by seed)

varying vec2 vUv;
varying vec4 vClip;
varying vec3 vViewPos;
varying float vAlpha;
varying float vDist;
varying float vSeed;
varying float vKind;
varying float vGlint;

void main() {
  float seed = aParam.x;

  if (seed > uAmount) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    vAlpha = 0.0; vUv = vec2(0.0); vClip = vec4(0.0, 0.0, 1.0, 1.0);
    vViewPos = vec3(0.0); vDist = 1.0; vSeed = 0.0; vKind = 0.0; vGlint = 0.0;
    return;
  }

  float kind = aParam.w;
  float fall = uFall * mix(0.35, 1.0, fract(seed * 71.3)) * mix(0.6, 1.4, kind);

  // Drift: wind + gravity + a slow flutter that is unique per crystal.
  vec3 p = aOrigin;
  p += uWind * uTime;
  p.y -= fall * uTime;
  float ph = seed * 43.1;
  p.x += sin(uTime * (0.6 + seed) + ph) * mix(0.35, 1.4, kind);
  p.z += cos(uTime * (0.5 + seed * 1.3) + ph * 1.7) * mix(0.35, 1.4, kind);
  p.y += sin(uTime * 0.9 + ph * 2.3) * 0.25;

  // Fold into a box centred on the camera. This is the whole trick.
  vec3 rel = p - uCamPos;
  rel = mod(rel + uBox * 0.5, uBox) - uBox * 0.5;
  vec3 world = uCamPos + rel;

  float dist = length(rel);

  vec4 mv = modelViewMatrix * vec4(world, 1.0);
  float size = aParam.y;

  // Motion reaction: flakes smear along the camera's screen-space velocity.
  vec3 relVel = (viewMatrix * vec4(-uCamVel, 0.0)).xyz;
  vec2 d = relVel.xy;
  float l = length(d);
  vec2 dir = l > 1e-4 ? d / l : vec2(0.0, 1.0);
  float st = 1.0 + min(l * uStretch.x, uStretch.y) * mix(0.35, 1.0, kind);

  vec2 c = position.xy * size;
  vec2 off = dir * (c.y * st) + vec2(-dir.y, dir.x) * c.x;
  mv.xy += off;

  vViewPos = mv.xyz;
  vDist = -mv.z;
  vClip = projectionMatrix * mv;
  gl_Position = vClip;

  vUv = uv;
  vSeed = seed;
  vKind = kind;

  // Near fade + far fade against the wrap boundary so nothing pops in.
  float near = smoothstep(0.6, 2.5, dist);
  float far = 1.0 - smoothstep(uBox * 0.30, uBox * 0.48, dist);
  vAlpha = aParam.z * near * far;

  // Crystal twinkle: a fast, sparse flash.
  float tw = sin(uTime * (5.0 + seed * 9.0) + seed * 61.0) * 0.5 + 0.5;
  vGlint = pow(tw, 7.0) * (1.0 - kind);
}
`;

export const VFX_AMBIENT_FRAG = /* glsl */`
#include <packing>

uniform sampler2D tDepth;
uniform vec4 uDepthParams;
uniform float uDepthEnabled;
uniform float uSoftFade;

uniform vec3 uSunView;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform vec3 uTint;
uniform vec2 uLight;      // diffuse, glint gain

varying vec2 vUv;
varying vec4 vClip;
varying vec3 vViewPos;
varying float vAlpha;
varying float vDist;
varying float vSeed;
varying float vKind;
varying float vGlint;

void main() {
  if (vAlpha <= 0.0) discard;

  vec2 p = vUv * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;

  float zc = sqrt(max(0.0, 1.0 - r2));
  // Crystals are hard little chips, flakes are soft blobs.
  float core = mix(smoothstep(1.0, 0.55, sqrt(r2)), smoothstep(1.0, 0.05, sqrt(r2)), vKind);

  vec3 nView = normalize(vec3(p * mix(0.55, 0.95, vKind), zc));
  vec3 nWorld = nView * mat3(viewMatrix);

  float ndl = dot(nView, uSunView);
  float diff = clamp((ndl + 0.75) / 1.75, 0.0, 1.0);
  float fwd = clamp(dot(normalize(vViewPos), -uSunView), 0.0, 1.0);
  float phase = pow(fwd, 6.0);

  vec3 amb = mix(uGroundColor, uSkyColor, nWorld.y * 0.5 + 0.5);
  vec3 col = uTint * (uSunColor * (diff * uLight.x + phase * 0.5) + amb * 0.55);
  col += uSunColor * (vGlint * uLight.y);

  float fade = 1.0;
  if (uDepthEnabled > 0.5) {
    vec2 suv = vClip.xy / vClip.w * 0.5 + 0.5;
    float d = texture2D(tDepth, suv).x;
    float sceneDist = d >= 0.9999
      ? uDepthParams.y
      : -perspectiveDepthToViewZ(d, uDepthParams.x, uDepthParams.y);
    fade = clamp((sceneDist - vDist) / max(uSoftFade, 1e-3), 0.0, 1.0);
  }

  float a = core * vAlpha * fade;
  if (a <= 0.002) discard;

  gl_FragColor = vec4(col * a, a);
}
`;
