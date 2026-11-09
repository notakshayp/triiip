import * as THREE from 'three'
import { playerPosUniform, TRAIL_GLSL, trailUniform } from './toon'

// ---------------------------------------------------------------------------
// Individual-blade grass, Ghost-of-Tsushima style.
//
// Geometry: a "clump" of separate curved, tapered blades (real geometry, no
// alpha cards — no plastic card look, no alpha overdraw). Two LODs: 11 blades
// × 3 segments near, 5 × 2 far; each blade ends in a single tip vertex.
//
// Vertex shader per blade:
//   • gusts — a scrolling noise field sweeps across the world, so wind rolls
//     over the meadow in visible waves; each blade also flutters on its own
//   • contact — blades lean over where the player's body passes (trail)
//   • rank fade — every instance has a rank; density thins smoothly with
//     distance, so chunk detail tiers never pop
// Fragment: root→tip gradient, world-space colour patches (lush / golden /
// olive), per-blade hue jitter, sun translucency, and a sheen on blades bent
// by a gust — waves of light running across the field.
// ---------------------------------------------------------------------------

function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** One clump of separate blades, unit height (instance scale sets real size). */
function buildClump(blades: number, segs: number, seed: number): THREE.BufferGeometry {
  const rnd = prng(seed)
  const pos: number[] = []
  const nrm: number[] = []
  const hAttr: number[] = []
  const rAttr: number[] = []
  const idx: number[] = []
  for (let b = 0; b < blades; b++) {
    // Root somewhere in the clump's footprint, facing a random way.
    const ra = rnd() * Math.PI * 2
    const rr = Math.sqrt(rnd()) * 0.22
    const rx = Math.cos(ra) * rr
    const rz = Math.sin(ra) * rr
    const face = rnd() * Math.PI * 2
    const fx = Math.cos(face)
    const fz = Math.sin(face)
    // Natural lean/curl: leans outward from the clump centre, curls forward.
    const lean = 0.12 + rnd() * 0.3
    const leanDir = Math.atan2(rz, rx) + (rnd() - 0.5) * 0.8
    const lx = Math.cos(leanDir)
    const lz = Math.sin(leanDir)
    const height = 0.65 + rnd() * 0.4
    const width = 0.06 + rnd() * 0.04
    const bladeRand = rnd()
    const base = pos.length / 3
    for (let s = 0; s <= segs; s++) {
      const t = s / segs
      const w = width * (1 - t * 0.92) * 0.5 // taper to a point
      const bend = lean * t * t // curve grows toward the tip
      const cx = rx + lx * bend * height
      const cz = rz + lz * bend * height
      const cy = t * height * (1 - bend * 0.25)
      // Two vertices across the blade width (perpendicular to its facing);
      // the tip is a single point (one triangle, not a sliver quad).
      for (const side of s === segs ? [0] : [-1, 1]) {
        pos.push(cx - fz * w * side, cy, cz + fx * w * side)
        // Rounded-blade normal: facing normal bent toward the side edge + up,
        // so each blade shades like a slightly cupped leaf, not a flat card.
        const nx = fx * 0.6 - fz * side * 0.5 + lx * 0.3
        const ny = 0.55
        const nz = fz * 0.6 + fx * side * 0.5 + lz * 0.3
        const nl = Math.hypot(nx, ny, nz)
        nrm.push(nx / nl, ny / nl, nz / nl)
        hAttr.push(t)
        rAttr.push(bladeRand)
      }
      if (s < segs - 1) {
        const a = base + s * 2
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
      } else if (s === segs - 1) {
        const a = base + s * 2
        idx.push(a, a + 1, a + 2)
      }
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3))
  g.setAttribute('aH', new THREE.Float32BufferAttribute(hAttr, 1))
  g.setAttribute('aRand', new THREE.Float32BufferAttribute(rAttr, 1))
  g.setIndex(idx)
  g.computeBoundingSphere()
  return g
}

export class Grass {
  /** Near (11 blades × 3 segs) and far (5 × 2) clump geometry — cloned per chunk for ranks. */
  readonly near = buildClump(11, 3, 7)
  readonly far = buildClump(5, 2, 7)
  readonly material: THREE.MeshLambertMaterial
  private uniforms = {
    uTime: { value: 0 },
    uNoise: { value: null as THREE.Texture | null },
    uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.3) },
    uDay: { value: 1 },
  }

  constructor() {
    const noise = new THREE.TextureLoader().load(`${import.meta.env.BASE_URL}perlinnoise.webp`)
    noise.wrapS = noise.wrapT = THREE.RepeatWrapping
    this.uniforms.uNoise.value = noise
    const u = this.uniforms
    this.material = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide })
    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u, { uTrail: trailUniform, uPlayerPos: playerPosUniform })
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          attribute float aH;
          attribute float aRand;
          attribute float aRank;
          uniform float uTime;
          uniform sampler2D uNoise;
          uniform vec3 uPlayerPos;
          varying float vH;
          varying float vRand;
          varying float vGust;
          varying vec3 vGrassW;
          vec3 gWP; // bent world position (projected directly — no per-vertex matrix inverse)
          ${TRAIL_GLSL}`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          {
            vec3 base = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
            vec3 wp = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
            float hb = max(wp.y - base.y, 0.0);

            // Rank fade: density falls smoothly with distance (matches the
            // chunk detail tiers, so tier swaps are invisible).
            float d = distance(base.xz, uPlayerPos.xz);
            // Breakpoints = tier counts / near count (1000, 450, 220 of 2800).
            float dens = d < 45.0 ? 1.0 : d < 96.0 ? mix(1.0, 0.357, (d - 45.0) / 51.0) : d < 144.0 ? mix(0.357, 0.16, (d - 96.0) / 48.0) : mix(0.16, 0.079, clamp((d - 144.0) / 48.0, 0.0, 1.0));
            float keep = 1.0 - smoothstep(dens - 0.05, dens, aRank);

            // Gusts: a scrolling noise field — wind visibly rolls across the meadow.
            vec2 windDir = normalize(vec2(1.0, 0.35));
            float gust = texture2D(uNoise, base.xz * 0.011 - windDir * uTime * 0.045).r;
            gust = smoothstep(0.3, 0.85, gust);
            float sway = 0.18 + gust * 0.85;
            float flutter = sin(uTime * (5.0 + aRand * 3.0) + aRand * 40.0 + dot(base.xz, vec2(0.7, 0.4))) * 0.08;
            vec2 dir = normalize(windDir + vec2(sin(aRand * 6.28), cos(aRand * 6.28)) * 0.25);
            float ang = (sway + flutter) * aH * aH;

            // Contact: lean over where the body passed.
            vec2 push = trailPush(base.xz, 0.6);
            float pl = length(push);
            vec2 bendDir = dir * ang;
            if (pl > 0.001) bendDir = mix(bendDir, push / pl * 1.25 * pl * aH, clamp(pl * 1.4, 0.0, 1.0));
            float bendAmt = length(bendDir);
            vec2 bd = bendAmt > 0.0001 ? bendDir / bendAmt : vec2(0.0);
            // Rotate about the root (keeps blade length — no rubbery stretch).
            wp.xz += bd * sin(bendAmt) * hb;
            wp.y = base.y + (wp.y - base.y) * cos(bendAmt);
            // Apply rank fade by shrinking toward the root.
            wp = base + (wp - base) * keep;

            gWP = wp;
            vH = aH;
            vRand = aRand;
            vGust = gust;
            vGrassW = base;
          }`,
        )
        .replace(
          '#include <project_vertex>',
          `vec4 mvPosition = viewMatrix * vec4(gWP, 1.0);
          gl_Position = projectionMatrix * mvPosition;`,
        )
        .replace(
          '#include <worldpos_vertex>',
          `#include <worldpos_vertex>
          #if defined( USE_ENVMAP ) || defined( DISTANCE ) || defined ( USE_SHADOWMAP ) || defined ( USE_TRANSMISSION ) || NUM_SPOT_LIGHT_COORDS > 0
            worldPosition = vec4(gWP, 1.0);
          #endif`,
        )
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          uniform sampler2D uNoise;
          uniform vec3 uSunDir;
          uniform float uDay;
          varying float vH;
          varying float vRand;
          varying float vGust;
          varying vec3 vGrassW;`,
        )
        .replace(
          'vec4 diffuseColor = vec4( diffuse, opacity );',
          `// Colour patches across the land: lush green / golden dry / olive.
          float patchA = texture2D(uNoise, vGrassW.xz * 0.0035).g;
          float patchB = texture2D(uNoise, vGrassW.xz * 0.009 + 0.37).b;
          vec3 lush = vec3(0.30, 0.62, 0.18);
          vec3 golden = vec3(0.72, 0.68, 0.30);
          vec3 olive = vec3(0.38, 0.48, 0.20);
          vec3 tipC = mix(lush, golden, smoothstep(0.55, 0.8, patchA));
          tipC = mix(tipC, olive, smoothstep(0.6, 0.85, patchB) * 0.7);
          tipC *= 0.85 + vRand * 0.3;
          tipC = mix(tipC, golden * 1.1, step(0.93, vRand) * 0.6); // the odd dry blade
          vec3 rootC = vec3(0.16, 0.29, 0.1);
          vec3 col = mix(rootC, tipC, smoothstep(0.0, 0.85, vH));
          vec4 diffuseColor = vec4( col, opacity );`,
        )
        .replace(
          '#include <opaque_fragment>',
          `{
            // Sun through the blades (backlit tips glow) + gust sheen: bent
            // blades flash lighter, so gusts read as waves of light.
            vec3 V = normalize(vViewPosition);
            float back = pow(clamp(dot(-V, normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz)), 0.0, 1.0), 3.0);
            outgoingLight += vec3(0.85, 0.95, 0.45) * back * vH * vH * 0.55 * uDay;
            outgoingLight *= 1.0 + vGust * vH * 0.35 * uDay;
          }
          #include <opaque_fragment>`,
        )
    }
  }

  update(time: number, sunDir?: THREE.Vector3, day = 1): void {
    this.uniforms.uTime.value = time
    if (sunDir) this.uniforms.uSunDir.value.copy(sunDir)
    this.uniforms.uDay.value = day
  }
}
