import { snowNoiseGLSL } from './snowNoise.glsl.js';

/**
 * GLSL for the snow surface. OWNER: agent "snow-shading".
 *
 * These strings are spliced into three's MeshPhysicalMaterial program by
 * src/world/snowMaterial.js, so the material keeps three's lighting, shadow,
 * IBL, fog and tone-mapping plumbing and only *adds* the snow physics on top:
 *
 *   pars      -> uniforms, noise, sparkle helper
 *   reDirect  -> wraps RE_Direct so we can recover per-pixel sun visibility
 *   surface   -> albedo / roughness / multi-band detail normals (after
 *                <normal_fragment_maps>, before the BRDF is assembled)
 *   sheen     -> per-pixel sheen (after <lights_physical_fragment>)
 *   lighting  -> subsurface, sky-lit shadows, sparkle (after <aomap_fragment>)
 *
 * Why MeshPhysicalMaterial and not MeshStandardMaterial: snow's grazing-angle
 * brightening is a genuinely broad, retro-reflective lobe that GGX cannot
 * produce at any roughness. three's `sheen` (Estevez-Kulla "Charlie" sheen) is
 * exactly that lobe, it is fed by both the sun and the environment map, and it
 * costs nothing to author. Snow's index of refraction is ~1.31, not the 1.5
 * default, so F0 is 0.018 rather than 0.04 — set through `material.ior`.
 */

// --------------------------------------------------------------- vertex ---
export const snowVertexPars = /* glsl */`
varying vec3 vSnowWPos;
varying vec3 vSnowWNrm;
`;

export const snowVertexMain = /* glsl */`
  vSnowWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
  vSnowWNrm = normalize( mat3( modelMatrix ) * objectNormal );
`;

// ------------------------------------------------------- fragment: pars ---
export const snowFragmentPars = /* glsl */`
varying vec3 vSnowWPos;
varying vec3 vSnowWNrm;

uniform float     uSnowTime;
uniform sampler2D uCourseLUT;
uniform float     uCourseLength;

uniform vec3  uSnowAlbedo;
uniform vec3  uIceAlbedo;
uniform vec3  uRockAlbedo;

uniform vec3  uShadowTint;
uniform vec3  uShadowGlow;
uniform vec3  uSSSColor;
uniform float uSSSStrength;
uniform float uWrap;
uniform float uForward;
uniform float uHotspot;

uniform float uDetail;
uniform vec2  uWind;

uniform float uSparkle;
uniform float uSparkleSharp;
uniform float uSparklePixels;
uniform float uSparkleFar;
uniform float uFacetSpread;
uniform float uCrystalDensity;

${snowNoiseGLSL}

/**
 * Course centre-line lookup. courseXAt/courseAt in terrain.js are an
 * arc-length-reparameterised Catmull-Rom; rather than re-deriving that spline
 * in GLSL (and risking drift from the CPU version) snowMaterial.js bakes it
 * into a 1D half-float texture by *calling* those functions. Exact by
 * construction, one fetch per fragment.
 *   .x = course centre X in metres, .y = half width in metres
 */
vec2 snCourse( float z ) {
  float t = clamp( -z / uCourseLength, 0.0, 1.0 );
  return texture2D( uCourseLUT, vec2( t, 0.5 ) ).xy;
}

/**
 * Nyquist gate for a detail band. \`freq\` is in cycles per metre, \`px\` is the
 * world-space size of one pixel. A band whose period falls below ~2.4 px is
 * removed entirely rather than allowed to alias into crawling static; its lost
 * variance is folded back into roughness by the caller.
 */
float snBandW( float freq, float px ) {
  return 1.0 - smoothstep( 0.16, 0.42, px * freq );
}

/**
 * One layer of the glitter field. Cells are locked to world space, each holds
 * one ice crystal with a random facet orientation, and only a small fraction
 * are "alive" so the result reads as scattered glints rather than noise.
 */
vec3 snSparkleLayer( vec2 c, vec3 N, vec3 H ) {
  vec2 fl = floor( c );
  vec3 r = snHash3( ivec2( fl ) );
  if ( r.z > uCrystalDensity ) return vec3( 0.0 );

  vec3 f = normalize( N + ( vec3( r.x, r.y, fract( r.x + r.y ) ) * 2.0 - 1.0 ) * uFacetSpread );
  float d = clamp( dot( f, H ), 0.0, 1.0 );
  float s = pow( d, uSparkleSharp );

  // round the cell off so glints are points of light, not little squares
  vec2 fc = c - fl - 0.5;
  s *= clamp( 1.0 - dot( fc, fc ) * 3.4, 0.0, 1.0 );

  // crystals split light — give each one a faint spectral cast
  vec3 tint = 0.70 + 0.45 * cos( 6.283185307 * ( r.x + vec3( 0.0, 0.33, 0.67 ) ) );
  return s * tint;
}
`;

// --------------------------------------------- fragment: RE_Direct hook ---
// three folds the shadow term straight into directLight.color, and the
// resulting variable never escapes the unrolled light loop. Wrapping RE_Direct
// lets us total the *received* direct radiance; comparing it against the sum of
// the directionalLights uniforms recovers a per-pixel sun visibility that works
// for a plain directional light and for a multi-cascade rig alike.
export const snowReDirect = /* glsl */`
vec3 snowDirectSum = vec3( 0.0 );

void RE_Direct_Snow( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
  snowDirectSum += directLight.color;
  RE_Direct_Physical( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
}

#undef RE_Direct
#define RE_Direct RE_Direct_Snow
`;

// ---------------------------------------------------- fragment: surface ---
export const snowSurface = /* glsl */`
  // =====================================================================
  //  SNOW SURFACE
  // =====================================================================
  vec3  snP    = vSnowWPos;
  vec3  snGN   = normalize( vSnowWNrm );
  float snDist = length( vViewPosition );

  // world metres spanned by one pixel — the filter width for every band below
  float snPx = max( max( fwidth( snP.x ), fwidth( snP.z ) ), 2e-4 );

  // ---- classification: piste / powder / wind-scoured ice / bare rock ----
  vec2  snCW  = snCourse( snP.z );
  float snLat = abs( snP.x - snCW.x ) / max( snCW.y, 1.0 );
  float snUp  = clamp( snGN.y, 0.02, 1.0 );          // cos(slope)

  vec3  snBigD = snFbmD3( snP.xz * 0.0035 );
  float snBig  = clamp( snBigD.x * 1.7 + 0.5, 0.0, 1.0 );
  float snMid  = snFbmD2( snP.xz * 0.035 ).x;

  // Snow cannot hold on a wall: past ~50 degrees the rock comes through, with
  // a noise-broken edge so the transition is a scree line and not a contour.
  float snRockT = 0.655 + ( snBig - 0.5 ) * 0.17 + snMid * 0.10;
  float snRock  = smoothstep( snRockT + 0.065, snRockT - 0.065, snUp );

  float snPiste = smoothstep( 1.20, 0.84, snLat ) * smoothstep( 0.80, 0.94, snUp );
  snRock *= 1.0 - snPiste;

  float snIce = smoothstep( 0.97, 0.76, snUp ) * smoothstep( 0.42, 0.74, snBig )
              * ( 1.0 - snRock ) * ( 1.0 - snPiste );

  float snSnow   = 1.0 - snRock;
  float snPowder = snSnow * ( 1.0 - snPiste ) * ( 1.0 - snIce );

  // ---- multi-scale detail normals --------------------------------------
  // Every band contributes d(height)/d(world xz). snFbmD returns the analytic
  // gradient of the same field it evaluates, so a band costs one evaluation
  // instead of three finite differences.
  vec2  snDH   = vec2( 0.0 );
  float snLost = 0.0;   // filtered-away slope variance -> specular AA

  // band 1: drift field, ~6 m
  {
    float f = 0.17, a = 0.42 * uDetail;
    float w = snBandW( f, snPx );
    vec3  n = snFbmD3( snP.xz * f );
    snDH   += n.yz * ( f * a * w * snSnow );
    snLost += ( 1.0 - w ) * ( a * f ) * ( a * f ) * snSnow;
  }

  // band 2: wind sastrugi, ~0.9 m across the wind and stretched ~6x along it
  {
    vec2 wd = normalize( uWind );
    mat2 R  = mat2( wd.x, -wd.y, wd.y, wd.x );          // world -> wind frame
    vec2 sc = vec2( 0.19, 1.15 );                       // cycles/m along, across
    float a = 0.085 * uDetail;
    float w = snBandW( sc.y, snPx ) * ( 0.30 + 0.70 * snPowder + 0.55 * snIce );
    vec3  n = snFbmD3( ( R * snP.xz ) * sc );
    snDH   += ( transpose( R ) * ( sc * n.yz ) ) * ( a * w );
    snLost += ( 1.0 - w ) * ( a * sc.y ) * ( a * sc.y ) * snSnow;
  }

  // band 3: granular micro relief, ~12 cm — only alive within a few metres
  {
    float f = 8.0, a = 0.0075 * uDetail;
    float w = snBandW( f, snPx );
    if ( w > 0.003 ) {
      vec3 n = snFbmD2( snP.xz * f );
      snDH += n.yz * ( f * a * w );
    }
    snLost += ( 1.0 - w ) * ( a * f ) * ( a * f ) * snSnow;
  }

  // band 4: groomer corduroy, 22 cm ribs running down the fall line.
  //
  // This band needs a much tighter Nyquist gate than the noise bands. A pure
  // periodic signal aliases into wide, coherent beat patterns — the slope ends
  // up looking like corrugated iron — whereas undersampled noise just turns to
  // harmless mush. Gating at 2.2x the nominal frequency retires the ribs at
  // roughly a quarter of their period instead of at the Nyquist limit.
  {
    float f = 4.55;
    float w = snBandW( f * 2.2, snPx ) * snPiste;
    if ( w > 0.003 ) {
      float ph = ( snP.x - snCW.x ) * 28.6 + snNoise( vec2( snP.z * 0.012, 3.7 ) ) * 2.2;
      // ~5 mm deep. Real corduroy is shallow; at 1.2 cm the ribs read as
      // ploughed furrows rather than a groomed piste.
      float a  = 0.005 * uDetail * ( 0.75 + 0.25 * snNoise( vec2( snP.z * 0.09, 11.0 ) ) );
      snDH.x  += cos( ph ) * 28.6 * a * w;
    }
  }

  // rock: blocky relief plus bedding planes. The strata band is indexed by
  // world height and projected onto the surface through dY/dXZ, which gives
  // correct horizontal banding on a cliff without paying for triplanar.
  if ( snRock > 0.004 ) {
    float w1 = snBandW( 0.28, snPx );
    vec3  r1 = snFbmD3( snP.xz * 0.28 );
    snDH += r1.yz * ( 0.28 * 0.9 * w1 * snRock );

    float w2 = snBandW( 0.55, snPx );
    vec3  r2 = snFbmD2( vec2( snP.y * 0.55, ( snP.x + snP.z ) * 0.06 ) );
    vec2  dY = clamp( -snGN.xz / snUp, vec2( -4.0 ), vec2( 4.0 ) );
    snDH += r2.y * ( 0.55 * 0.75 * w2 * snRock ) * dY;
  }

  vec3 snPert = vec3( -snDH.x, 0.0, -snDH.y );
  snPert -= snGN * dot( snPert, snGN );               // keep it tangential
  vec3 snWN = normalize( snGN + snPert );
  normal = normalize( ( viewMatrix * vec4( snWN, 0.0 ) ).xyz );

  // ---- albedo -----------------------------------------------------------
  // Snow albedo barely varies — nearly all of its structure is shading, so
  // these modulations stay within a few percent. Overdoing it reads as dirt.
  float snGrainN = snFbmD2( snP.xz * 1.4 ).x;
  vec3 snowCol = uSnowAlbedo * ( 1.0 + 0.05 * snMid + 0.035 * snGrainN - 0.06 * snBig );

  float snStrata = snNoise( vec2( snP.y * 0.35, ( snP.x - snP.z ) * 0.02 ) );
  float snRockV  = clamp( snFbmD3( snP.xz * 0.09 ).x * 0.9 + 0.4 * snStrata + 0.5, 0.0, 1.0 );
  vec3  rockCol  = uRockAlbedo * ( 0.55 + 0.95 * snRockV );

  vec3 snAlbedo = mix( snowCol, uIceAlbedo, snIce * 0.8 );
  snAlbedo = mix( snAlbedo, rockCol, snRock );
  diffuseColor.rgb *= snAlbedo;

  // ---- roughness --------------------------------------------------------
  float snRough = 0.60 + 0.10 * snGrainN;             // untracked powder
  snRough = mix( snRough, 0.42, snPiste );            // tilled corduroy
  snRough = mix( snRough, 0.13 + 0.07 * snMid, snIce ); // wind-polished slab
  snRough = mix( snRough, 0.93, snRock );
  // fold the normal detail we filtered away back in, so distant slopes lose
  // their glints instead of boiling
  roughnessFactor = clamp( sqrt( snRough * snRough + snLost * 0.5 ), 0.04, 1.0 );
  metalnessFactor = 0.0;
`;

// ------------------------------------------------------ fragment: sheen ---
export const snowSheen = /* glsl */`
  #ifdef USE_SHEEN
    material.sheenColor *= snSnow * ( 1.0 - 0.55 * snIce );
    material.sheenRoughness = clamp( mix( 0.26, 0.50, snPowder ), 0.07, 1.0 );
  #endif
`;

// --------------------------------------------------- fragment: lighting ---
export const snowLighting = /* glsl */`
  // =====================================================================
  //  SNOW LIGHT TRANSPORT: subsurface, sky-lit shadow, sparkle
  // =====================================================================
  const vec3 SN_LUM = vec3( 0.2126, 0.7152, 0.0722 );

  vec3 snSunTotal = vec3( 0.0 );
  vec3 snL = normalize( ( viewMatrix * vec4( 0.35, 0.80, 0.45, 0.0 ) ).xyz );
  #if NUM_DIR_LIGHTS > 0
    snL = directionalLights[ 0 ].direction;           // view space, towards sun
    for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) snSunTotal += directionalLights[ i ].color;
  #endif

  float snSunLum = dot( snSunTotal, SN_LUM );
  float snShadow = snSunLum > 1e-4
    ? clamp( dot( snowDirectSum, SN_LUM ) / snSunLum, 0.0, 1.0 )
    : 1.0;

  vec3  snN   = normal;
  vec3  snVv  = geometryViewDir;
  float snNdL = dot( snN, snL );
  float snNdV = clamp( dot( snN, snVv ), 0.0, 1.0 );

  // Anything turned away from the sun is sky-lit whether or not a shadow map
  // reaches it, so form the shade mask from both. This is what makes the
  // mountain's shaded flanks read blue rather than grey.
  float snShade = max( 1.0 - snShadow, 1.0 - smoothstep( -0.06, 0.30, snNdL ) );

  // (a) shadowed snow is lit by a blue sky. Multiplicative, so it stays right
  //     whatever the atmosphere module puts in scene.environment.
  reflectedLight.indirectDiffuse *= mix( vec3( 1.0 ), uShadowTint, snShade * snSnow );

  // (b) multiple scattering inside the pack: shadowed snow still glows.
  float snSkyVis = 0.55 + 0.45 * snWN.y;
  totalEmissiveRadiance += uShadowGlow * ( snShade * snSkyVis * snSnow ) * diffuseColor.rgb;

  // (c) subsurface transmission: light enters, bounces, leaves past the
  //     terminator. Only the excess over Lambert is added, so the lit side is
  //     left untouched and the terminator softens into a wide icy gradient.
  float snWrapD = max( 0.0, ( snNdL + uWrap ) / ( 1.0 + uWrap ) );
  float snSSS   = max( 0.0, snWrapD * snWrapD - max( snNdL, 0.0 ) );
  totalEmissiveRadiance += snSunTotal * snShadow * uSSSColor
                         * ( snSSS * uSSSStrength * snSnow ) * diffuseColor.rgb;

  // (d) strong forward scattering looking into the sun, plus the opposition
  //     surge that makes snow flare when the sun is behind you.
  float snLV  = dot( snL, snVv );
  float snFwd = pow( clamp( -snLV, 0.0, 1.0 ), 4.0 ) * ( 1.0 - snNdV ) * snWrapD;
  float snHot = pow( clamp(  snLV, 0.0, 1.0 ), 3.0 ) * max( snNdL, 0.0 );
  totalEmissiveRadiance += snSunTotal * snShadow * snSnow * diffuseColor.rgb
                         * ( uSSSColor * ( snFwd * uForward ) + vec3( snHot * uHotspot ) );

  // (e) sparkle. Cell size is pinned to a constant number of *pixels* and
  //     crossfaded between two power-of-two scales, so crystals neither alias
  //     into static in the distance nor pop as the camera closes in.
  float snSpMask = snSnow * ( 1.0 - 0.7 * snIce ) * ( 1.0 - 0.35 * snPiste )
                 * snShadow * smoothstep( 0.0, 0.28, snNdL )
                 * ( 1.0 - smoothstep( uSparkleFar * 0.45, uSparkleFar, snDist ) );

  if ( snSpMask > 0.002 ) {
    vec3  snH   = normalize( snL + snVv );
    float cells = clamp( 1.0 / ( snPx * uSparklePixels ), 0.5, 300.0 );
    float lod   = log2( cells );
    float lo    = floor( lod );
    float s0    = exp2( lo );
    vec3  g0    = snSparkleLayer( snP.xz * s0, snN, snH );
    vec3  g1    = snSparkleLayer( snP.xz * ( s0 * 2.0 ), snN, snH );
    vec3  spark = mix( g0, g1, lod - lo );

    // crystals cluster; a flat field of glitter looks like television snow
    // NB: 'patch' is a reserved word in GLSL ES 3.0 (tessellation); do not use it.
    float sparklePatch = smoothstep( 0.25, 0.80, snFbmD2( snP.xz * 0.30 ).x * 1.6 + 0.5 );
    totalEmissiveRadiance += spark * snSunTotal * ( uSparkle * snSpMask * ( 0.30 + 0.70 * sparklePatch ) );
  }
`;
