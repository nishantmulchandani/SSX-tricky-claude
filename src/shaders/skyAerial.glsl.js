/**
 * Aerial perspective — OWNER: agent "atmosphere". PUBLIC GLSL CHUNK.
 *
 * Drop `SKY_AERIAL_GLSL` into any fragment shader (above `main`) and merge
 * `sky.aerial.uniforms` into that material's uniforms. Then, as the very last
 * thing you do to a lit surface colour:
 *
 *     gl_FragColor.rgb = skyAerialPerspective(litColour, vWorldPosition);
 *
 * and, if you want cloud shadows on the snow:
 *
 *     directSunTerm *= skyCloudShadow(vWorldPosition);
 *
 * Everything is in world metres. See docs/REQUESTS-atmosphere.md.
 *
 * How it works: a two-species (Rayleigh + alpine aerosol) exponential-height
 * medium is integrated analytically along the view segment to get transmittance,
 * and the in-scattered colour is read straight out of the sky-view LUT for the
 * view direction. That guarantees the one property that sells mountain scale —
 * a ridge at 8 km and the sky immediately above it converge on exactly the same
 * colour, so the ridge dissolves instead of being pasted on.
 */

export const SKY_AERIAL_GLSL = /* glsl */ `
#ifndef SKY_AERIAL_INCLUDED
#define SKY_AERIAL_INCLUDED

uniform vec3  uAerialCameraPos;
uniform vec3  uAerialSunDir;      // points TOWARDS the sun
uniform vec3  uAerialBetaR;       // Rayleigh scattering, 1/m at reference height
uniform vec3  uAerialBetaMS;      // aerosol scattering, 1/m
uniform vec3  uAerialBetaMA;      // aerosol absorption, 1/m
uniform float uAerialHR;          // Rayleigh scale height, m
uniform float uAerialHM;          // aerosol scale height, m
uniform float uAerialRefY;        // altitude the coefficients are quoted at, m
uniform float uAerialStrength;
uniform float uAerialSunGlow;     // extra tight forward-scatter near the sun

uniform sampler2D uAerialSkyLut;  // sky-view LUT (same one the dome samples)
uniform float uAerialCamAltKm;    // camera altitude in km
uniform float uAerialExposure;    // LUT radiance -> render units

uniform sampler2D uAerialNoise;
uniform vec2  uAerialCloudWind;
uniform float uAerialCloudScale;      // cycles per metre
uniform float uAerialCloudCoverage;
uniform float uAerialCloudAltitude;   // m
uniform float uAerialCloudShadow;     // 0..1 strength

#define AERIAL_GROUND_R 6360.0

/** Sky radiance in a world direction, in render units. */
vec3 skyRadianceAt(vec3 rd) {
  float r = AERIAL_GROUND_R + max(uAerialCamAltKm, 0.002);
  vec3 sunFlat = normalize(vec3(uAerialSunDir.x, 0.0, uAerialSunDir.z) + vec3(1e-5, 0.0, 0.0));
  vec3 viewFlat = normalize(vec3(rd.x, 0.0, rd.z) + vec3(1e-5, 0.0, 0.0));
  float lightViewCos = dot(sunFlat, viewFlat);

  float cosBeta = sqrt(max(r * r - AERIAL_GROUND_R * AERIAL_GROUND_R, 0.0)) / r;
  float beta = acos(clamp(cosBeta, -1.0, 1.0));
  float zenithHorizon = 3.141592653589793 - beta;
  float viewZenith = acos(clamp(rd.y, -1.0, 1.0));

  float v;
  if (rd.y > -cosBeta) {
    float c = viewZenith / zenithHorizon;
    v = 0.5 * (1.0 - sqrt(max(1.0 - c, 0.0)));
  } else {
    float c = (viewZenith - zenithHorizon) / max(beta, 1e-5);
    v = 0.5 * (sqrt(max(c, 0.0)) + 1.0);
  }
  float u = sqrt(clamp(-lightViewCos * 0.5 + 0.5, 0.0, 1.0));

  u = (u + 0.5 / 256.0) * (256.0 / 257.0);
  v = (v + 0.5 / 144.0) * (144.0 / 145.0);
  return texture2D(uAerialSkyLut, vec2(u, v)).rgb * uAerialExposure;
}

float skyAerialHeightIntegral(float y0, float dy, float dist, float H) {
  float e0 = exp(-(y0 - uAerialRefY) / H);
  float ry = dy / max(dist, 1e-4);
  if (abs(ry) < 2e-4) return dist * e0;
  float e1 = exp(-(y0 + dy - uAerialRefY) / H);
  return (H / ry) * (e0 - e1);
}

/** Optical depth of the segment camera -> worldPos. */
vec3 skyAerialOpticalDepth(vec3 worldPos) {
  vec3 v = worldPos - uAerialCameraPos;
  float dist = length(v);
  float intR = skyAerialHeightIntegral(uAerialCameraPos.y, v.y, dist, uAerialHR);
  float intM = skyAerialHeightIntegral(uAerialCameraPos.y, v.y, dist, uAerialHM);
  return (uAerialBetaR * intR + (uAerialBetaMS + uAerialBetaMA) * intM) * uAerialStrength;
}

/** Transmittance only — for fading particles and additive effects. */
vec3 skyAerialTransmittance(vec3 worldPos) {
  return exp(-skyAerialOpticalDepth(worldPos));
}

/** Fade `color` at `worldPos` into the atmosphere as seen from the camera. */
vec3 skyAerialPerspective(vec3 color, vec3 worldPos) {
  vec3 v = worldPos - uAerialCameraPos;
  float dist = length(v);
  if (dist < 2.0) return color;
  vec3 rd = v / dist;

  vec3 T = exp(-skyAerialOpticalDepth(worldPos));
  vec3 inscatter = skyRadianceAt(rd) * (1.0 - T);

  // The LUT is far too coarse in solid angle to carry the Mie forward peak, so
  // haze looking into the sun gets an analytic top-up. This is the glare that
  // makes backlit ridges read as air rather than as flat grey.
  float c = dot(rd, uAerialSunDir);
  float theta = acos(clamp(c, -1.0, 1.0));
  float glow = exp(-theta * 6.0) * 0.8 + exp(-theta * 1.8) * 0.2;
  inscatter += skyRadianceAt(uAerialSunDir) * glow * uAerialSunGlow * (1.0 - T);

  return color * T + inscatter;
}

/**
 * Sun visibility under the cumulus deck, 0..1. Cheap: projects the point up the
 * sun ray to cloud height and samples the same tiling noise the dome uses.
 */
float skyCloudShadow(vec3 worldPos) {
  if (uAerialCloudShadow <= 0.0) return 1.0;
  float t = (uAerialCloudAltitude - worldPos.y) / max(uAerialSunDir.y, 0.15);
  vec2 q = (worldPos.xz + uAerialSunDir.xz * t) * uAerialCloudScale + uAerialCloudWind;
  vec4 n = texture2D(uAerialNoise, q);
  float d = n.r * 0.5 + n.g * 0.26 + n.b * 0.15 + n.a * 0.09;
  float cov = smoothstep(uAerialCloudCoverage - 0.01, uAerialCloudCoverage + 0.12, d);
  return 1.0 - cov * uAerialCloudShadow;
}

#endif
`;
