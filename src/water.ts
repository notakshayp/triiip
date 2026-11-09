import * as THREE from 'three'
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js'
import { RippleSim } from './ripples'

// ---------------------------------------------------------------------------
// Water with volume.
//
// The water is drawn in its own pass (WaterPass) right after the opaque
// scene, so it can *see* that scene: a copy of the frame's colour + linear
// depth is handed to the water shader, which gives it
//   • refraction — the bed (and anything swimming) seen bent and wobbling
//     through the moving surface
//   • thickness — light is absorbed by the length of water each view ray
//     travels through (red first, then green), so shallows are clear,
//     slopes fade through turquoise, and deep water turns blue-black
//   • exact shorelines and foam from the real bed depth under every pixel
//   • caustics projected onto the bed, sunlit crests glowing through
// The surface itself moves: a dense grid around the player is displaced by
// Gerstner waves, scaled by how deep and open the water is (calm ponds, a
// rolling sea), plus a slow swell that pushes the waterline up and down
// beaches. Swimming leaves expanding ring ripples.
//
// A 256² height map (2 m texels, 512 m across) baked around the player in
// the background gives the shader water depth/openness for wave amplitude.
// ---------------------------------------------------------------------------

export const WATER_Y = -0.22

const HM_N = 256
const HM_SIZE = 512 // metres covered by the height map
const HM_RECENTER = 128

/** Wave set shared by the shader and the CPU (buoyancy): dir xy, wavelength, relative amplitude. */
const WAVES: Array<[number, number, number, number]> = [
  [0.94, 0.34, 11.0, 1.0],
  [0.62, -0.78, 6.3, 0.55],
  [-0.2, 0.98, 3.7, 0.3],
  [0.85, 0.53, 2.1, 0.16],
]
const waveGlsl = WAVES.map(([x, z, wl, a]) => `wave(p, vec2(${x.toFixed(3)}, ${z.toFixed(3)}), ${wl.toFixed(2)}, amp * ${a.toFixed(2)}, off, tan, bit);`).join('\n          ')

/** Grid: 320² quads over 2.4 km, concentrated near the centre (~0.6 m spacing within ~60 m). */
function waterGrid(): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(2, 2, 320, 320)
  g.rotateX(-Math.PI / 2)
  const pos = g.getAttribute('position')
  const warp = (u: number) => (0.075 * u + 0.925 * u * u * u) * 1200
  for (let i = 0; i < pos.count; i++) pos.setXYZ(i, warp(pos.getX(i)), 0, warp(pos.getZ(i)))
  g.computeBoundingSphere()
  return g
}

/**
 * Signed distance to the shoreline over the height grid (metres, positive in
 * water): two-pass chamfer distance transform, once to land and once to water.
 */
function shoreDistance(h: Float32Array, texel: number): Float32Array {
  const N = HM_N
  const INF = 1e6
  const D = texel
  const DD = texel * Math.SQRT2
  const toLand = new Float32Array(N * N)
  const toWater = new Float32Array(N * N)
  for (let i = 0; i < N * N; i++) {
    const wet = h[i] < WATER_Y
    toLand[i] = wet ? INF : 0
    toWater[i] = wet ? 0 : INF
  }
  for (const f of [toLand, toWater]) {
    for (let z = 0; z < N; z++) {
      for (let x = 0; x < N; x++) {
        const i = z * N + x
        let v = f[i]
        if (x > 0) v = Math.min(v, f[i - 1] + D)
        if (z > 0) {
          v = Math.min(v, f[i - N] + D)
          if (x > 0) v = Math.min(v, f[i - N - 1] + DD)
          if (x < N - 1) v = Math.min(v, f[i - N + 1] + DD)
        }
        f[i] = v
      }
    }
    for (let z = N - 1; z >= 0; z--) {
      for (let x = N - 1; x >= 0; x--) {
        const i = z * N + x
        let v = f[i]
        if (x < N - 1) v = Math.min(v, f[i + 1] + D)
        if (z < N - 1) {
          v = Math.min(v, f[i + N] + D)
          if (x < N - 1) v = Math.min(v, f[i + N + 1] + DD)
          if (x > 0) v = Math.min(v, f[i + N - 1] + DD)
        }
        f[i] = v
      }
    }
  }
  const out = new Float32Array(N * N)
  for (let i = 0; i < N * N; i++) {
    // The shoreline sits between texels: shift by half a texel either side.
    out[i] = THREE.MathUtils.clamp(h[i] < WATER_Y ? toLand[i] - D * 0.5 : -(toWater[i] - D * 0.5), -200, 200)
  }
  return out
}

export class GhibliWater {
  readonly mesh: THREE.Mesh
  /** Live ripple simulation around the player (wakes, rain). */
  readonly ripples: RippleSim
  private mat: THREE.ShaderMaterial
  private heightTex: THREE.DataTexture
  /** RG half-float: r = ground height, g = signed distance to the shoreline (m, + in water). */
  private heightData = new Uint16Array(HM_N * HM_N * 2) // owned by heightTex
  private staging = new Uint16Array(HM_N * HM_N * 2)
  private stagingH = new Float32Array(HM_N * HM_N)
  /** CPU copy of the shore distance field (for buoyancy/sound) and its rect. */
  private shoreField: Float32Array | null = null
  private shoreRect = new THREE.Vector3()
  private job: { x0: number; z0: number; row: number } | null = null
  private center = new THREE.Vector2(Infinity, Infinity)
  private time = 0

  constructor(private groundHeight: (x: number, z: number) => number) {
    this.heightTex = new THREE.DataTexture(this.heightData, HM_N, HM_N, THREE.RGFormat, THREE.HalfFloatType)
    this.heightTex.minFilter = THREE.LinearFilter
    this.heightTex.magFilter = THREE.LinearFilter
    this.heightTex.wrapS = this.heightTex.wrapT = THREE.ClampToEdgeWrapping


    const depthFn = /* glsl */ `
      uniform sampler2D uHeight;
      uniform vec4 uHeightRect;
      float depthAt(vec2 xz) {
        vec2 uv = (xz - uHeightRect.xy) / uHeightRect.z;
        if (uHeightRect.w < 0.5 || any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 40.0;
        return ${WATER_Y.toFixed(3)} - texture2D(uHeight, uv).r;
      }
      /** Signed distance to the shoreline in metres (+ out over the water). */
      float shoreDist(vec2 xz) {
        vec2 uv = (xz - uHeightRect.xy) / uHeightRect.z;
        if (uHeightRect.w < 0.5 || any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return 200.0;
        return texture2D(uHeight, uv).g;
      }
      /** 0 = pond ringed by land, 1 = open water (depth sampled 10 m around). */
      float openness(vec2 p) {
        float o = clamp(depthAt(p + vec2(10.0, 0.0)), -1.0, 2.0) + clamp(depthAt(p - vec2(10.0, 0.0)), -1.0, 2.0)
                + clamp(depthAt(p + vec2(0.0, 10.0)), -1.0, 2.0) + clamp(depthAt(p - vec2(0.0, 10.0)), -1.0, 2.0);
        return smoothstep(0.2, 1.6, o * 0.25);
      }
    `

    // Surf: wave fronts that roll in parallel to the coast, steepen and
    // break in the shallows, then surge up the sand and drain back. The
    // phase runs with distance from the shoreline (not depth — on a bumpy
    // shelf that broke the crests into blobs), so each crest is a line that
    // follows the coast and travels in; the shape rises fast and drains slow
    // (swash). Same formula on the CPU (surfAt).
    const surfFn = /* glsl */ `
      float surfPhase(vec2 p, float sd, float open) {
        float along = sin(p.x * 0.043 + p.y * 0.029) * 0.5 + sin(p.x * -0.017 + p.y * 0.051 + 1.7) * 0.5;
        float period = 6.0; // one period everywhere: a spatially varying one drifts apart into stripes
        float wl = mix(5.0, 12.0, open);
        return fract(uTime / period + sd / wl + along * 0.12);
      }
      float surfShape(float ph) {
        return smoothstep(0.5, 0.68, ph) * (1.0 - smoothstep(0.68, 1.0, ph));
      }
      float surfAmp(float depth, float open) {
        // Grows into the shallows, holds over the swash zone on the sand.
        return mix(0.035, 0.17, open) * (1.0 - smoothstep(0.6, 3.2, depth));
      }
    `

    this.mat = new THREE.ShaderMaterial({
      fog: true,
      depthWrite: true,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uHeight: { value: null },
          uHeightRect: { value: new THREE.Vector4(0, 0, HM_SIZE, 0) }, // xMin, zMin, size, valid
          uScene: { value: null },
          uRes: { value: new THREE.Vector2(1, 1) },
          uTime: { value: 0 },
          uSunDir: { value: new THREE.Vector3(0.5, 0.7, 0.3) },
          uSunCol: { value: new THREE.Color(1, 0.96, 0.88) },
          uDay: { value: 1 },
          uSkyTop: { value: new THREE.Color(0x3a6fc4) },
          uSkyHorizon: { value: new THREE.Color(0xbfe0ff) },
          uShallow: { value: new THREE.Color(0x2fa3a0) },
          uDeep: { value: new THREE.Color(0x0a3050) },
        },
      ]),
      vertexShader: /* glsl */ `
        #include <common>
        #include <fog_pars_vertex>
        uniform float uTime;
        ${depthFn}
        ${surfFn}
        varying vec3 vWorld;
        varying float vJac;
        uniform sampler2D uRipple;
        uniform vec3 uRippleRect;
        varying vec3 vWaveN;
        varying float vCrest;
        varying float vViewZ;
        varying float vOpen;

        // Gerstner wave: moves points in circles, so crests sharpen and
        // troughs flatten (water, not a sine-wobbled sheet).
        void wave(vec2 p, vec2 d, float wl, float a, inout vec3 off, inout vec3 tan, inout vec3 bit) {
          float k = 6.28318 / wl;
          float c = sqrt(9.8 / k);
          float f = k * (dot(d, p) - c * uTime);
          float q = 0.55 / (k * max(a, 1e-4) * 4.0); // steepness, normalised
          q = min(q, 1.0) * a;
          off += vec3(d.x * q * cos(f), a * sin(f), d.y * q * cos(f));
          float wa = k * a;
          tan += vec3(-d.x * d.x * q * k * sin(f), d.x * wa * cos(f), -d.x * d.y * q * k * sin(f));
          bit += vec3(-d.x * d.y * q * k * sin(f), d.y * wa * cos(f), -d.y * d.y * q * k * sin(f));
        }

        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vec2 p = wp.xz;
          float depth = depthAt(p);
          float open = openness(p);
          vOpen = open;
          // Amplitude: rolling in open, deep water; a ripple on ponds.
          // Waves keep their size into the shallows (they bunch up there
          // before breaking) and only die in the last half metre — fading
          // them over 2.5 m left a glassy band right in front of the beach.
          float amp = mix(0.03, 0.2, open) * smoothstep(0.0, 0.6, depth);
          // Fade waves out with distance (grid gets coarse; also calmer horizon).
          float camD = length(cameraPosition.xz - p);
          amp *= 1.0 - smoothstep(120.0, 260.0, camD);
          vec3 off = vec3(0.0);
          vec3 tan = vec3(1.0, 0.0, 0.0);
          vec3 bit = vec3(0.0, 0.0, 1.0);
          ${waveGlsl}
          // Slow swell: the whole surface breathes, pushing the waterline up
          // and down beaches.
          off.y += 0.045 * sin(uTime * 0.55 + dot(p, vec2(0.03, 0.021))) * (0.4 + 0.6 * open);
          // Surf rolling in and running up the beach.
          float ph = surfPhase(p, shoreDist(p), open);
          float shape = surfShape(ph);
          off.y += surfAmp(depth, open) * shape;
          // Live ripples (wakes, rain) lift the surface a little too.
          vec2 ruv0 = (p - uRippleRect.xy) / uRippleRect.z;
          if (all(greaterThan(ruv0, vec2(0.0))) && all(lessThan(ruv0, vec2(1.0)))) off.y += texture2D(uRipple, ruv0).r * 0.6;
          // Horizontal squeeze of the surface (Jacobian): < 1 where waves bunch
          // up and break — whitecaps form there, the way ocean renderers do it.
          vJac = tan.x * bit.z - tan.z * bit.x;
          wp.xyz += off;
          vWaveN = normalize(cross(bit, tan));
          vCrest = clamp(off.y / max(amp, 0.01), -1.0, 1.0);
          vWorld = wp.xyz;
          vec4 mvPosition = viewMatrix * wp;
          vViewZ = -mvPosition.z;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <fog_pars_fragment>
        uniform float uTime;
        ${depthFn}
        ${surfFn}
        uniform sampler2D uScene; // rgb = opaque scene, a = linear view depth
        uniform vec2 uRes;
        uniform vec3 uSunDir;
        uniform vec3 uSunCol;
        uniform float uDay;
        uniform vec3 uSkyTop;
        uniform vec3 uSkyHorizon;
        uniform vec3 uShallow;
        uniform vec3 uDeep;
        varying vec3 vWorld;
        varying vec3 vWaveN;
        varying float vCrest;
        varying float vViewZ;
        varying float vOpen;
        varying float vJac;
        uniform sampler2D uRipple;
        uniform vec3 uRippleRect;

        vec2 hash22(vec2 q) {
          q = vec2(dot(q, vec2(127.1, 311.7)), dot(q, vec2(269.5, 183.3)));
          return fract(sin(q) * 43758.5453);
        }
        /** Voronoi with drifting feature points: (F1, F2). Cell borders
         *  (F2 - F1 small) are a web of lines — foam lace and caustics. */
        vec2 voro(vec2 x, float t) {
          vec2 n = floor(x);
          vec2 f = fract(x);
          float f1 = 8.0;
          float f2 = 8.0;
          for (int j = -1; j <= 1; j++)
          for (int i = -1; i <= 1; i++) {
            vec2 g = vec2(float(i), float(j));
            vec2 o = hash22(n + g);
            o = 0.5 + 0.42 * sin(t + 6.2831 * o);
            float d = length(g + o - f);
            if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
          }
          return vec2(f1, f2);
        }
        /**
         * Small waves, procedurally (GPU Gems ch.1 sum-of-waves with the
         * exponential-sine shape and domain warping): ~14 waves, each with its
         * own heading and its own physical speed (ω = √(g·k)), every one
         * pushing the ones after it. Returns the surface slope. Waves smaller
         * than a pixel fade out (no shimmer in the distance).
         */
        vec2 waveDetail(vec2 p, float t, float fw) {
          vec2 grad = vec2(0.0);
          float k = 0.85;
          float a = 1.0;
          float sumA = 0.0;
          for (int i = 0; i < 14; i++) {
            float fi = float(i);
            float ang = 0.35 + (fract(sin(fi * 12.9898) * 43758.5453) - 0.5) * 2.6;
            vec2 d = vec2(cos(ang), sin(ang));
            float x = dot(d, p) * k - sqrt(9.8 * k) * t + fi * 1.7;
            float e = exp(sin(x) - 1.0);
            float de = e * cos(x);
            float aa = a * (1.0 - smoothstep(0.1, 0.45, k * fw));
            grad += d * de * aa;
            p -= d * de * aa * 0.45 / k; // domain warp
            sumA += a;
            k *= 1.24;
            a *= 0.79;
          }
          return grad / sumA;
        }

        void main() {
          vec2 p = vWorld.xz;
          vec3 toCam = cameraPosition - vWorld;
          float dist = length(toCam);
          vec3 V = toCam / dist;

          // -- Surf, per pixel (the grid is metres apart out there; per-vertex
          // surf terms smeared into blobs). Same formulas as the vertex lift.
          float pDepth = depthAt(p);
          float sph = surfPhase(p, shoreDist(p), vOpen);
          float sshape = surfShape(sph);
          float vSurfH = surfAmp(pDepth, vOpen) * sshape;
          // Breaking crest in the last metre of depth; lace left on the backwash.
          float vBreak = sshape * (1.0 - smoothstep(0.3, 1.0, pDepth)) * smoothstep(-0.2, 0.15, pDepth) * (0.35 + 0.65 * vOpen);
          float vLace = smoothstep(0.66, 0.72, sph) * (1.0 - smoothstep(0.8, 0.99, sph)) * (1.0 - smoothstep(0.1, 0.9, pDepth)) * smoothstep(0.2, 0.8, vOpen);

          // -- Surface normal: big Gerstner swell (vertex) + procedural small
          // waves + the live ripple simulation.
          float fw = length(fwidth(p));
          float chop = mix(0.12, 0.26, vOpen) * mix(0.6, 1.0, smoothstep(0.0, 0.25, depthAt(p)));
          vec2 slope = waveDetail(p, uTime, fw) * chop;
          vec2 ruv = (p - uRippleRect.xy) / uRippleRect.z;
          float wake = 0.0;
          if (all(greaterThan(ruv, vec2(0.002))) && all(lessThan(ruv, vec2(0.998)))) {
            float e = 1.0 / 256.0;
            vec4 rc = texture2D(uRipple, ruv);
            float hx = texture2D(uRipple, ruv + vec2(e, 0.0)).r - texture2D(uRipple, ruv - vec2(e, 0.0)).r;
            float hz = texture2D(uRipple, ruv + vec2(0.0, e)).r - texture2D(uRipple, ruv - vec2(0.0, e)).r;
            slope -= vec2(hx, hz) / (2.0 * uRippleRect.z / 256.0) * 0.9;
            wake = rc.b;
          }
          vec3 N = normalize(vec3(vWaveN.x - slope.x, vWaveN.y, vWaveN.z - slope.y));

          // -- What's under the surface (from the opaque scene copy).
          vec2 suv = gl_FragCoord.xy / uRes;
          vec4 under = texture2D(uScene, suv);
          // View-ray length through the water → vertical water depth.
          float rayK = dist / max(vViewZ, 1e-3);
          float thick = max(under.a - vViewZ, 0.0) * rayK;
          float vdepth = thick * V.y;
          // Refraction: offset the lookup by the surface slope, more through
          // deeper water; reject samples in front of the surface.
          float refr = clamp(vdepth * 1.5, 0.0, 1.0) * 0.9 / max(vViewZ, 1.5);
          vec4 bent = texture2D(uScene, suv + N.xz * refr);
          if (bent.a > vViewZ) {
            under = bent;
            thick = max(under.a - vViewZ, 0.0) * rayK;
          }
          // Absorption: red goes first, then green; deep water turns blue-black.
          vec3 T = exp(-thick * vec3(0.75, 0.3, 0.2));
          // Caustics: the light web on the bed — drifting Voronoi borders,
          // two layers multiplied, wobbled by the surface above.
          vec3 bed = vWorld - V * thick;
          float caustic = 0.0;
          if (vdepth < 3.5 && uDay > 0.05) {
            // Wobbled by the surface above; two drifting layers, and only
            // where both bend light together does it get bright.
            vec2 cp = bed.xz * 1.9 + N.xz * 1.4 + slope * 1.5;
            // Bend the cell borders so the web is made of curves, not straight cracks.
            cp += vec2(sin(cp.y * 1.7 + uTime * 0.7), sin(cp.x * 1.5 - uTime * 0.6)) * 0.22;
            vec2 v1 = voro(cp, uTime * 1.3);
            vec2 v2 = voro(cp * 1.31 + 3.1, uTime * 1.05 + 2.0);
            float l1 = 1.0 - smoothstep(0.0, 0.16, v1.y - v1.x);
            float l2 = 1.0 - smoothstep(0.0, 0.16, v2.y - v2.x);
            caustic = l1 * l2 * 1.4 + (l1 + l2) * 0.12;
            caustic *= smoothstep(0.03, 0.3, vdepth) * (1.0 - smoothstep(0.5, 3.0, vdepth)) * uDay;
            caustic *= 1.0 - smoothstep(0.03, 0.09, fw); // fade before it aliases
          }
          vec3 bedCol = under.rgb * 0.8 * (1.0 + caustic * 0.45 * uSunCol);
          // In-scattered water colour (the "body" you look into).
          vec3 body = mix(uShallow * 0.75, uDeep, smoothstep(0.3, 4.0, thick)) * (0.25 + 0.75 * uDay);
          vec3 col = bedCol * T + body * (1.0 - T);
          col = mix(col, body * 1.1, 0.18 * smoothstep(0.0, 0.25, vdepth));

          // -- Light on the surface.
          vec3 L = normalize(uSunDir);
          float backlit = pow(clamp(dot(-V, L) * 0.5 + 0.5, 0.0, 1.0), 2.0);
          col += uShallow * uSunCol * max(vCrest, 0.0) * vOpen * (0.25 + backlit * 0.5) * uDay * 0.6;
          // Reflection off a normal that calms with distance: at grazing
          // angles every tiny facet tilted away would mirror the white
          // horizon at full strength — a sea of white specks.
          vec3 Nr = normalize(vec3(vWaveN.x - slope.x * mix(1.0, 0.3, smoothstep(6.0, 40.0, dist)), vWaveN.y, vWaveN.z - slope.y * mix(1.0, 0.3, smoothstep(6.0, 40.0, dist))));
          float fres = 0.02 + 0.98 * pow(clamp(1.0 - dot(Nr, V), 0.0, 1.0), 5.0);
          vec3 R = reflect(-V, Nr);
          vec3 sky = min(mix(uSkyHorizon, uSkyTop, pow(clamp(R.y, 0.0, 1.0), 0.6)), vec3(0.9));
          col = mix(col, sky, fres * 0.7);
          // Sun glints off a gentler normal: glitter gathers in the sun's
          // reflection path instead of sparkling over the whole sea.
          vec3 Ns = normalize(vec3(vWaveN.x - slope.x * 0.35, vWaveN.y, vWaveN.z - slope.y * 0.35));
          float sp = clamp(dot(reflect(-V, Ns), L), 0.0, 1.0);
          float path = smoothstep(0.7, 0.95, dot(reflect(-V, vec3(0.0, 1.0, 0.0)), L)); // the glitter path under the sun
          col += uSunCol * (pow(sp, 700.0) * 4.0 * path + pow(sp, 40.0) * 0.18) * uDay;

          // -- Shoreline: the water thins out over the wet sand instead of
          // stopping at a cut — a soft, slightly irregular edge.
          float edgeN = sin(p.x * 2.3 + sin(p.y * 1.7)) * sin(p.y * 2.1 + p.x * 0.6) * 0.012;
          float melt = smoothstep(0.0, 0.09, vdepth + edgeN);
          col = mix(under.rgb * mix(0.82, 1.0, melt), col, melt * melt * (3.0 - 2.0 * melt));

          // -- Foam. How much foam there is comes from the water's motion:
          // the swash edge riding up and down the sand, the breaking crest,
          // the lace left by the backwash, whitecaps where the swell bunches
          // up, and the cat's wake. What it looks like is bubble lace (cell
          // borders that drift and change), carried up and down the beach
          // with the swash rather than scrolling.
          float rimW = mix(0.035, 0.09, vOpen);
          float rim = 1.0 - smoothstep(0.0, rimW, vdepth);
          float caps = (1.0 - smoothstep(0.64, 0.72, vJac)) * vOpen * smoothstep(1.5, 4.0, vdepth) * 0.8;
          float amount = clamp(rim * mix(0.7, 1.0, vOpen) + smoothstep(0.15, 0.55, vBreak) * 0.75 + vLace * 0.6 + caps + wake * 0.45, 0.0, 1.0);
          if (amount > 0.01) {
            // Shoreward direction from the depth field; the swash carries the lace.
            vec2 g = vec2(depthAt(p + vec2(1.0, 0.0)) - depthAt(p - vec2(1.0, 0.0)), depthAt(p + vec2(0.0, 1.0)) - depthAt(p - vec2(0.0, 1.0)));
            float gl = length(g);
            vec2 shore = gl > 1e-4 ? -g / gl : vec2(0.0);
            float run = clamp(vSurfH / max(gl * 0.5, 0.04), 0.0, 3.0);
            vec2 fp = p - shore * run;
            // Foam texture: a continuous field (warped so no cell grid shows)
            // revealed only as far as the foam amount asks — a few wisps when light,
            // solid white when churning.
            vec2 q = fp + vec2(sin(fp.y * 0.9 + uTime * 0.3), cos(fp.x * 0.8 - uTime * 0.25)) * 0.4;
            vec2 a1 = voro(q * 2.1, uTime * 0.5);
            vec2 a2 = voro(q * 5.3 + 7.0, uTime * 0.8);
            float big = voro(q * 0.45 + 2.0, uTime * 0.15).x;
            float pattern = 0.5 * (1.0 - smoothstep(0.0, 0.3, a1.y - a1.x)) + 0.3 * (1.0 - smoothstep(0.1, 0.6, a2.x)) + 0.2 * (1.0 - big);
            pattern = clamp(pattern * 1.35 - 0.05, 0.0, 1.0);
            float foam = smoothstep(1.0 - amount, 1.0 - amount + 0.12, pattern) * smoothstep(0.12, 0.3, amount) * smoothstep(0.004, 0.03, vdepth + edgeN);
            col = mix(col, vec3(0.96, 0.99, 1.0) * (0.4 + 0.6 * uDay), foam * 0.85);
          }

          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }
      `,
    })
    this.mat.uniforms.uHeight.value = this.heightTex
    this.ripples = new RippleSim(this.heightTex, this.mat.uniforms.uHeightRect as { value: THREE.Vector4 }, WATER_Y)
    this.mat.uniforms.uRipple = this.ripples.uniforms.uRipple
    this.mat.uniforms.uRippleRect = this.ripples.uniforms.uRippleRect
    this.mesh = new THREE.Mesh(waterGrid(), this.mat)
    this.mesh.position.y = WATER_Y
    this.mesh.frustumCulled = false
  }

  /** Reflect the live sky gradient (shares DayNight's colour objects). */
  bindSky(top: THREE.Color, horizon: THREE.Color): void {
    this.mat.uniforms.uSkyTop.value = top
    this.mat.uniforms.uSkyHorizon.value = horizon
  }

  /** WaterPass hands over the opaque-scene copy (rgb + linear depth). */
  setScene(tex: THREE.Texture, w: number, h: number): void {
    this.mat.uniforms.uScene.value = tex
    ;(this.mat.uniforms.uRes.value as THREE.Vector2).set(w, h)
  }

  /**
   * Water surface height at (x, z) right now — the same waves the shader
   * draws (vertical part), so a swimmer bobs with them.
   */
  surfaceAt(x: number, z: number): number {
    const gh = this.groundHeight
    const depth = WATER_Y - gh(x, z)
    const o = (d: number) => THREE.MathUtils.clamp(d, -1, 2)
    const op = THREE.MathUtils.smoothstep(
      (o(WATER_Y - gh(x + 10, z)) + o(WATER_Y - gh(x - 10, z)) + o(WATER_Y - gh(x, z + 10)) + o(WATER_Y - gh(x, z - 10))) * 0.25,
      0.2,
      1.6,
    )
    const amp = THREE.MathUtils.lerp(0.03, 0.2, op) * THREE.MathUtils.smoothstep(depth, 0, 0.6)
    let y = 0
    for (const [dx, dz, wl, a] of WAVES) {
      const k = (Math.PI * 2) / wl
      const c = Math.sqrt(9.8 / k)
      y += amp * a * Math.sin(k * (dx * x + dz * z - c * this.time))
    }
    y += 0.045 * Math.sin(this.time * 0.55 + x * 0.03 + z * 0.021) * (0.4 + 0.6 * op)
    y += this.surfAt(x, z, depth, op, this.shoreDistAt(x, z, depth))
    return WATER_Y + y
  }

  /** Surf height (mirror of surfPhase/surfShape/surfAmp in the shader). */
  private surfAt(x: number, z: number, depth: number, open: number, sd: number): number {
    const v = this.surfPhaseAt(x, z, sd, open)
    const ph = v - Math.floor(v)
    const ss = THREE.MathUtils.smoothstep
    const shape = ss(ph, 0.5, 0.68) * (1 - ss(ph, 0.68, 1))
    return THREE.MathUtils.lerp(0.035, 0.17, open) * (1 - ss(depth, 0.6, 3.2)) * shape
  }

  private surfPhaseAt(x: number, z: number, sd: number, open: number): number {
    const along = Math.sin(x * 0.043 + z * 0.029) * 0.5 + Math.sin(x * -0.017 + z * 0.051 + 1.7) * 0.5
    const period = 6
    const wl = THREE.MathUtils.lerp(5, 12, open)
    return this.time / period + sd / wl + along * 0.12
  }

  /** Signed shore distance (bilinear from the CPU copy); a depth guess before it exists. */
  private shoreDistAt(x: number, z: number, depth: number): number {
    const f = this.shoreField
    if (!f) return depth * 8
    const texel = this.shoreRect.z / HM_N
    const fx = (x - this.shoreRect.x) / texel - 0.5
    const fz = (z - this.shoreRect.y) / texel - 0.5
    if (fx < 0 || fz < 0 || fx >= HM_N - 1 || fz >= HM_N - 1) return depth * 8
    const ix = Math.floor(fx)
    const iz = Math.floor(fz)
    const tx = fx - ix
    const tz = fz - iz
    const i = iz * HM_N + ix
    return (f[i] * (1 - tx) + f[i + 1] * tx) * (1 - tz) + (f[i + HM_N] * (1 - tx) + f[i + HM_N + 1] * tx) * tz
  }

  /**
   * Surf near (x, z) for the sound: how much open shoreline is within earshot
   * (0..1) and the local breaker phase (0..1, crest ≈ 0.68).
   */
  surfNear(x: number, z: number): { level: number; phase: number; period: number } {
    const gh = this.groundHeight
    let best = 0
    let bestPh = 0
    let bestPeriod = 6
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2
      for (const r of [4, 12, 26]) {
        const sx = x + Math.cos(a) * r
        const sz = z + Math.sin(a) * r
        const d = WATER_Y - gh(sx, sz)
        if (d < 0.05 || d > 1.5) continue
        // Open water out beyond this shallow point?
        const open = THREE.MathUtils.clamp((WATER_Y - gh(sx + Math.cos(a) * 14, sz + Math.sin(a) * 14)) / 1.6, 0, 1)
        const w = open * (1 - r / 34)
        if (w > best) {
          best = w
          bestPeriod = 6
          const v = this.surfPhaseAt(sx, sz, this.shoreDistAt(sx, sz, d), open)
          bestPh = v - Math.floor(v)
        }
        break
      }
    }
    return { level: best, phase: bestPh, period: bestPeriod }
  }

  update(dt: number, playerPos: THREE.Vector3, sunDir: THREE.Vector3, sunColor: THREE.Color, sunIntensity: number, day: number): void {
    const u = this.mat.uniforms
    this.time += dt
    u.uTime.value = this.time
    ;(u.uSunDir.value as THREE.Vector3).copy(sunDir).normalize()
    ;(u.uSunCol.value as THREE.Color).copy(sunColor).multiplyScalar(THREE.MathUtils.clamp(sunIntensity / 2.0, 0.15, 1.2))
    u.uDay.value = day

    // Grid follows the player (snapped — waves are computed in world space).
    this.mesh.position.set(Math.round(playerPos.x / 8) * 8, WATER_Y, Math.round(playerPos.z / 8) * 8)

    // Height map: rebuild in the background when the player drifts off-centre;
    // a teleport out of the covered area rebuilds it immediately.
    const dist = Math.hypot(playerPos.x - this.center.x, playerPos.z - this.center.y)
    if (!this.job && !(dist < HM_RECENTER)) {
      const cx = Math.round(playerPos.x / 32) * 32
      const cz = Math.round(playerPos.z / 32) * 32
      this.job = { x0: cx - HM_SIZE / 2, z0: cz - HM_SIZE / 2, row: 0 }
    }
    if (this.job) this.work(dist < HM_SIZE / 2 ? 2 : 1000)
  }

  private work(budgetMs: number): void {
    const job = this.job!
    const deadline = performance.now() + budgetMs
    const texel = HM_SIZE / HM_N
    while (job.row < HM_N) {
      // Sample at texel centres.
      const z = job.z0 + (job.row + 0.5) * texel
      const off = job.row * HM_N
      for (let i = 0; i < HM_N; i++) {
        this.stagingH[off + i] = this.groundHeight(job.x0 + (i + 0.5) * texel, z)
      }
      job.row++
      if (performance.now() > deadline) return
    }
    const sd = shoreDistance(this.stagingH, texel)
    for (let i = 0; i < HM_N * HM_N; i++) {
      this.staging[i * 2] = THREE.DataUtils.toHalfFloat(this.stagingH[i])
      this.staging[i * 2 + 1] = THREE.DataUtils.toHalfFloat(sd[i])
    }
    this.shoreField = sd
    this.shoreRect.set(job.x0, job.z0, HM_SIZE)
    this.heightData.set(this.staging)
    this.heightTex.needsUpdate = true
    ;(this.mat.uniforms.uHeightRect.value as THREE.Vector4).set(job.x0, job.z0, HM_SIZE, 1)
    this.center.set(job.x0 + HM_SIZE / 2, job.z0 + HM_SIZE / 2)
    this.job = null
  }
}

/**
 * Draws the water (and the transparent effects that must sit on top of it)
 * after the opaque scene: copies the frame's colour + linear depth for the
 * water shader to look through, then renders `overlay` into the same target
 * (depth-tested against the opaque scene). No buffer swap.
 */
export class WaterPass extends Pass {
  private copy: THREE.WebGLRenderTarget
  private quad: FullScreenQuad
  private copyMat: THREE.ShaderMaterial

  constructor(
    private overlay: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
    private water: GhibliWater,
  ) {
    super()
    this.needsSwap = false
    this.copy = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false })
    this.copyMat = new THREE.ShaderMaterial({
      uniforms: { tColor: { value: null }, tDepth: { value: null }, uNear: { value: 0.1 }, uFar: { value: 1000 } },
      vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tColor;
        uniform sampler2D tDepth;
        uniform float uNear;
        uniform float uFar;
        varying vec2 vUv;
        void main() {
          float d = texture2D(tDepth, vUv).x;
          float lin = (2.0 * uNear * uFar) / (uFar + uNear - (d * 2.0 - 1.0) * (uFar - uNear));
          gl_FragColor = vec4(texture2D(tColor, vUv).rgb, min(lin, 60000.0));
        }
      `,
      depthTest: false,
      depthWrite: false,
    })
    this.quad = new FullScreenQuad(this.copyMat)
  }

  setSize(w: number, h: number): void {
    this.copy.setSize(w, h)
    this.water.setScene(this.copy.texture, w, h)
  }

  render(renderer: THREE.WebGLRenderer, _write: THREE.WebGLRenderTarget, read: THREE.WebGLRenderTarget): void {
    const u = this.copyMat.uniforms
    u.tColor.value = read.texture
    u.tDepth.value = read.depthTexture
    u.uNear.value = this.camera.near
    u.uFar.value = this.camera.far
    renderer.setRenderTarget(this.copy)
    this.quad.render(renderer)
    renderer.setRenderTarget(read)
    const auto = renderer.autoClear
    renderer.autoClear = false
    renderer.render(this.overlay, this.camera)
    renderer.autoClear = auto
  }

  dispose(): void {
    this.copy.dispose()
    this.copyMat.dispose()
    this.quad.dispose()
  }
}
