/**
 * Shared physical atmosphere model — OWNER: agent "atmosphere".
 *
 * A single-scattering + multiple-scattering participating medium in the style of
 * Hillaire 2020 ("A Scalable and Production Ready Sky and Atmosphere Rendering
 * Technique"). Everything the sky, the aerial perspective and the light rig do
 * is derived from these same constants, which is what keeps the distant peaks,
 * the sky behind them and the colour of the sun physically consistent.
 *
 * Units inside this model are KILOMETRES and the planet is centred at the
 * origin, so a point at world altitude `y` metres is `vec3(0, Rg + y*0.001, 0)`.
 *
 * Radiance is expressed with the top-of-atmosphere solar irradiance normalised
 * to 1.0. A single scalar exposure (`uSkyExposure`, applied at the very end)
 * converts to render units, so sky / sun / snow can never drift out of balance.
 */

export const ATMOSPHERE = {
  groundRadius: 6360.0,          // km
  topRadius: 6460.0,             // km
  rayleighScattering: [5.802e-3, 13.558e-3, 33.1e-3], // 1/km
  rayleighScaleHeight: 8.0,      // km
  mieScattering: 3.996e-3,       // 1/km
  mieAbsorption: 4.4e-3,         // 1/km
  mieScaleHeight: 1.2,           // km
  ozoneAbsorption: [0.650e-3, 1.881e-3, 0.085e-3], // 1/km
  ozoneCenter: 25.0,
  ozoneWidth: 15.0,
};

export const TRANSMITTANCE_RES = [256, 64];
export const MULTISCATTER_RES = [32, 32];
export const SKYVIEW_RES = [256, 144];

/**
 * Core medium + phase + LUT parameterisation. Included by every atmosphere
 * shader. Declares the uniforms it needs; callers must bind all of them.
 */
export const ATMOSPHERE_GLSL = /* glsl */ `
#define ATM_PI 3.141592653589793
#define ATM_GROUND_R 6360.0
#define ATM_TOP_R 6460.0
#define ATM_RAYLEIGH_H 8.0
#define ATM_MIE_H 1.2

const vec3  ATM_RAYLEIGH_S = vec3(5.802, 13.558, 33.100) * 1e-3;
const float ATM_MIE_S      = 3.996e-3;
const float ATM_MIE_A      = 4.400e-3;
const vec3  ATM_OZONE_A    = vec3(0.650, 1.881, 0.085) * 1e-3;

uniform sampler2D uTransmittanceLut;
uniform sampler2D uMultiScatterLut;
uniform float uHaze;      // aerosol load multiplier (1 = pristine, 4 = alpine haze)
uniform float uMieG;      // Cornette-Shanks asymmetry
uniform float uGroundAlbedo;

// --- helpers ---------------------------------------------------------------

float atmFromUnitToSubUv(float u, float res) { return (u + 0.5 / res) * (res / (res + 1.0)); }
float atmFromSubUvToUnit(float u, float res) { return (u - 0.5 / res) * (res / (res - 1.0)); }

/** Nearest positive intersection of a ray with a sphere centred on the origin. */
float atmRaySphere(vec3 ro, vec3 rd, float rad) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - rad * rad;
  if (c > 0.0 && b > 0.0) return -1.0;
  float disc = b * b - c;
  if (disc < 0.0) return -1.0;
  if (disc > b * b) return -b + sqrt(disc);
  return -b - sqrt(disc);
}

float atmRayleighPhase(float c) {
  return 3.0 / (16.0 * ATM_PI) * (1.0 + c * c);
}

/** Cornette-Shanks — a much better forward lobe than Henyey-Greenstein alone. */
float atmMiePhase(float c, float g) {
  float g2 = g * g;
  float k = 3.0 / (8.0 * ATM_PI) * (1.0 - g2) / (2.0 + g2);
  float d = 1.0 + g2 - 2.0 * g * c;
  return k * (1.0 + c * c) / (d * sqrt(max(d, 1e-4)));
}

/** Scattering / extinction coefficients at altitude h (km above the ground). */
void atmMedium(float h, out vec3 scatterR, out float scatterM, out vec3 extinction) {
  float dR = exp(-max(h, 0.0) / ATM_RAYLEIGH_H);
  float dM = exp(-max(h, 0.0) / ATM_MIE_H);
  float dO = max(0.0, 1.0 - abs(h - 25.0) / 15.0);
  scatterR = ATM_RAYLEIGH_S * dR;
  scatterM = ATM_MIE_S * uHaze * dM;
  extinction = scatterR + vec3(scatterM + ATM_MIE_A * uHaze * dM) + ATM_OZONE_A * dO;
}

// --- transmittance LUT parameterisation (Bruneton) --------------------------

vec2 atmTransmittanceUv(float r, float mu) {
  float H = sqrt(max(ATM_TOP_R * ATM_TOP_R - ATM_GROUND_R * ATM_GROUND_R, 0.0));
  float rho = sqrt(max(r * r - ATM_GROUND_R * ATM_GROUND_R, 0.0));
  float disc = r * r * (mu * mu - 1.0) + ATM_TOP_R * ATM_TOP_R;
  float d = max(0.0, -r * mu + sqrt(max(disc, 0.0)));
  float dMin = ATM_TOP_R - r;
  float dMax = rho + H;
  return vec2((d - dMin) / max(dMax - dMin, 1e-6), rho / H);
}

void atmUvToTransmittance(vec2 uv, out float r, out float mu) {
  float H = sqrt(ATM_TOP_R * ATM_TOP_R - ATM_GROUND_R * ATM_GROUND_R);
  float rho = H * uv.y;
  r = sqrt(rho * rho + ATM_GROUND_R * ATM_GROUND_R);
  float dMin = ATM_TOP_R - r;
  float dMax = rho + H;
  float d = dMin + uv.x * (dMax - dMin);
  mu = d == 0.0 ? 1.0 : (H * H - rho * rho - d * d) / (2.0 * r * d);
  mu = clamp(mu, -1.0, 1.0);
}

vec3 atmTransmittance(float r, float mu) {
  vec2 uv = atmTransmittanceUv(clamp(r, ATM_GROUND_R, ATM_TOP_R), mu);
  return texture2D(uTransmittanceLut, uv).rgb;
}

// --- multiple scattering LUT ------------------------------------------------

vec3 atmMultiScatter(float r, float muSun) {
  vec2 uv = clamp(vec2(muSun * 0.5 + 0.5, (r - ATM_GROUND_R) / (ATM_TOP_R - ATM_GROUND_R)), 0.0, 1.0);
  uv = vec2(atmFromUnitToSubUv(uv.x, 32.0), atmFromUnitToSubUv(uv.y, 32.0));
  return texture2D(uMultiScatterLut, uv).rgb;
}

// --- sky-view LUT parameterisation (Hillaire) -------------------------------

vec2 atmSkyViewUv(bool hitsGround, float viewZenithCos, float lightViewCos, float r) {
  float vHorizon = sqrt(max(r * r - ATM_GROUND_R * ATM_GROUND_R, 0.0));
  float cosBeta = vHorizon / r;
  float beta = acos(clamp(cosBeta, -1.0, 1.0));
  float zenithHorizon = ATM_PI - beta;
  float viewZenith = acos(clamp(viewZenithCos, -1.0, 1.0));

  float v;
  if (!hitsGround) {
    float coord = viewZenith / zenithHorizon;
    v = 0.5 * (1.0 - sqrt(max(1.0 - coord, 0.0)));
  } else {
    float coord = (viewZenith - zenithHorizon) / max(beta, 1e-5);
    v = 0.5 * (sqrt(max(coord, 0.0)) + 1.0);
  }
  float u = sqrt(clamp(-lightViewCos * 0.5 + 0.5, 0.0, 1.0));
  return vec2(u, v);
}

void atmUvToSkyView(vec2 uv, float r, out float viewZenithCos, out float lightViewCos) {
  float vHorizon = sqrt(max(r * r - ATM_GROUND_R * ATM_GROUND_R, 0.0));
  float cosBeta = vHorizon / r;
  float beta = acos(clamp(cosBeta, -1.0, 1.0));
  float zenithHorizon = ATM_PI - beta;

  if (uv.y < 0.5) {
    float c = 1.0 - 2.0 * uv.y;
    viewZenithCos = cos(zenithHorizon * (1.0 - c * c));
  } else {
    float c = uv.y * 2.0 - 1.0;
    viewZenithCos = cos(zenithHorizon + beta * c * c);
  }
  float c = uv.x * uv.x;
  lightViewCos = -(c * 2.0 - 1.0);
}
`;

/**
 * The scattering integrator. Marches the view ray, gathering single scattering
 * (sun transmittance * phase) plus the isotropic multiple-scattering estimate,
 * and folds in the lit ground when the ray hits the planet — which is what
 * gives the horizon its correct, slightly warm lift instead of going black.
 *
 * Requires ATMOSPHERE_GLSL to be included first.
 */
export const ATMOSPHERE_INTEGRATOR_GLSL = /* glsl */ `
#define ATM_MAX_STEPS 40

void atmIntegrate(
  vec3 origin, vec3 rd, vec3 sunDir,
  float stepCount, bool useMultiScatter, bool applyPhase,
  out vec3 luminance, out vec3 multiScatAs1
) {
  luminance = vec3(0.0);
  multiScatAs1 = vec3(0.0);

  float tBottom = atmRaySphere(origin, rd, ATM_GROUND_R);
  float tTop = atmRaySphere(origin, rd, ATM_TOP_R);
  float tMax;
  if (tBottom < 0.0) {
    if (tTop < 0.0) return;      // outside the atmosphere looking away
    tMax = tTop;
  } else {
    tMax = tTop > 0.0 ? min(tTop, tBottom) : tBottom;
  }
  tMax = min(tMax, 400.0);
  if (tMax <= 0.0) return;

  float cosTheta = dot(rd, sunDir);
  float phaseR = applyPhase ? atmRayleighPhase(cosTheta) : 1.0 / (4.0 * ATM_PI);
  float phaseM = applyPhase ? atmMiePhase(cosTheta, uMieG) : 1.0 / (4.0 * ATM_PI);

  vec3 throughput = vec3(1.0);
  float t = 0.0;

  for (int i = 0; i < ATM_MAX_STEPS; i++) {
    if (float(i) >= stepCount) break;
    // Quadratic step distribution: dense near the camera where the medium is
    // thickest, sparse out in the thin upper atmosphere.
    float t0 = float(i) / stepCount;
    float t1 = (float(i) + 1.0) / stepCount;
    t0 = t0 * t0; t1 = t1 * t1;
    t0 *= tMax; t1 = t1 > 1.0 ? tMax : t1 * tMax;
    float dt = t1 - t0;
    t = t0 + dt * 0.3;

    vec3 p = origin + t * rd;
    float pr = length(p);
    float h = pr - ATM_GROUND_R;

    vec3 sR; float sM; vec3 ext;
    atmMedium(h, sR, sM, ext);
    vec3 sampleT = exp(-ext * dt);

    float muSun = dot(p / pr, sunDir);
    vec3 sunT = atmTransmittance(pr, muSun);
    float shadow = atmRaySphere(p, sunDir, ATM_GROUND_R) >= 0.0 ? 0.0 : 1.0;

    vec3 scatter = sR + vec3(sM);
    vec3 phased = sR * phaseR + vec3(sM * phaseM);
    vec3 ms = useMultiScatter ? atmMultiScatter(pr, muSun) : vec3(0.0);

    vec3 S = shadow * sunT * phased + ms * scatter;
    vec3 safeExt = max(ext, vec3(1e-7));

    // Analytic integration of the constant-source segment (energy conserving).
    luminance += throughput * (S - S * sampleT) / safeExt;
    multiScatAs1 += throughput * (scatter - scatter * sampleT) / safeExt;
    throughput *= sampleT;
  }

  // Light bounced off the ground — the horizon lift.
  if (tBottom > 0.0 && tMax == tBottom) {
    vec3 p = origin + tBottom * rd;
    float pr = length(p);
    vec3 up = p / pr;
    float nDotL = clamp(dot(up, sunDir), 0.0, 1.0);
    luminance += throughput * atmTransmittance(pr, nDotL) * nDotL * uGroundAlbedo / ATM_PI;
  }
}
`;
