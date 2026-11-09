import * as THREE from 'three'
import { WATER_Y } from './water'

// Pooled puffs for footfalls, landings and splashes — zero allocation after
// init (preallocated ring buffer). Each puff grows and fades as it ages
// (custom point shader with a soft analytic falloff), and is tinted by where
// it was spawned: warm earthy haze on land, white spray on water.

const MAX = 120

export class DustPool {
  readonly points: THREE.Points
  private pos: Float32Array
  private vel: Float32Array
  private life: Float32Array
  private maxLife: Float32Array
  private age: Float32Array // 0 = just born … 1 = gone (shader attribute)
  private col: Float32Array
  private size: Float32Array
  private head = 0

  constructor() {
    this.pos = new Float32Array(MAX * 3)
    this.vel = new Float32Array(MAX * 3)
    this.life = new Float32Array(MAX)
    this.maxLife = new Float32Array(MAX).fill(1)
    this.age = new Float32Array(MAX).fill(1)
    this.col = new Float32Array(MAX * 3)
    this.size = new Float32Array(MAX)
    for (let i = 0; i < MAX; i++) this.pos[i * 3 + 1] = -100 // parked underground, invisible
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3))
    geo.setAttribute('aAge', new THREE.BufferAttribute(this.age, 1))
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3))
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1))
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      fog: true,
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uScale: { value: 300 } }]),
      vertexShader: /* glsl */ `
        #include <common>
        #include <fog_pars_vertex>
        attribute float aAge;
        attribute vec3 aColor;
        attribute float aSize;
        uniform float uScale;
        varying float vAge;
        varying vec3 vColor;
        void main() {
          vAge = aAge;
          vColor = aColor;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          // Puffs swell as they age.
          gl_PointSize = aSize * (0.6 + aAge * 1.8) * uScale / max(-mvPosition.z, 0.1);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }
      `,
      fragmentShader: /* glsl */ `
        #include <common>
        #include <fog_pars_fragment>
        varying float vAge;
        varying vec3 vColor;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float r2 = dot(c, c) * 4.0;
          if (r2 > 1.0 || vAge >= 1.0) discard;
          float soft = exp(-r2 * 3.0) * (1.0 - r2);
          float a = soft * pow(1.0 - vAge, 1.6) * 0.55;
          gl_FragColor = vec4(vColor, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }
      `,
    })
    this.points = new THREE.Points(geo, mat)
    this.points.frustumCulled = false
  }

  /** Keep point sizes consistent across resolutions (call on resize). */
  setViewportHeight(h: number): void {
    ;(this.points.material as THREE.ShaderMaterial).uniforms.uScale.value = h * 0.42
  }

  burst(x: number, y: number, z: number, n: number): void {
    const water = y < WATER_Y + 0.12
    for (let k = 0; k < n; k++) {
      const i = this.head
      this.head = (this.head + 1) % MAX
      const a = Math.random() * Math.PI * 2
      const sp = (water ? 0.9 : 0.5) + Math.random() * 1.1
      this.pos[i * 3] = x + Math.cos(a) * 0.15
      this.pos[i * 3 + 1] = y + 0.05 + Math.random() * 0.1
      this.pos[i * 3 + 2] = z + Math.sin(a) * 0.15
      this.vel[i * 3] = Math.cos(a) * sp
      this.vel[i * 3 + 1] = (water ? 1.6 : 0.6) + Math.random() * 1.0
      this.vel[i * 3 + 2] = Math.sin(a) * sp
      const life = (water ? 0.5 : 0.7) + Math.random() * 0.45
      this.life[i] = life
      this.maxLife[i] = life
      this.size[i] = water ? 0.11 + Math.random() * 0.07 : 0.2 + Math.random() * 0.16
      if (water) this.col.set([0.92, 0.97, 1.0], i * 3)
      else this.col.set([0.86 + Math.random() * 0.06, 0.8, 0.66], i * 3) // warm sun-lit dust
    }
    this.points.geometry.getAttribute('aColor').needsUpdate = true
    this.points.geometry.getAttribute('aSize').needsUpdate = true
  }

  update(dt: number): void {
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) continue
      this.life[i] -= dt
      if (this.life[i] <= 0) {
        this.pos[i * 3 + 1] = -100
        this.age[i] = 1
        continue
      }
      this.age[i] = 1 - this.life[i] / this.maxLife[i]
      this.pos[i * 3] += this.vel[i * 3] * dt
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt
      this.vel[i * 3 + 1] -= 1.6 * dt
      this.vel[i * 3] *= 1 - 2.6 * dt
      this.vel[i * 3 + 2] *= 1 - 2.6 * dt
    }
    this.points.geometry.getAttribute('position').needsUpdate = true
    this.points.geometry.getAttribute('aAge').needsUpdate = true
  }
}
