import * as THREE from 'three'
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js'

// ---------------------------------------------------------------------------
// Live ripples — a small heightfield wave simulation around the player, the
// approach of Evan Wallace's "WebGL Water" and three.js's GPGPU water demo.
// Each texel holds (height, velocity, foam). Every step a texel accelerates
// toward the average of its neighbours (the wave equation), so disturbances
// spread as real rings, interfere, and bounce off the shoreline (texels on
// land are pinned to zero). The swimming cat pushes the surface down as it
// moves, which leaves a proper wake; rain drops dimple it. Fast-moving water
// churns up foam, which lingers and slowly fades — the wake's white trail.
//
// 256² texels over 40 m (~16 cm each), re-centred on the player in whole
// texels so nothing swims. The water shader reads it for normals, a little
// height and wake foam.
// ---------------------------------------------------------------------------

const SIZE = 256
const SPAN = 40
const TEXEL = SPAN / SIZE
const MAX_DROPS = 8
const STEP = 1 / 60

export class RippleSim {
  /** For the water shader: the current state and its world rect (x0, z0, span). */
  readonly uniforms = {
    uRipple: { value: null as THREE.Texture | null },
    uRippleRect: { value: new THREE.Vector3(0, 0, SPAN) },
  }
  private rt: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget]
  private cur = 0
  private mat: THREE.ShaderMaterial
  private quad: FullScreenQuad
  private origin = new THREE.Vector2(NaN, NaN) // world xz of texel (0,0)
  private drops: THREE.Vector4[] = Array.from({ length: MAX_DROPS }, () => new THREE.Vector4())
  private nDrops = 0
  private acc = 0

  constructor(heightTex: THREE.Texture, heightRect: { value: THREE.Vector4 }, waterY: number) {
    const mk = () =>
      new THREE.WebGLRenderTarget(SIZE, SIZE, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
      })
    this.rt = [mk(), mk()]
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uPrev: { value: null },
        uShift: { value: new THREE.Vector2() },
        uOrigin: { value: new THREE.Vector2() },
        uDrops: { value: this.drops },
        uNDrops: { value: 0 },
        uHeight: { value: heightTex },
        uHeightRect: heightRect,
      },
      vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uPrev;
        uniform vec2 uShift;   // whole-texel scroll since the last step
        uniform vec2 uOrigin;  // world xz of uv (0,0)
        uniform vec4 uDrops[${MAX_DROPS}]; // world x, z, radius (m), depth (m)
        uniform int uNDrops;
        uniform sampler2D uHeight;
        uniform vec4 uHeightRect;
        varying vec2 vUv;
        const float T = ${(1 / SIZE).toFixed(8)};

        vec4 S(vec2 uv) {
          uv += uShift * T;
          if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec4(0.0);
          return texture2D(uPrev, uv);
        }
        void main() {
          vec4 c = S(vUv);
          vec4 l = S(vUv - vec2(T, 0.0)), r = S(vUv + vec2(T, 0.0));
          vec4 d = S(vUv - vec2(0.0, T)), u = S(vUv + vec2(0.0, T));
          float avg = (l.r + r.r + d.r + u.r) * 0.25;
          // Wave equation (k sets the ripple speed: ~1.5 m/s).
          c.g += (avg - c.r) * 0.55;
          c.g *= 0.985;
          c.r += c.g;
          c.r *= 0.997;
          vec2 w = uOrigin + vUv * ${SPAN.toFixed(1)};
          for (int i = 0; i < ${MAX_DROPS}; i++) {
            if (i >= uNDrops) break;
            float q = length(w - uDrops[i].xy) / uDrops[i].z;
            if (q < 1.0) c.r -= (cos(q * 3.14159) * 0.5 + 0.5) * uDrops[i].w;
          }
          // Foam: churned where the water moves fast, then drifts apart and fades.
          float fb = (l.b + r.b + d.b + u.b) * 0.25;
          c.b = max(mix(c.b, fb, 0.2) * 0.993, smoothstep(0.012, 0.04, abs(c.g)));
          // Land pins the surface: ripples reflect off the shore.
          vec2 huv = (w - uHeightRect.xy) / uHeightRect.z;
          if (uHeightRect.w > 0.5 && all(greaterThan(huv, vec2(0.0))) && all(lessThan(huv, vec2(1.0)))) {
            float depth = ${waterY.toFixed(3)} - texture2D(uHeight, huv).r;
            if (depth < 0.02) c.rg = vec2(0.0);
          }
          // Soak up energy near the edge of the simulated patch (no echo off it).
          vec2 e = min(vUv, 1.0 - vUv);
          float edge = smoothstep(0.0, 0.08, min(e.x, e.y));
          c.rg *= mix(0.9, 1.0, edge);
          gl_FragColor = c;
        }
      `,
      depthTest: false,
      depthWrite: false,
    })
    this.quad = new FullScreenQuad(this.mat)
  }

  /** Push the surface down at (x, z): `radius` metres wide, `depth` metres deep. */
  disturb(x: number, z: number, radius: number, depth: number): void {
    if (this.nDrops >= MAX_DROPS) return
    this.drops[this.nDrops++].set(x, z, radius, depth)
  }

  update(renderer: THREE.WebGLRenderer, dt: number, center: THREE.Vector3): void {
    // Re-centre in whole texels once the player drifts 5 m from the middle.
    const ox = Math.round((center.x - SPAN / 2) / TEXEL) * TEXEL
    const oz = Math.round((center.z - SPAN / 2) / TEXEL) * TEXEL
    let shiftX = 0
    let shiftZ = 0
    if (Number.isNaN(this.origin.x) || Math.hypot(ox - this.origin.x, oz - this.origin.y) > 5) {
      if (!Number.isNaN(this.origin.x)) {
        shiftX = Math.round((ox - this.origin.x) / TEXEL)
        shiftZ = Math.round((oz - this.origin.y) / TEXEL)
        if (Math.abs(shiftX) > SIZE || Math.abs(shiftZ) > SIZE) shiftX = shiftZ = SIZE * 2 // teleport: start clean
      }
      this.origin.set(ox, oz)
    }
    this.acc = Math.min(this.acc + dt, STEP * 3)
    const u = this.mat.uniforms
    const prevTarget = renderer.getRenderTarget()
    let first = true
    while (this.acc >= STEP) {
      this.acc -= STEP
      u.uPrev.value = this.rt[this.cur].texture
      u.uShift.value.set(first ? shiftX : 0, first ? shiftZ : 0)
      u.uOrigin.value.copy(this.origin)
      u.uNDrops.value = first ? this.nDrops : 0
      this.cur ^= 1
      renderer.setRenderTarget(this.rt[this.cur])
      this.quad.render(renderer)
      first = false
    }
    if (!first) this.nDrops = 0
    renderer.setRenderTarget(prevTarget)
    this.uniforms.uRipple.value = this.rt[this.cur].texture
    this.uniforms.uRippleRect.value.set(this.origin.x, this.origin.y, SPAN)
  }
}
