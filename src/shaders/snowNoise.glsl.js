/**
 * GLSL mirror of src/core/noise.js.
 *
 * OWNER: agent "snow-shading".
 *
 * Same integer hash, same quintic fade, same "gradient = unit vector at angle
 * hash*2pi" construction, same fbm/ridged octave schedule (lacunarity 2.02 /
 * gain 0.5 and 2.07 / 0.5 respectively). So the shader and the CPU height
 * field agree about where features are.
 *
 * Known, deliberate deviations from the JS — see docs/REQUESTS-snow.md:
 *  - the JS `h * 1274126177` step overflows the float64 mantissa (products
 *    reach 2^62), so its low bits are the result of double rounding. GLSL does
 *    an exact wrapping 32-bit multiply. Bit-identical emulation would cost a
 *    software 64x64 multiply per hash, which is not affordable per fragment.
 *    The distribution and the feature scale are identical; only the specific
 *    pseudo-random draw differs.
 *  - the shader adds analytic-derivative variants (snNoiseD / snFbmD). Those
 *    return the exact gradient of the same field, which is what makes
 *    multi-band detail normals cheap: one evaluation per band instead of
 *    three finite differences.
 */
export const snowNoiseGLSL = /* glsl */`

// ---------------------------------------------------------------- hashing
float snHashI(ivec2 i) {
  int h = i.x * 374761393 + i.y * 668265263;
  h = (h ^ (h >> 13)) * 1274126177;
  h = h ^ (h >> 16);
  return float(uint(h)) * 2.3283064365386963e-10; // 1 / 2^32
}

float snHash(vec2 p) { return snHashI(ivec2(floor(p))); }

// Three decorrelated draws from one cell. Used by the sparkle field.
vec3 snHash3(ivec2 i) {
  return vec3(
    snHashI(i),
    snHashI(i + ivec2(1731, 977)),
    snHashI(i + ivec2(-419, 6151))
  );
}

vec2 snGrad(ivec2 i) {
  float a = snHashI(i) * 6.283185307179586;
  return vec2(cos(a), sin(a));
}

// ------------------------------------------------------- gradient noise
// Value in roughly [-1, 1]; .yz is the exact analytic gradient d/dp.
vec3 snNoiseD(vec2 p) {
  vec2 fl = floor(p);
  ivec2 i = ivec2(fl);
  vec2 f = p - fl;

  vec2 u  = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);

  vec2 ga = snGrad(i);
  vec2 gb = snGrad(i + ivec2(1, 0));
  vec2 gc = snGrad(i + ivec2(0, 1));
  vec2 gd = snGrad(i + ivec2(1, 1));

  float va = dot(ga, f);
  float vb = dot(gb, f - vec2(1.0, 0.0));
  float vc = dot(gc, f - vec2(0.0, 1.0));
  float vd = dot(gd, f - vec2(1.0, 1.0));

  float k1 = vb - va;
  float k2 = vc - va;
  float k3 = va - vb - vc + vd;

  float v = va + k1 * u.x + k2 * u.y + k3 * u.x * u.y;
  vec2 d = ga + u.x * (gb - ga) + u.y * (gc - ga) + u.x * u.y * (ga - gb - gc + gd)
         + du * vec2(k1 + k3 * u.y, k2 + k3 * u.x);

  return vec3(v, d);
}

float snNoise(vec2 p) { return snNoiseD(p).x; }

// ------------------------------------------------------------------ fbm
// Matches fbm2(x, y, octaves, 2.02, 0.5). .yz carries the summed gradient.
vec3 snFbmD2(vec2 p) {
  vec3 s = vec3(0.0); float a = 0.5, fq = 1.0, n = 0.0;
  for (int i = 0; i < 2; i++) {
    vec3 v = snNoiseD(p * fq);
    s += vec3(a * v.x, a * fq * v.y, a * fq * v.z);
    n += a; fq *= 2.02; a *= 0.5;
  }
  return s / n;
}

vec3 snFbmD3(vec2 p) {
  vec3 s = vec3(0.0); float a = 0.5, fq = 1.0, n = 0.0;
  for (int i = 0; i < 3; i++) {
    vec3 v = snNoiseD(p * fq);
    s += vec3(a * v.x, a * fq * v.y, a * fq * v.z);
    n += a; fq *= 2.02; a *= 0.5;
  }
  return s / n;
}

vec3 snFbmD4(vec2 p) {
  vec3 s = vec3(0.0); float a = 0.5, fq = 1.0, n = 0.0;
  for (int i = 0; i < 4; i++) {
    vec3 v = snNoiseD(p * fq);
    s += vec3(a * v.x, a * fq * v.y, a * fq * v.z);
    n += a; fq *= 2.02; a *= 0.5;
  }
  return s / n;
}

// Ridged multifractal, matching ridged2(x, y, octaves, 2.07, 0.5).
float snRidged3(vec2 p) {
  float a = 0.5, fq = 1.0, s = 0.0, n = 0.0, prev = 1.0;
  for (int i = 0; i < 3; i++) {
    float m = 1.0 - abs(snNoise(p * fq));
    float r = m * m * prev;
    prev = r;
    s += a * r; n += a;
    fq *= 2.07; a *= 0.5;
  }
  return s / n;
}
`;
