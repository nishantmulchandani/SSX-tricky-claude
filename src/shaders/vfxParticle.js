/**
 * OWNER: agent "vfx".
 *
 * The one shader every pooled snow particle in the game is drawn with.
 *
 * Design notes
 * ------------
 * 1. NOTHING moves on the CPU. A particle is written once at spawn time as
 *    (origin, velocity, birth, life, shape) and the vertex shader evaluates
 *    the closed-form solution of
 *
 *        dv/dt = -k (v - v_terminal)          v_terminal = wind + g*gs/k
 *
 *    which is exact drag + gravity + wind in three instructions. A cheap
 *    sin-field curl is layered on top so plumes swirl instead of expanding
 *    like a perfect sphere.
 *
 * 2. Particles are SHADED, not textured. Each quad is a sphere impostor: the
 *    fragment derives a normal from the quad's own uv and runs a small
 *    scattering model — wrapped diffuse (snow is a dense scattering medium, so
 *    its terminator is enormous), a forward-scattering phase lobe so spray
 *    between the camera and the sun lights up like a real rooster tail, plus
 *    a sky/ground ambient split. That, and only that, is what stops particles
 *    from reading as white dots pasted on the frame.
 *
 * 3. Output is PREMULTIPLIED. rgb may exceed alpha, which lets a backlit puff
 *    glow into the bloom threshold while still correctly occluding what is
 *    behind it. Straight alpha cannot do both.
 *
 * 4. Soft particles use the shared half-res depth prepass (vfx/sceneDepth.js),
 *    so nothing ever intersects the snow with a razor edge.
 *
 * GLSL ES 1.00 (three's default). Do not use ES 3.0 reserved words here.
 */

const NOISE = /* glsl */`
float vfxHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vfxNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = vfxHash(i);
  float b = vfxHash(i + vec2(1.0, 0.0));
  float c = vfxHash(i + vec2(0.0, 1.0));
  float d = vfxHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}`;

export const VFX_PARTICLE_VERT = /* glsl */`
attribute vec3 aOrigin;   // spawn position, world space
attribute vec3 aVel;      // spawn velocity, world space
attribute vec4 aTime;     // birth, life, seed, sizeStart
attribute vec4 aShape;    // sizeEnd, drag k, gravityScale, alpha
attribute vec4 aTint;     // rgb tint, spin rate

uniform float uTime;
uniform vec3 uGravity;
uniform vec3 uWind;
uniform vec3 uTurb;        // amplitude, spatial frequency, time scale
uniform vec2 uFadeCurve;   // fade-in end, fade-out start (in normalised age)
uniform vec2 uStretch;     // per-(m/s) stretch, max stretch

varying vec2 vUv;
varying vec4 vClip;
varying vec3 vViewPos;
varying vec3 vTint;
varying float vAlpha;
varying float vDist;
varying float vSeed;
varying float vAge;

void main() {
  float t = uTime - aTime.x;
  float life = max(aTime.y, 1e-3);
  float age = t / life;

  if (t < 0.0 || age >= 1.0) {
    // Dead slot: push it behind the far plane so it is clipped for free.
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    vAlpha = 0.0;
    vUv = vec2(0.0);
    vClip = vec4(0.0, 0.0, 1.0, 1.0);
    vViewPos = vec3(0.0);
    vTint = vec3(0.0);
    vDist = 1.0;
    vSeed = 0.0;
    vAge = 0.0;
    return;
  }

  // --- closed-form drag + gravity + wind ------------------------------------
  float k = max(aShape.y, 1e-3);
  vec3 vTerm = uWind + uGravity * (aShape.z / k);
  float ek = exp(-k * t);
  vec3 pos = aOrigin + (aVel - vTerm) * ((1.0 - ek) / k) + vTerm * t;
  vec3 vel = vTerm + (aVel - vTerm) * ek;

  // --- swirl ----------------------------------------------------------------
  vec3 q = pos * uTurb.y + aTime.z * 11.0 + uTime * uTurb.z;
  vec3 curl = vec3(
    sin(q.y) + sin(q.z * 1.31),
    sin(q.z * 0.83) + sin(q.x * 1.13),
    sin(q.x) + sin(q.y * 0.91));
  pos += curl * (uTurb.x * t);
  vel += curl * uTurb.x;

  float grow = 1.0 - (1.0 - age) * (1.0 - age);
  float size = mix(aTime.w, aShape.x, grow);

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  vec2 c = position.xy * size;

#ifdef VFX_STRETCH
  vec3 velView = (viewMatrix * vec4(vel, 0.0)).xyz;
  vec2 d = velView.xy;
  float l = length(d);
  vec2 dir = l > 1e-4 ? d / l : vec2(0.0, 1.0);
  float st = 1.0 + min(l * uStretch.x, uStretch.y);
  vec2 off = dir * (c.y * st) + vec2(-dir.y, dir.x) * c.x;
#else
  float rot = aTint.a * t + aTime.z * 6.2831853;
  float cs = cos(rot);
  float sn = sin(rot);
  vec2 off = vec2(c.x * cs - c.y * sn, c.x * sn + c.y * cs);
#endif

  mv.xy += off;

  vViewPos = mv.xyz;
  vDist = -mv.z;
  vClip = projectionMatrix * mv;
  gl_Position = vClip;

  vUv = uv;
  vSeed = aTime.z;
  vAge = age;
  vTint = aTint.rgb;

  float aIn = smoothstep(0.0, max(uFadeCurve.x, 1e-3), age);
  float aOut = 1.0 - smoothstep(uFadeCurve.y, 1.0, age);
  vAlpha = aIn * aOut * aShape.w;
}
`;

export const VFX_PARTICLE_FRAG = /* glsl */`
#include <packing>

uniform sampler2D tDepth;
uniform vec4 uDepthParams;      // near, far, 1/w, 1/h
uniform float uDepthEnabled;
uniform float uSoftFade;        // metres of depth fade
uniform float uNearFade;        // metres of camera-proximity fade

uniform vec3 uSunView;          // sun direction in VIEW space, points at the sun
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;

uniform vec4 uLight;            // diffuse, forward-scatter, ambient, density
uniform float uSphericity;      // 0 = flat card, 1 = full sphere impostor
uniform float uErode;           // 0 = clean disc, 1 = ragged snow clump
uniform float uWrap;            // diffuse wrap width

varying vec2 vUv;
varying vec4 vClip;
varying vec3 vViewPos;
varying vec3 vTint;
varying float vAlpha;
varying float vDist;
varying float vSeed;
varying float vAge;

${NOISE}

void main() {
  if (vAlpha <= 0.0) discard;

  vec2 p = vUv * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  float r = sqrt(r2);

  // --- shape ---------------------------------------------------------------
  // A soft disc eroded by per-particle value noise so no two clumps share a
  // silhouette and none of them read as a circle.
  float shape = smoothstep(1.0, 0.15, r);
  float n = 1.0;
  if (uErode > 0.0) {
    vec2 np = p * 1.7 + vSeed * 51.7;
    n = vfxNoise(np * 2.1) * 0.62 + vfxNoise(np * 5.3) * 0.26 + vfxNoise(np * 11.0) * 0.12;
    n = clamp(n * 1.85, 0.0, 1.0);
    shape *= mix(1.0, n, uErode);
  }
  if (shape <= 0.002) discard;

  // --- sphere impostor normal ----------------------------------------------
  float zc = sqrt(max(0.0, 1.0 - r2));
  vec3 nView = normalize(mix(vec3(0.0, 0.0, 1.0), vec3(p, zc), uSphericity));
  vec3 nWorld = nView * mat3(viewMatrix);   // view -> world (rotation transpose)

  // --- scattering ----------------------------------------------------------
  // Wrapped diffuse: snow is optically thick and highly forward scattering, so
  // the lit/unlit terminator is enormously soft. A hard N.L looks like plastic.
  float ndl = dot(nView, uSunView);
  float diff = clamp((ndl + uWrap) / (1.0 + uWrap), 0.0, 1.0);
  diff *= diff * (3.0 - 2.0 * diff);

  // Forward lobe: light continuing towards the eye through a thin clump. This
  // is the term that makes a rooster tail glow when the sun is behind it.
  vec3 vdir = normalize(vViewPos);
  float fwd = clamp(dot(vdir, -uSunView), 0.0, 1.0);
  float phase = fwd * fwd;
  phase *= phase * phase;                       // ~pow(fwd, 8)
  float thickness = (zc * n + 0.12) * uLight.w;
  float transmit = exp(-thickness * 2.4);

  vec3 sun = uSunColor * (diff * uLight.x + phase * transmit * uLight.y);
  vec3 amb = mix(uGroundColor, uSkyColor, nWorld.y * 0.5 + 0.5) * uLight.z;
  vec3 col = vTint * (sun + amb);

  // --- soft particles ------------------------------------------------------
  float fade = 1.0;
  if (uDepthEnabled > 0.5) {
    vec2 suv = vClip.xy / vClip.w * 0.5 + 0.5;
    float d = texture2D(tDepth, suv).x;
    float sceneDist = d >= 0.9999
      ? uDepthParams.y
      : -perspectiveDepthToViewZ(d, uDepthParams.x, uDepthParams.y);
    fade = clamp((sceneDist - vDist) / max(uSoftFade, 1e-3), 0.0, 1.0);
  }
  fade *= smoothstep(0.0, max(uNearFade, 1e-3), vDist);

  float a = shape * vAlpha * fade;
  if (a <= 0.002) discard;

  gl_FragColor = vec4(col * a, a);
}
`;
