import * as THREE from 'three'

// ---------------------------------------------------------------------------
// Procedural weather: clear / overcast / rain, cycling on random real-time
// intervals (no two sessions play the same). Rain is thin falling line
// streaks wrapped in a box around the player (same trick as the pollen
// motes) — cheap (one LineSegments draw call), no textures. `intensity`
// (0..1, eased) is exposed so main.ts can dim the sun and grey the fog.
// ---------------------------------------------------------------------------

type WeatherState = 'clear' | 'overcast' | 'rain'
const DROPS = 500
const BOX = 22 // half-width of the wraparound box around the player
const DROP_LEN = 0.55
const FALL_SPEED = 11

export class Weather {
  readonly rain: THREE.LineSegments
  state: WeatherState = 'clear'
  /** 0..1 eased — how hard it's currently raining (0 = not at all). */
  intensity = 0
  /** 0..1 eased — overcast/rain both push cloud cover up, dims the sun. */
  cloudCover = 0

  private target = 0
  private cloudTarget = 0
  private untilNextChange = 20 + Math.random() * 25
  private positions: Float32Array

  constructor() {
    this.positions = new Float32Array(DROPS * 2 * 3)
    for (let i = 0; i < DROPS; i++) this.resetDrop(i, new THREE.Vector3())
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3))
    const mat = new THREE.LineBasicMaterial({ color: 0xc3d6e8, transparent: true, opacity: 0.0, fog: true })
    this.rain = new THREE.LineSegments(geo, mat)
    this.rain.frustumCulled = false
  }

  private resetDrop(i: number, around: THREE.Vector3): void {
    const x = around.x + (Math.random() * 2 - 1) * BOX
    const z = around.z + (Math.random() * 2 - 1) * BOX
    const y = around.y + 6 + Math.random() * 14
    const b = i * 6
    this.positions[b] = x
    this.positions[b + 1] = y
    this.positions[b + 2] = z
    this.positions[b + 3] = x
    this.positions[b + 4] = y - DROP_LEN
    this.positions[b + 5] = z
  }

  /** Call once per frame. `floorY` = ground height under the player (drops despawn there). */
  update(dt: number, playerPos: THREE.Vector3, floorY: number): void {
    // -- Random weather cycling. --
    this.untilNextChange -= dt
    if (this.untilNextChange <= 0) {
      const roll = Math.random()
      this.state = roll < 0.5 ? 'clear' : roll < 0.8 ? 'overcast' : 'rain'
      this.untilNextChange = this.state === 'rain' ? 35 + Math.random() * 40 : 25 + Math.random() * 45
      this.target = this.state === 'rain' ? 1 : 0
      this.cloudTarget = this.state === 'clear' ? 0 : this.state === 'overcast' ? 0.65 : 1
    }
    const k = 1 - Math.exp(-dt * 0.35) // slow, weather doesn't snap in/out
    this.intensity = THREE.MathUtils.lerp(this.intensity, this.target, k)
    this.cloudCover = THREE.MathUtils.lerp(this.cloudCover, this.cloudTarget, k)
    ;(this.rain.material as THREE.LineBasicMaterial).opacity = this.intensity * 0.55

    // -- Rain particles: fall + wrap, skip the work entirely when dry. --
    if (this.intensity < 0.01) return
    const speed = FALL_SPEED * dt
    for (let i = 0; i < DROPS; i++) {
      const b = i * 6
      this.positions[b + 1] -= speed
      this.positions[b + 4] -= speed
      if (this.positions[b + 1] < floorY) this.resetDrop(i, playerPos)
      else {
        // Keep wrapping horizontally around the player as they walk.
        const dx = this.positions[b] - playerPos.x
        const dz = this.positions[b + 2] - playerPos.z
        if (Math.abs(dx) > BOX || Math.abs(dz) > BOX) this.resetDrop(i, playerPos)
      }
    }
    this.rain.geometry.getAttribute('position').needsUpdate = true
  }
}
