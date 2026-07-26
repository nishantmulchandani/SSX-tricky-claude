/**
 * Sky shaders — OWNER: agent "atmosphere".
 *
 * Three offline LUT passes (transmittance, multiple scattering, sky-view) and
 * one full-rate dome shader that samples the sky-view LUT and adds the things
 * a 256x144 LUT cannot represent: the sun disc with limb darkening, the tight
 * forward-scattering aureole, and two parallaxed procedural cloud decks.
 */

import { ATMOSPHERE_GLSL, ATMOSPHERE_INTEGRATOR_GLSL } from './skyAtmosphere.glsl.js';

export const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Pass 1 — transmittance through the whole atmosphere. 256x64, built once.
// ---------------------------------------------------------------------------
export const TRANSMITTANCE_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
${ATMOSPHERE_GLSL}

void main() {
  float r, mu;
  atmUvToTransmittance(vUv, r, mu);

  vec3 origin = vec3(0.0, r, 0.0);
  vec3 rd = vec3(sqrt(max(1.0 - mu * mu, 0.0)), mu, 0.0);

  float tTop = atmRaySphere(origin, rd, ATM_TOP_R);
  float tGround = atmRaySphere(origin, rd, ATM_GROUND_R);
  float tMax = tGround > 0.0 ? tGround : tTop;
  if (tMax <= 0.0) { gl_FragColor = vec4(1.0); return; }

  const int STEPS = 40;
  vec3 tau = vec3(0.0);
  for (int i = 0; i < STEPS; i++) {
    float t = (float(i) + 0.5) / float(STEPS) * tMax;
    float h = length(origin + rd * t) - ATM_GROUND_R;
    vec3 sR; float sM; vec3 ext;
    atmMedium(h, sR, sM, ext);
    tau += ext * (tMax / float(STEPS));
  }
  gl_FragColor = vec4(exp(-tau), 1.0);
}
`;

// ---------------------------------------------------------------------------
// Pass 2 — isotropic multiple scattering. 32x32, rebuilt when the sun moves.
// Without this the sky is far too dark near the horizon and shadowed snow goes
// dead blue instead of picking up the whole-sky bounce.
// ---------------------------------------------------------------------------
export const MULTISCATTER_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
${ATMOSPHERE_GLSL}
${ATMOSPHERE_INTEGRATOR_GLSL}

#define MS_DIRS 6

void main() {
  vec2 uv = vec2(atmFromSubUvToUnit(vUv.x, 32.0), atmFromSubUvToUnit(vUv.y, 32.0));
  float muSun = uv.x * 2.0 - 1.0;
  float r = mix(ATM_GROUND_R + 0.001, ATM_TOP_R, uv.y);

  vec3 sunDir = normalize(vec3(0.0, muSun, sqrt(clamp(1.0 - muSun * muSun, 0.0, 1.0))));
  vec3 origin = vec3(0.0, r, 0.0);

  vec3 lumAccum = vec3(0.0);
  vec3 fmsAccum = vec3(0.0);

  // Uniformly-ish distributed directions over the sphere.
  for (int i = 0; i < MS_DIRS; i++) {
    for (int j = 0; j < MS_DIRS; j++) {
      float a = (float(i) + 0.5) / float(MS_DIRS);
      float b = (float(j) + 0.5) / float(MS_DIRS);
      float theta = 2.0 * ATM_PI * a;
      float phi = acos(1.0 - 2.0 * b);
      vec3 rd = vec3(cos(theta) * sin(phi), cos(phi), sin(theta) * sin(phi));

      vec3 L, ms;
      atmIntegrate(origin, rd, sunDir, 18.0, false, false, L, ms);
      lumAccum += L;
      fmsAccum += ms;
    }
  }

  float inv = 1.0 / float(MS_DIRS * MS_DIRS);
  vec3 L2 = lumAccum * inv;
  vec3 fms = fmsAccum * inv;
  // Geometric series over infinite scattering orders.
  gl_FragColor = vec4(L2 / max(1.0 - fms, vec3(1e-4)), 1.0);
}
`;

// ---------------------------------------------------------------------------
// Pass 3 — sky-view LUT. 256x144, rebuilt when the sun or the camera altitude
// changes meaningfully. This is the whole visible sky in one small texture.
// ---------------------------------------------------------------------------
export const SKYVIEW_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec3 uSunDir;
uniform float uCameraAltitude; // km above the ground sphere
${ATMOSPHERE_GLSL}
${ATMOSPHERE_INTEGRATOR_GLSL}

void main() {
  vec2 uv = vec2(atmFromSubUvToUnit(vUv.x, 256.0), atmFromSubUvToUnit(vUv.y, 144.0));
  float r = ATM_GROUND_R + max(uCameraAltitude, 0.002);
  vec3 origin = vec3(0.0, r, 0.0);

  float viewZenithCos, lightViewCos;
  atmUvToSkyView(uv, r, viewZenithCos, lightViewCos);

  // Rebuild a view direction in the frame where the sun sits at azimuth 0.
  float sinZenith = sqrt(clamp(1.0 - viewZenithCos * viewZenithCos, 0.0, 1.0));
  float sinLight = -sqrt(clamp(1.0 - lightViewCos * lightViewCos, 0.0, 1.0));
  vec3 rd = vec3(sinZenith * sinLight, viewZenithCos, sinZenith * lightViewCos);

  float sunZenithCos = uSunDir.y;
  vec3 sunLocal = vec3(0.0, sunZenithCos, sqrt(clamp(1.0 - sunZenithCos * sunZenithCos, 0.0, 1.0)));

  vec3 L, ms;
  atmIntegrate(origin, rd, sunLocal, 32.0, true, true, L, ms);
  gl_FragColor = vec4(L, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Sky dome
// ---------------------------------------------------------------------------
export const SKYDOME_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const SKYDOME_FRAG = /* glsl */ `
precision highp float;
varying vec3 vDir;

uniform sampler2D uSkyViewLut;
uniform sampler2D uCloudNoise;
uniform vec3  uSunDir;
uniform float uCameraAltitude;
uniform float uSkyExposure;
uniform float uSunDiscIntensity;
uniform float uSunGlow;
uniform float uSunAngularRadius;

uniform float uCloudAmount;        // 0 disables the deck entirely
uniform float uCloudCoverage;
uniform float uCloudAltitude;      // km
uniform float uCloudScale;         // noise cycles per km
uniform vec2  uCloudWind;
uniform float uCloudDensity;
uniform float uCirrusAmount;
uniform float uCirrusCoverage;
uniform float uCirrusAltitude;
uniform float uCirrusScale;
uniform vec2  uCirrusWind;
uniform vec3  uGroundTint;

${ATMOSPHERE_GLSL}

vec3 sampleSkyView(vec3 rd, vec3 origin, float r) {
  float viewZenithCos = rd.y;
  vec3 sunFlat = normalize(vec3(uSunDir.x, 0.0, uSunDir.z) + vec3(1e-5, 0.0, 0.0));
  vec3 viewFlat = normalize(vec3(rd.x, 0.0, rd.z) + vec3(1e-5, 0.0, 0.0));
  float lightViewCos = dot(sunFlat, viewFlat);
  bool hitsGround = atmRaySphere(origin, rd, ATM_GROUND_R) >= 0.0;
  vec2 uv = atmSkyViewUv(hitsGround, viewZenithCos, lightViewCos, r);
  uv = vec2(atmFromUnitToSubUv(uv.x, 256.0), atmFromUnitToSubUv(uv.y, 144.0));
  return texture2D(uSkyViewLut, uv).rgb;
}

// --- procedural cloud noise -------------------------------------------------
// One tileable RGBA fetch carries four octaves, so a full cloud sample costs a
// handful of texture reads. Mipmaps do the far-field filtering for us.
float cn(vec2 p) {
  vec4 n = texture2D(uCloudNoise, p);
  return n.r * 0.5 + n.g * 0.26 + n.b * 0.15 + n.a * 0.09;
}

float cumulusThickness(vec2 q, float cov) {
  vec2 w = vec2(cn(q * 0.27), cn(q * 0.27 + vec2(0.41, 0.13))) - 0.5;
  float base = cn(q + w * 0.55);
  float detail = cn(q * 3.1 + w * 1.3);
  float d = base * 0.74 + detail * 0.26;
  return max(0.0, d - cov);
}

float cirrusThickness(vec2 q, float cov) {
  vec2 w = vec2(cn(q * 0.11), cn(q * 0.11 + vec2(0.73, 0.29))) - 0.5;
  float d = cn(vec2(q.x * 0.30, q.y * 1.7) + w * 0.85);
  float d2 = cn(vec2(q.x * 1.10, q.y * 5.2) + w * 1.6);
  d = d * 0.66 + d2 * 0.34;
  return max(0.0, d - cov);
}

void main() {
  vec3 rd = normalize(vDir);
  float r = ATM_GROUND_R + max(uCameraAltitude, 0.002);
  vec3 origin = vec3(0.0, r, 0.0);

  vec3 sky = sampleSkyView(rd, origin, r);

  float cosTheta = dot(rd, uSunDir);
  float theta = acos(clamp(cosTheta, -1.0, 1.0));
  vec3 sunT = atmTransmittance(r, uSunDir.y);

  // --- clouds --------------------------------------------------------------
  vec3 horizonCol = sampleSkyView(normalize(vec3(rd.x, 0.02, rd.z)), origin, r);
  vec3 cloudRGB = vec3(0.0);
  float cloudA = 0.0;

  if (rd.y > 0.002) {
    // Sun colour arriving at cloud height, plus the ambient sky the cloud sees.
    vec3 cloudSun = sunT * 4.6;
    vec3 cloudSky = sky * 1.4 + horizonCol * 0.5;

    if (uCirrusAmount > 0.0) {
      float t = atmRaySphere(origin, rd, ATM_GROUND_R + uCirrusAltitude);
      if (t > 0.0) {
        vec3 p = origin + rd * t;
        vec2 q = p.xz * uCirrusScale + uCirrusWind;
        float th = cirrusThickness(q, uCirrusCoverage);
        float a = clamp(th * 5.0, 0.0, 1.0) * uCirrusAmount;
        // Ice crystals scatter forward hard — cirrus near the sun goes brilliant.
        float fwd = pow(clamp(cosTheta, 0.0, 1.0), 8.0);
        vec3 c = cloudSun * (0.85 + fwd * 1.9) + cloudSky * 0.55;
        float fade = exp(-t * 0.0055);
        c = mix(horizonCol, c, fade);
        cloudRGB = c; cloudA = a * mix(0.25, 1.0, fade);
      }
    }

    if (uCloudAmount > 0.0) {
      float t = atmRaySphere(origin, rd, ATM_GROUND_R + uCloudAltitude);
      if (t > 0.0) {
        vec3 p = origin + rd * t;
        vec2 q = p.xz * uCloudScale + uCloudWind;
        float th = cumulusThickness(q, uCloudCoverage);
        float a = clamp(th * 9.0, 0.0, 1.0) * uCloudAmount;

        if (a > 0.001) {
          // Cheap self-shadowing: march one step toward the sun inside the deck.
          vec2 sunStep = normalize(uSunDir.xz + vec2(1e-4, 0.0)) * (uCloudScale * 0.6 / max(uSunDir.y, 0.22));
          float thS = cumulusThickness(q + sunStep, uCloudCoverage);
          float thS2 = cumulusThickness(q + sunStep * 2.2, uCloudCoverage);
          float shade = exp(-uCloudDensity * (thS * 0.75 + thS2 * 0.45));

          // Powder / dark-edge term keeps thin fringes from looking like fog.
          float powder = 1.0 - exp(-th * 26.0);
          float fwd = pow(clamp(cosTheta, 0.0, 1.0), 5.0);

          vec3 lit = cloudSun * (shade * (0.55 + 0.75 * powder) + fwd * shade * 1.6);
          vec3 amb = cloudSky * (0.34 + 0.30 * (1.0 - powder));
          vec3 c = lit + amb;

          float fade = exp(-t * 0.011);
          c = mix(horizonCol, c, fade);
          cloudRGB = mix(cloudRGB, c, a);
          cloudA = cloudA + a - cloudA * a;
        }
      }
    }
  }

  vec3 col = mix(sky, cloudRGB, cloudA);

  // --- sun disc + aureole ---------------------------------------------------
  // The aureole is analytic because the sky-view LUT is far too coarse in solid
  // angle to hold the Mie forward peak. Occluded by the cloud deck.
  float clear = 1.0 - cloudA;
  vec3 glow = sunT * uSunGlow * (exp(-theta * 24.0) * 0.85 + exp(-theta * 5.5) * 0.13 + exp(-theta * 1.6) * 0.02);
  col += glow * clear;

  if (uSunDiscIntensity > 0.0 && theta < uSunAngularRadius * 4.0) {
    float centreToEdge = clamp(theta / uSunAngularRadius, 0.0, 1.0);
    float mu = sqrt(max(1.0 - centreToEdge * centreToEdge, 0.0));
    // Hestroffer & Magnan limb darkening — the rim is measurably redder.
    vec3 limb = vec3(1.0) - vec3(0.397, 0.503, 0.652) * (1.0 - pow(vec3(mu), vec3(0.34, 0.30, 0.26)));
    float edge = 1.0 - smoothstep(uSunAngularRadius * 0.985, uSunAngularRadius * 1.015, theta);
    col += sunT * limb * uSunDiscIntensity * edge * clear;
  }

  // --- below the true horizon ----------------------------------------------
  // The terrain ring ends before the geometric horizon; blend to a hazy snow
  // field so nothing ever shows a hard edge into the void.
  float below = smoothstep(0.0, -0.055, rd.y);
  if (below > 0.0) {
    vec3 groundHaze = horizonCol * uGroundTint;
    col = mix(col, groundHaze, below * 0.85);
  }

  gl_FragColor = vec4(col * uSkyExposure, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
