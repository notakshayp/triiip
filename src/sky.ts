import * as THREE from 'three'

// ---------------------------------------------------------------------------
// Sky dome with ray-marched volumetric clouds.
//   • Gradient sky + sun halo (art-directed per time of day by DayNight).
//   • Clouds: a slab at 260–520 m altitude. Each sky pixel marches 18 steps
//     through a baked, tileable 3D Perlin-Worley noise texture (shape +
//     erosion detail), with 2 light samples toward the sun per step —
//     self-shadowed undersides, bright sunlit tops, a forward-scatter silver
//     lining, soft gassy edges. Sample domains are rotated per layer and a
//     large "weather map" clusters clouds into banks, so the tiling texture
//     never reads as a grid. Wind drifts the field; weather drives cover.
//   • Rendered AFTER opaque geometry at the far plane (z = w), so the march
//     only runs where sky is actually visible — mountains/trees/terrain in
//     front cost nothing.
// ---------------------------------------------------------------------------

const NOISE_N = 64

/**
 * Tileable 3D Perlin-Worley noise over 64³, baked once at boot:
 *   R = gradient (Perlin) fbm — soft rolling shape, no lattice blockiness
 *   G = inverted Worley (cellular) fbm — the billowy cauliflower puffs
 * The old value noise had axis-aligned blocky cells that read as a grid.
 */
function makeCloudNoise(): THREE.Data3DTexture {
  const N = NOISE_N
  const data = new Uint8Array(N * N * N * 2)
  let seed = 90211
  const rnd = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
    return seed / 4294967296
  }
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)
  // Perlin octaves: a random unit gradient per lattice point.
  const perlinOct = [4, 8, 16].map((P) => {
    const g = new Float32Array(P * P * P * 3)
    for (let i = 0; i < P * P * P; i++) {
      const z = rnd() * 2 - 1
      const a = rnd() * Math.PI * 2
      const r = Math.sqrt(1 - z * z)
      g[i * 3] = r * Math.cos(a)
      g[i * 3 + 1] = r * Math.sin(a)
      g[i * 3 + 2] = z
    }
    return { P, g }
  })
  // Worley octaves: one random feature point per cell.
  const worleyOct = [4, 8, 16].map((P) => {
    const f = new Float32Array(P * P * P * 3)
    for (let i = 0; i < f.length; i++) f[i] = rnd()
    return { P, f }
  })
  const pw = [0.55, 0.3, 0.15]
  const ww = [0.6, 0.27, 0.13]
  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        let pv = 0
        for (let o = 0; o < perlinOct.length; o++) {
          const { P, g } = perlinOct[o]
          const fx = (x / N) * P
          const fy = (y / N) * P
          const fz = (z / N) * P
          const x0 = Math.floor(fx)
          const y0 = Math.floor(fy)
          const z0 = Math.floor(fz)
          const u = fade(fx - x0)
          const v = fade(fy - y0)
          const w = fade(fz - z0)
          let acc = 0
          for (let k = 0; k < 8; k++) {
            const dx = k & 1
            const dy = (k >> 1) & 1
            const dz = (k >> 2) & 1
            const gi = ((((z0 + dz) % P) * P + ((y0 + dy) % P)) * P + ((x0 + dx) % P)) * 3
            const dot = g[gi] * (fx - x0 - dx) + g[gi + 1] * (fy - y0 - dy) + g[gi + 2] * (fz - z0 - dz)
            acc += dot * (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w)
          }
          pv += (acc * 0.9 + 0.5) * pw[o]
        }
        let wv = 0
        for (let o = 0; o < worleyOct.length; o++) {
          const { P, f } = worleyOct[o]
          const fx = (x / N) * P
          const fy = (y / N) * P
          const fz = (z / N) * P
          const cx = Math.floor(fx)
          const cy = Math.floor(fy)
          const cz = Math.floor(fz)
          let best = 9
          for (let k = -1; k <= 1; k++) {
            for (let j = -1; j <= 1; j++) {
              for (let i = -1; i <= 1; i++) {
                const ci = (((cz + k + P) % P) * P + ((cy + j + P) % P)) * P + ((cx + i + P) % P)
                const ddx = cx + i + f[ci * 3] - fx
                const ddy = cy + j + f[ci * 3 + 1] - fy
                const ddz = cz + k + f[ci * 3 + 2] - fz
                const d = ddx * ddx + ddy * ddy + ddz * ddz
                if (d < best) best = d
              }
            }
          }
          wv += (1 - Math.min(1, Math.sqrt(best))) * ww[o]
        }
        const idx = ((z * N + y) * N + x) * 2
        data[idx] = Math.round(Math.min(1, Math.max(0, pv)) * 255)
        data[idx + 1] = Math.round(Math.min(1, Math.max(0, wv)) * 255)
      }
    }
  }
  const tex = new THREE.Data3DTexture(data, N, N, N)
  tex.format = THREE.RGFormat
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping
  tex.unpackAlignment = 1
  tex.needsUpdate = true
  return tex
}

export function buildSkyMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false,
    uniforms: {
      topColor: { value: new THREE.Color(0x3a6fc4) },
      horizonColor: { value: new THREE.Color(0xbfe0ff) },
      sunGlowColor: { value: new THREE.Color(0xffe9b0) },
      sunDirection: { value: new THREE.Vector3(0, 1, 0) },
      sunStrength: { value: 1 },
      uCloudNoise: { value: makeCloudNoise() },
      uTime: { value: 0 },
      uCover: { value: 0.45 },
      uStorm: { value: 0 },
      uDay: { value: 1 },
      uCamPos: { value: new THREE.Vector3() },
      uSunCol: { value: new THREE.Color(1, 0.97, 0.9) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position; // dome is centred on the camera
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position.z = gl_Position.w; // pin to the far plane: drawn last, only where nothing else is
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp sampler3D;
      uniform vec3 topColor;
      uniform vec3 horizonColor;
      uniform vec3 sunGlowColor;
      uniform vec3 sunDirection;
      uniform float sunStrength;
      uniform sampler3D uCloudNoise;
      uniform float uTime;
      uniform float uCover;
      uniform float uStorm;
      uniform float uDay;
      uniform vec3 uCamPos;
      uniform vec3 uSunCol;
      varying vec3 vDir;

      const float CB = 260.0; // cloud base (m)
      const float CT = 520.0; // cloud top

      // Sample domains are rotated (and differently per layer) so the 64³
      // texture's tile axes never line up with the world or with each other.
      vec3 rotXZ(vec3 p, float a) {
        float c = cos(a), s = sin(a);
        return vec3(c * p.x - s * p.z, p.y, s * p.x + c * p.z);
      }

      float density(vec3 p, bool detail) {
        vec3 wind = vec3(uTime * 7.0, 0.0, uTime * 3.0);
        float h = (p.y - CB) / (CT - CB);
        // Flat-ish bases, rounded tops (cumulus profile).
        float profile = smoothstep(0.0, 0.15, h) * (1.0 - smoothstep(0.45, 1.0, h));
        // Weather map: a very large, slow field clusters clouds into banks and
        // clears gaps between them — no uniform "every tile has a cloud" grid.
        float macro = texture(uCloudNoise, rotXZ(p + wind * 0.4, -1.13) * 0.00021 + vec3(0.37, 0.0, 0.71)).r;
        float cover = clamp(uCover + (macro - 0.5) * 0.9, 0.0, 1.0);
        vec2 n = texture(uCloudNoise, rotXZ(p + wind, 0.61) * 0.00085).rg;
        // Perlin-Worley: perlin shape carved into billowy cells.
        float pw = clamp((n.r - (n.g - 1.0)) / (2.0 - n.g) * 1.15 - 0.15, 0.0, 1.0);
        float d = clamp((pw - (1.0 - cover)) / max(cover, 0.05), 0.0, 1.0) * profile;
        if (detail && d > 0.0) {
          // Erode edges with finer worley — wispy, gassy rims instead of blobs.
          float det = texture(uCloudNoise, rotXZ(p + wind * 1.8, 2.3) * 0.0041).g;
          d = max(0.0, d - (1.0 - det) * 0.38 * (1.0 - d * 0.6));
        }
        return d;
      }

      void main() {
        vec3 dir = normalize(vDir);
        float t = pow(clamp(dir.y, 0.0, 1.0), 0.55);
        vec3 col = mix(horizonColor, topColor, t);
        vec3 sunD = normalize(sunDirection);
        float sunDot = clamp(dot(dir, sunD), 0.0, 1.0);
        float halo = pow(sunDot, 32.0) * 0.85 + pow(sunDot, 180.0) * 1.7;
        col += sunGlowColor * halo * sunStrength;
        float horizonBlend = 1.0 - smoothstep(-0.08, 0.22, abs(dir.y));
        col = mix(col, horizonColor, horizonBlend * 0.65);

        // ---- Volumetric clouds ------------------------------------------
        if (dir.y > 0.012 && uCover > 0.02) {
          float t0 = max((CB - uCamPos.y) / dir.y, 0.0);
          float t1 = (CT - uCamPos.y) / dir.y;
          float tEnd = min(t1, t0 + 2600.0);
          const int N = 18;
          float stepL = (tEnd - t0) / float(N);
          // Interleaved-gradient noise: even, low-clump dither for the march start
          // (white-noise jitter read as visible grain in darker clouds).
          float jitter = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
          float T = 1.0;
          vec3 acc = vec3(0.0);
          vec3 amb = mix(horizonColor, vec3(1.0), 0.45) * (0.16 + 0.84 * uDay) * (1.0 - uStorm * 0.45);
          vec3 sunC = uSunCol * (1.0 - uStorm * 0.6);
          float phase = 0.75 + 1.1 * pow(sunDot, 6.0); // forward scatter: silver lining toward the sun
          for (int i = 0; i < N; i++) {
            vec3 p = uCamPos + dir * (t0 + (float(i) + jitter) * stepL);
            float d = density(p, true);
            if (d > 0.004) {
              float ld = density(p + sunD * 40.0, false) + density(p + sunD * 105.0, false);
              float sunT = exp(-ld * 1.7);
              float powder = 1.0 - exp(-d * 5.0);
              vec3 lit = amb + sunC * sunT * phase * mix(0.55, 1.0, powder);
              float a = 1.0 - exp(-d * stepL * 0.016);
              acc += T * a * lit;
              T *= 1.0 - a;
              if (T < 0.03) break;
            }
          }
          // Far clouds melt into the horizon haze rather than ending hard.
          float fade = exp(-t0 * 0.00042) * smoothstep(0.012, 0.08, dir.y);
          col = mix(col, col * T + acc, fade);
        }
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  })
}
