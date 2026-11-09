import * as THREE from 'three'
import { groundHeight } from './terrain'
import { atlasCard, flowerAtlas } from './foliage'

// ---------------------------------------------------------------------------
// Ambient life around the player (everything wraps in a box that follows you):
//   • light motes — glowing, size-varied, softly twinkling pollen by day and
//     slow-blinking fireflies by night (one additive point draw)
//   • butterflies — painted, hinged wings that actually flap, bobbing flight
//   • drifting petals + leaves — tumbling on the wind, using the same painted
//     flower atlas as the meadow (two instanced draws)
// ---------------------------------------------------------------------------

const MOTES = 220
const BOX = 30
const PETALS = 44
const LEAVES = 22
const WIND = new THREE.Vector2(1, 0.35).normalize()

/** Painted butterfly wing (forewing + hindwing), white so a tint colours it. */
function wingTexture(): THREE.Texture {
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 256
  const ctx = c.getContext('2d')!
  ctx.translate(8, 128) // hinge on the left edge, wing spreads right
  const wing = (path: () => void, fill: CanvasGradient | string) => {
    ctx.beginPath()
    path()
    ctx.fillStyle = fill
    ctx.fill()
  }
  const fore = () => {
    ctx.moveTo(0, -6)
    ctx.bezierCurveTo(60, -120, 200, -125, 232, -70)
    ctx.bezierCurveTo(240, -35, 170, -6, 0, 4)
  }
  const hind = () => {
    ctx.moveTo(0, 0)
    ctx.bezierCurveTo(120, 4, 200, 40, 170, 100)
    ctx.bezierCurveTo(130, 130, 40, 80, 0, 10)
  }
  const g = ctx.createRadialGradient(0, 0, 10, 0, 0, 240)
  g.addColorStop(0, 'rgb(225,225,225)')
  g.addColorStop(0.55, 'rgb(255,255,255)')
  g.addColorStop(1, 'rgb(240,240,240)')
  wing(fore, g)
  wing(hind, g)
  // Dark border band + vein lines + eye spots — reads as a real butterfly.
  ctx.save()
  ctx.lineWidth = 12
  ctx.strokeStyle = 'rgba(40,30,30,0.85)'
  ctx.beginPath()
  fore()
  ctx.stroke()
  ctx.beginPath()
  hind()
  ctx.stroke()
  ctx.restore()
  ctx.strokeStyle = 'rgba(60,50,50,0.4)'
  ctx.lineWidth = 2
  for (const [x, y] of [[200, -95], [215, -60], [150, -20], [160, 70], [120, 95]]) {
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.quadraticCurveTo(x * 0.5, y * 0.3, x, y)
    ctx.stroke()
  }
  ctx.fillStyle = 'rgba(30,25,25,0.9)'
  ctx.beginPath()
  ctx.arc(175, -70, 13, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = 'rgba(255,255,255,0.95)'
  ctx.beginPath()
  ctx.arc(175, -70, 6, 0, Math.PI * 2)
  ctx.fill()
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

interface Butterfly {
  group: THREE.Group
  wingL: THREE.Mesh
  wingR: THREE.Mesh
  pos: THREE.Vector3
  vel: THREE.Vector3
  target: THREE.Vector3
  phase: number
  speed: number
}

interface Drifter {
  pos: THREE.Vector3
  rot: THREE.Euler
  spin: THREE.Vector3
  phase: number
  fall: number
}

const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _s = new THREE.Vector3(1, 1, 1)
const _to = new THREE.Vector3()

export class Ambience {
  readonly motes: THREE.Points
  private motePos: Float32Array
  private moteDrift: Float32Array
  private moteMat: THREE.ShaderMaterial
  private butterflies: Butterfly[] = []
  private petals: THREE.InstancedMesh
  private leaves: THREE.InstancedMesh
  private drifters: Drifter[] = []
  private t = 0
  private rnd: () => number

  constructor(scene: THREE.Scene) {
    let seed = 4242
    this.rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    const rnd = this.rnd

    // -- Motes ----------------------------------------------------------------
    this.motePos = new Float32Array(MOTES * 3)
    this.moteDrift = new Float32Array(MOTES * 2)
    const sizes = new Float32Array(MOTES)
    const phases = new Float32Array(MOTES)
    for (let i = 0; i < MOTES; i++) {
      this.motePos[i * 3] = (rnd() * 2 - 1) * BOX
      this.motePos[i * 3 + 1] = rnd() * 3.5 + 0.3
      this.motePos[i * 3 + 2] = (rnd() * 2 - 1) * BOX
      this.moteDrift[i * 2] = 0.2 + rnd() * 0.5
      this.moteDrift[i * 2 + 1] = rnd() * Math.PI * 2
      sizes[i] = 0.035 + Math.pow(rnd(), 2.5) * 0.11 // mostly tiny, a few big soft ones
      phases[i] = rnd() * Math.PI * 2
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(this.motePos, 3))
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1))
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1))
    this.moteMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(1, 0.93, 0.7) },
        uOpacity: { value: 0.5 },
        uBlink: { value: 1.7 },
        uScale: { value: 300 },
      },
      vertexShader: /* glsl */ `
        attribute float aSize;
        attribute float aPhase;
        uniform float uTime;
        uniform float uBlink;
        uniform float uScale;
        varying float vTwinkle;
        void main() {
          vTwinkle = 0.5 + 0.5 * sin(uTime * uBlink + aPhase);
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uScale / max(-mvPosition.z, 0.1);
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uOpacity;
        varying float vTwinkle;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float r2 = dot(c, c) * 4.0;
          if (r2 > 1.0) discard;
          // Bright core + wide soft halo: a glowing mote, not a dot.
          float glow = exp(-r2 * 9.0) + exp(-r2 * 2.2) * 0.35;
          gl_FragColor = vec4(uColor * glow * uOpacity * (0.35 + 0.65 * vTwinkle), 1.0);
        }
      `,
    })
    this.motes = new THREE.Points(geo, this.moteMat)
    this.motes.frustumCulled = false
    scene.add(this.motes)

    // -- Butterflies -------------------------------------------------------------
    const wingTex = wingTexture()
    const wingGeo = new THREE.PlaneGeometry(0.2, 0.2)
    wingGeo.rotateX(-Math.PI / 2)
    wingGeo.translate(0.1, 0, 0) // hinge at the body
    const bodyGeo = new THREE.CapsuleGeometry(0.012, 0.09, 4, 8)
    bodyGeo.rotateX(Math.PI / 2)
    const bodyMat = new THREE.MeshLambertMaterial({ color: 0x2a2220 })
    const tints = [0xffb45e, 0xfff6e8, 0x8ec9ff, 0xff9ec4, 0xffe066, 0xb8f0c0]
    for (let i = 0; i < 9; i++) {
      const mat = new THREE.MeshLambertMaterial({ map: wingTex, color: tints[i % tints.length], alphaTest: 0.4, side: THREE.DoubleSide })
      const group = new THREE.Group()
      const wingL = new THREE.Mesh(wingGeo, mat)
      const wingR = new THREE.Mesh(wingGeo, mat)
      wingR.scale.x = -1
      group.add(wingL, wingR, new THREE.Mesh(bodyGeo, bodyMat))
      group.scale.setScalar(0.9 + rnd() * 0.5)
      const a = (i / 9) * Math.PI * 2
      const pos = new THREE.Vector3(Math.cos(a) * 8, 1.2, Math.sin(a) * 8)
      this.butterflies.push({ group, wingL, wingR, pos, vel: new THREE.Vector3(), target: pos.clone(), phase: rnd() * 6.28, speed: 1.1 + rnd() * 0.8 })
      scene.add(group)
    }

    // -- Drifting petals + leaves (painted flower atlas) -------------------------
    const atlas = flowerAtlas()
    // Unlit pastel: petals catch the light from any side (lit, they turned to
    // dark specks whenever they were back-lit against the sky).
    const petalMat = new THREE.MeshBasicMaterial({ map: atlas, alphaTest: 0.45, side: THREE.DoubleSide })
    this.petals = new THREE.InstancedMesh(atlasCard(1, 0.09, 0.09, 0.25), petalMat, PETALS)
    this.leaves = new THREE.InstancedMesh(atlasCard(3, 0.075, 0.15, 0.2), petalMat, LEAVES)
    const petalTints = [0xffc6dc, 0xfff6ee, 0xffe08a, 0xf7a8c8]
    const leafTints = [0x8fc45a, 0xc9b84a, 0x6fae4c]
    const c = new THREE.Color()
    for (let i = 0; i < PETALS + LEAVES; i++) {
      this.drifters.push({
        pos: new THREE.Vector3((rnd() * 2 - 1) * BOX, rnd() * 8, 8 + (rnd() * 2 - 1) * BOX),
        rot: new THREE.Euler(rnd() * 6, rnd() * 6, rnd() * 6),
        spin: new THREE.Vector3((rnd() - 0.5) * 3, (rnd() - 0.5) * 3, (rnd() - 0.5) * 3),
        phase: rnd() * 6.28,
        fall: 0.18 + rnd() * 0.25,
      })
      if (i < PETALS) this.petals.setColorAt(i, c.set(petalTints[i % petalTints.length]))
      else this.leaves.setColorAt(i - PETALS, c.set(leafTints[i % leafTints.length]))
    }
    for (const im of [this.petals, this.leaves]) {
      im.frustumCulled = false
      im.castShadow = false
      scene.add(im)
    }
  }

  /** Keep point sizes consistent across resolutions (call on resize). */
  setViewportHeight(h: number): void {
    this.moteMat.uniforms.uScale.value = h * 0.42
  }

  update(dt: number, playerPos: THREE.Vector3, day: number): void {
    this.t += dt
    this.updateMotes(playerPos, day)
    this.updateButterflies(dt, playerPos, day)
    this.updateDrifters(dt, playerPos, day)
  }

  private updateMotes(playerPos: THREE.Vector3, day: number): void {
    const t = this.t
    const px = playerPos.x
    const pz = playerPos.z
    for (let i = 0; i < MOTES; i++) {
      const ix = i * 3
      let x = this.motePos[ix]
      let z = this.motePos[ix + 2]
      const sp = this.moteDrift[i * 2]
      const ph = this.moteDrift[i * 2 + 1]
      x += (0.55 * sp + Math.sin(t * 0.7 + ph) * 0.25) * 0.016
      z += (0.35 * sp + Math.cos(t * 0.5 + ph) * 0.2) * 0.016
      const dx = x - px
      const dz = z - pz
      if (dx > BOX) x -= BOX * 2
      if (dx < -BOX) x += BOX * 2
      if (dz > BOX) z -= BOX * 2
      if (dz < -BOX) z += BOX * 2
      const y = groundHeight(x, z) + 0.4 + (ph % 1) * 3.0 + Math.sin(t * 0.9 + ph * 2) * 0.25
      this.motePos[ix] = x
      this.motePos[ix + 1] = y
      this.motePos[ix + 2] = z
    }
    this.motes.geometry.getAttribute('position').needsUpdate = true
    // Daylight: warm golden pollen. Night: green-gold fireflies, brighter, slow blink.
    const u = this.moteMat.uniforms
    u.uTime.value = t
    const night = 1 - THREE.MathUtils.smoothstep(day, 0.2, 0.45)
    ;(u.uColor.value as THREE.Color).setRGB(1, 0.93, 0.7).lerp(_nightMote, night)
    u.uOpacity.value = THREE.MathUtils.lerp(0.45, 2.0, night)
    u.uBlink.value = THREE.MathUtils.lerp(1.7, 0.9, night)
  }

  private updateButterflies(dt: number, playerPos: THREE.Vector3, day: number): void {
    const visible = day > 0.3 // they roost at night
    for (const b of this.butterflies) {
      b.group.visible = visible
      if (!visible) continue
      _to.copy(b.target).sub(b.pos)
      if (_to.length() < 0.8 || Math.random() < dt * 0.12) {
        // New wander target near the player (keeps the meadow alive).
        const a = Math.random() * Math.PI * 2
        const r = 4 + Math.random() * 18
        const nx = playerPos.x + Math.cos(a) * r
        const nz = playerPos.z + Math.sin(a) * r
        b.target.set(nx, groundHeight(nx, nz) + 0.8 + Math.random() * 1.2, nz)
      }
      // Smooth steering + fluttery bob (not a straight-line glide).
      _to.normalize().multiplyScalar(b.speed)
      b.vel.lerp(_to, 1 - Math.exp(-dt * 1.6))
      b.phase += dt * (13 + b.speed * 3)
      b.pos.addScaledVector(b.vel, dt)
      b.pos.y += Math.sin(b.phase * 0.5) * 0.35 * dt * 3
      const g = groundHeight(b.pos.x, b.pos.z)
      if (b.pos.y < g + 0.4) b.pos.y = g + 0.4
      b.group.position.copy(b.pos)
      b.group.rotation.y = Math.atan2(b.vel.x, b.vel.z)
      // Hinged flap: wings rotate about the body, fast up-stroke, slower glide.
      const flap = 0.15 + 1.05 * Math.pow(Math.abs(Math.sin(b.phase)), 0.7)
      b.wingL.rotation.z = flap
      b.wingR.rotation.z = -flap
    }
  }

  private updateDrifters(dt: number, playerPos: THREE.Vector3, day: number): void {
    const gust = 1.2 + Math.sin(this.t * 0.31) * 0.6
    const show = day > 0.25
    this.petals.visible = show
    this.leaves.visible = show
    if (!show) return
    for (let i = 0; i < this.drifters.length; i++) {
      const d = this.drifters[i]
      d.phase += dt
      d.pos.x += (WIND.x * gust + Math.sin(d.phase * 1.3) * 0.4) * dt
      d.pos.z += (WIND.y * gust + Math.cos(d.phase * 1.1) * 0.4) * dt
      d.pos.y -= (d.fall + Math.sin(d.phase * 2.2) * 0.15) * dt
      d.rot.x += d.spin.x * dt
      d.rot.y += d.spin.y * dt
      d.rot.z += d.spin.z * dt
      // World-anchored, wrapping around the player like the motes; y is
      // height above the local ground. Respawn high and upwind on landing.
      if (d.pos.x - playerPos.x > BOX) d.pos.x -= BOX * 2
      if (d.pos.x - playerPos.x < -BOX) d.pos.x += BOX * 2
      if (d.pos.z - playerPos.z > BOX) d.pos.z -= BOX * 2
      if (d.pos.z - playerPos.z < -BOX) d.pos.z += BOX * 2
      if (d.pos.y < 0.05) {
        d.pos.set(playerPos.x - WIND.x * BOX * 0.6 + (Math.random() - 0.5) * BOX, 4 + Math.random() * 5, playerPos.z - WIND.y * BOX * 0.6 + (Math.random() - 0.5) * BOX * 1.6)
      }
      _q.setFromEuler(d.rot)
      _m.compose(_to.set(d.pos.x, groundHeight(d.pos.x, d.pos.z) + d.pos.y, d.pos.z), _q, _s)
      if (i < PETALS) this.petals.setMatrixAt(i, _m)
      else this.leaves.setMatrixAt(i - PETALS, _m)
    }
    this.petals.instanceMatrix.needsUpdate = true
    this.leaves.instanceMatrix.needsUpdate = true
  }
}

const _nightMote = new THREE.Color(0.75, 1, 0.45)
