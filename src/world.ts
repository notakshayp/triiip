import * as THREE from 'three'
import { Lensflare, LensflareElement } from 'three/addons/objects/Lensflare.js'
import { buildSittables, groundHeight, type Sittable, type TrunkCollider } from './terrain'
import { DustPool } from './fx'
import { buildSkyMaterial } from './sky'
import { ChunkManager } from './chunks'
import { Grass } from './grass'
import { GhibliWater } from './water'
import { Ambience } from './ambience'
import { Weather } from './weather'
import { FarTerrain } from './farlod'
import type { DayNightRig, DayNight } from './daynight'

// Scene assembly: infinite grassland + base sit spots + water + sun/moon.

const _sunDir = new THREE.Vector3()
const _solarDir = new THREE.Vector3()
const _moonDir = new THREE.Vector3()

export class World {
  readonly scene = new THREE.Scene()
  /** Drawn after the opaque scene by WaterPass: the water + transparent effects that sit on it. */
  readonly overlay = new THREE.Scene()
  readonly sittables: Sittable[]
  /** Kept for the player API (no trees anymore → always empty). */
  readonly trunkColliders: TrunkCollider[] = []
  readonly dust = new DustPool()
  readonly water = new GhibliWater(groundHeight)
  readonly ambience: Ambience
  readonly weather = new Weather()
  readonly far = new FarTerrain()
  readonly grass = new Grass()
  readonly skyMat: THREE.ShaderMaterial
  readonly sunFlare: THREE.Object3D
  readonly sun: THREE.DirectionalLight
  readonly hemi: THREE.HemisphereLight
  readonly stars: THREE.Points
  readonly moonSprite: THREE.Sprite
  private skyMesh!: THREE.Mesh
  private readonly chunks: ChunkManager
  private shadowCam: THREE.OrthographicCamera

  constructor() {
    this.scene.background = new THREE.Color(0xbfe3ff)

    // Ghibli gradient sky dome (art-directed, always saturated — no washed-out zenith).
    // Colours are driven from DayNight each frame (day → dusk → night blends).
    this.skyMat = buildSkyMaterial()
    this.skyMesh = new THREE.Mesh(new THREE.SphereGeometry(260, 24, 16), this.skyMat)
    this.skyMesh.frustumCulled = false
    // Drawn after opaque geometry at the far plane (see sky.ts) — the cloud
    // ray-march only runs on pixels where sky is actually visible.
    this.skyMesh.renderOrder = 10
    this.scene.add(this.skyMesh)
    this.scene.fog = new THREE.Fog(0xbfe3ff, 60, 900)

    // Lens flare carried on a far object in the sun's direction.
    this.sunFlare = new THREE.Object3D()
    const flareTex = (path: string) => new THREE.TextureLoader().load(path)
    const lensflare = new Lensflare()
    lensflare.addElement(new LensflareElement(flareTex(`${import.meta.env.BASE_URL}lensflare0.png`), 110, 0, new THREE.Color(0xfff4d6)))
    lensflare.addElement(new LensflareElement(flareTex(`${import.meta.env.BASE_URL}lensflare3.png`), 18, 0.62))
    lensflare.addElement(new LensflareElement(flareTex(`${import.meta.env.BASE_URL}lensflare3.png`), 24, 0.74))
    lensflare.addElement(new LensflareElement(flareTex(`${import.meta.env.BASE_URL}lensflare3.png`), 42, 0.9))
    this.sunFlare.add(lensflare)
    this.scene.add(this.sunFlare)

    this.hemi = new THREE.HemisphereLight(0xd8ecff, 0x6b7f5a, 1.0)
    this.scene.add(this.hemi)

    this.sun = new THREE.DirectionalLight(0xfff2d9, 2.4)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(1536, 1536)
    this.sun.shadow.bias = -0.00035
    this.sun.shadow.normalBias = 0.03
    // Lighter shadows: soft, airy shade rather than hard dark cut-outs.
    this.sun.shadow.intensity = 0.72
    this.shadowCam = this.sun.shadow.camera
    this.shadowCam.near = 1
    this.shadowCam.far = 140
    this.shadowCam.left = -16
    this.shadowCam.right = 16
    this.shadowCam.top = 16
    this.shadowCam.bottom = -16
    this.scene.add(this.sun)
    this.scene.add(this.sun.target)

    // Base sit spots (rock / log / stumps / crate) around the spawn meadow.
    const { group, sittables } = buildSittables()
    this.sittables = sittables
    this.scene.add(group)

    // Infinite grassland streams around the player (shares the registries).
    this.chunks = new ChunkManager(this.scene, this.sittables, this.trunkColliders, sittables, this.grass)

    // Pre-hydrate spawn chunks synchronously so the first frame has land
    // (no sky holes on boot, no streaming hitch on frame 1).
    {
      const spawn = new THREE.Vector3(0, 0, 8)
      spawn.y = groundHeight(spawn.x, spawn.z)
      this.chunks.prehydrate(spawn, 1)
    }

    this.water.bindSky(this.skyMat.uniforms.topColor.value as THREE.Color, this.skyMat.uniforms.horizonColor.value as THREE.Color)
    this.overlay.add(this.water.mesh)

    // Moon disc (sun comes from the Sky shader + lensflare).
    this.moonSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: makeMoonTexture(), transparent: true, depthWrite: false, fog: false }))
    this.moonSprite.scale.set(26, 26, 1)
    this.scene.add(this.moonSprite)

    this.stars = buildStars()
    this.scene.add(this.stars)
    this.ambience = new Ambience(this.scene)
    this.overlay.fog = this.scene.fog
    this.overlay.add(this.ambience.motes)
    this.overlay.add(this.dust.points)
    this.overlay.add(this.weather.rain)
    this.scene.add(this.far.mesh)
  }

  dayNightRig(): DayNightRig {
    return { scene: this.scene, sun: this.sun, hemi: this.hemi, stars: this.stars }
  }

  /** Share of grass drawn (adaptive quality). */
  setGrassDensity(f: number): void {
    this.chunks.setGrassDensity(f)
  }

  /** Burst-load around a teleport target (biome switcher) so landing isn't a hole in the sky. */
  prehydrateAround(pos: THREE.Vector3): void {
    this.chunks.prehydrate(pos, 1)
  }

  update(dt: number, playerPos: THREE.Vector3, camPos: THREE.Vector3, dayNight: DayNight, playerVel?: THREE.Vector3): void {
    this.dust.update(dt)
    dayNight.sunDirection(_sunDir)
    this.chunks.update(dt, playerPos, playerVel, _sunDir, dayNight.dayFactor)
    // Keep sky, stars and the lens flare centered on/through the camera.
    this.skyMesh.position.copy(camPos)
    const sky = this.skyMat.uniforms
    sky.uTime.value += dt
    ;(sky.uCamPos.value as THREE.Vector3).copy(camPos)
    // Weather thickens + darkens the cloud deck; clear days keep fair-weather cumulus.
    sky.uCover.value = 0.47 + this.weather.cloudCover * 0.35
    sky.uStorm.value = this.weather.intensity
    sky.uDay.value = dayNight.dayFactor
    ;(sky.uSunCol.value as THREE.Color).copy(this.sun.color).multiplyScalar(THREE.MathUtils.clamp(this.sun.intensity / 2.0, 0.12, 1.2))
    this.stars.position.copy(camPos)
    this.water.update(dt, playerPos, _sunDir, this.sun.color, this.sun.intensity, dayNight.dayFactor)
    this.ambience.update(dt, playerPos, dayNight.dayFactor)
    this.weather.update(dt, playerPos, groundHeight(playerPos.x, playerPos.z))
    this.far.update(playerPos)
    this.far.setLight(dayNight.dayFactor, this.weather.cloudCover)
    this.updateCelestial(playerPos, dayNight, camPos)
    // Texel-snapped shadow frustum following the player.
    const sx = Math.round(playerPos.x * 2) / 2
    const sz = Math.round(playerPos.z * 2) / 2
    this.sun.target.position.set(sx, 0, sz)
    // Keep light direction while moving the shadow anchor.
    if (this.sun.position.y > 1) {
      const ox = this.sun.position.x - this.sun.target.position.x
      const oz = this.sun.position.z - this.sun.target.position.z
      this.sun.position.set(sx + ox, this.sun.position.y, sz + oz)
    }
  }

  /** Sky gradient + lens flare follow the sun; moon rides its own arc. */
  private updateCelestial(playerPos: THREE.Vector3, dayNight: DayNight, camPos: THREE.Vector3): void {
    const hours = dayNight.currentHours()
    const dayP = (hours - 6) / 12
    const inDay = dayP >= 0 && dayP <= 1
    const el = inDay ? Math.sin(dayP * Math.PI) : 0 // sun elevation

    // Ghibli gradient zones: top / horizon / sun halo.
    const c = dayNight.skyColors()
    const skyU = this.skyMat.uniforms
    ;(skyU.topColor.value as THREE.Color).copy(c.top)
    ;(skyU.horizonColor.value as THREE.Color).copy(c.horizon)
    ;(skyU.sunGlowColor.value as THREE.Color).copy(c.sunGlow)
    dayNight.solarPosition(_solarDir)
    ;(skyU.sunDirection.value as THREE.Vector3).copy(_solarDir)

    // Lens flare rides the camera toward the sun (hidden below horizon).
    this.sunFlare.position.copy(camPos).addScaledVector(_solarDir, 400)
    this.sunFlare.visible = el > -0.06

    // Moon on the opposite arc.
    dayNight.moonPosition(_moonDir)
    this.moonSprite.position.set(
      playerPos.x + _moonDir.x * 440,
      Math.max(playerPos.y + 12, _moonDir.y * 430),
      playerPos.z + _moonDir.z * 440,
    )
    const moonMat = this.moonSprite.material as THREE.SpriteMaterial
    const mh = (hours + 12) % 24
    const mP = (mh - 6) / 12
    moonMat.opacity = Math.max(0, mP >= 0 && mP <= 1 ? Math.sin(mP * Math.PI) : 0)
  }
}

function makeMoonTexture(): THREE.Texture {
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 256
  const ctx = c.getContext('2d')!
  // Disc.
  const g = ctx.createRadialGradient(110, 110, 30, 128, 128, 80)
  g.addColorStop(0, '#fdfdf4')
  g.addColorStop(0.85, '#e8e4d0')
  g.addColorStop(1, 'rgba(230, 225, 200, 0)')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(128, 128, 78, 0, Math.PI * 2)
  ctx.fill()
  // Craters.
  ctx.fillStyle = 'rgba(160, 155, 130, 0.35)'
  const craters: Array<[number, number, number]> = [[100, 110, 14], [150, 145, 18], [125, 165, 10], [95, 150, 8]]
  for (const [x, y, r] of craters) {
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  }
  // Glow.
  const glow = ctx.createRadialGradient(128, 128, 70, 128, 128, 128)
  glow.addColorStop(0, 'rgba(220, 225, 255, 0.25)')
  glow.addColorStop(1, 'rgba(200, 210, 255, 0)')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, 256, 256)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function buildStars(): THREE.Points {
  const N = 500
  const pos = new Float32Array(N * 3)
  let seed = 7777
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  for (let i = 0; i < N; i++) {
    const th = rnd() * Math.PI * 2
    const ph = Math.acos(rnd() * 0.9)
    const r = 230
    pos[i * 3] = r * Math.sin(ph) * Math.cos(th)
    pos[i * 3 + 1] = r * Math.cos(ph)
    pos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  const mat = new THREE.PointsMaterial({ color: 0xffffff, size: 1.4, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, fog: false })
  const pts = new THREE.Points(geo, mat)
  pts.frustumCulled = false
  return pts
}
