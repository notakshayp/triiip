import * as THREE from 'three'

// ---------------------------------------------------------------------------
// Day/night synced to the player's local clock (1× = real time).
// Custom Ghibli gradient sky dome (world.ts) — this class drives sun/moon
// positions, light colours, the sky gradient and fog. `T` cycles
// 1 → 10 → 20 → 30 → 60 → 120 ×. Click the clock pill for the time switcher.
// ---------------------------------------------------------------------------

export interface DayNightRig {
  scene: THREE.Scene
  sun: THREE.DirectionalLight
  hemi: THREE.HemisphereLight
  stars: THREE.Points
}

const _fog = new THREE.Color()
// Scratch colours for sky gradient sampling (no alloc per frame).
const _tmp1 = new THREE.Color()
const _tmp2 = new THREE.Color()
const _tmp3 = new THREE.Color()
const _tmp4 = new THREE.Color()
const _tmp5 = new THREE.Color()
const _tmp6 = new THREE.Color()

export class DayNight {
  /** 1, 10, 20, 30… press T to escalate (1× = real time). */
  speed = 1
  private static SPEEDS = [1, 10, 20, 30, 60, 120]
  /** Virtual clock offset so speeding up never jumps backwards. */
  private baseHours = 0
  private baseReal = 0
  /** 0..1 day factor (1 = noon, 0 = midnight). */
  dayFactor = 1
  /** 0..1 dusk factor (peaks near sunrise/sunset). */
  duskFactor = 0
  /** Human label for HUD, e.g. "14:32 · day". */
  label = ''

  constructor(private rig: DayNightRig) {
    this.resetClock()
  }

  private resetClock(): void {
    const now = new Date()
    this.baseHours = now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600
    this.baseReal = performance.now() / 1000
  }

  /** Cycle speed; re-bases the virtual clock from the current position. */
  cycleSpeed(): string {
    this.baseHours = this.currentHours()
    this.baseReal = performance.now() / 1000
    const i = DayNight.SPEEDS.indexOf(this.speed)
    this.speed = DayNight.SPEEDS[(i + 1) % DayNight.SPEEDS.length]
    return `${this.speed}×`
  }

  /** Ghibli sky gradient for the current time of day (art-directed). */
  skyColors(): { top: THREE.Color; horizon: THREE.Color; sunGlow: THREE.Color } {
    const h = this.currentHours()
    const dayP = (h - 6) / 12
    const inDay = dayP >= 0 && dayP <= 1
    const el = inDay ? Math.sin(dayP * Math.PI) : 0 // 0..1..0
    const kf = this.duskFactor // brush strong only near sunrise/sunset
    const isNight = !inDay
    // Day: noon azure → dusk peach; night: deep blue → near-black horizon.
    const dayTop = _tmp1.set(0x2f5aa8)  // deep saturated noon blue
    const dayHor = _tmp2.set(0xa8cdf0)  // hazy horizon
    const duskTop = _tmp3.set(0x3c4a7d) // indigo high dusk
    const duskHor = _tmp4.set(0xffc06b) // peach horizon
    const nightTop = _tmp5.set(0x050a1e)
    const nightHor = _tmp6.set(0x16233f)
    const c = {
      top: new THREE.Color(),
      horizon: new THREE.Color(),
      sunGlow: new THREE.Color(),
    }
    if (isNight) {
      c.top.copy(nightTop)
      c.horizon.copy(nightHor)
      c.sunGlow.set(0x8fa8ff)
    } else {
      c.top.copy(dayTop).lerp(duskTop, kf).lerp(nightTop, Math.max(0, kf - 0.75) * 2.5)
      c.horizon.copy(dayHor).lerp(duskHor, kf)
      c.sunGlow.set(0xffe9a8).lerp(new THREE.Color(0xff9a4d), kf)
    }
    return c
  }

  setHours(h: number): void {
    this.baseHours = ((h % 24) + 24) % 24
    this.baseReal = performance.now() / 1000
    this.speed = 1
  }

  /** Re-sync to real local time. */
  syncToLocal(): void {
    this.speed = 1
    this.resetClock()
  }

  /** Sun direction (unit). Night → the moon's path, for moonlight. */
  sunDirection(out: THREE.Vector3): THREE.Vector3 {
    const h = this.currentHours()
    const dayP = (h - 6) / 12
    if (dayP >= 0 && dayP <= 1) {
      return this.solarPosition(out)
    }
    // Moon path: offset from sun by ~12 h.
    this.moonPosition(out)
    return out
  }

  /** Raw sun position — compressed arc (stylized mid-lat sun, ~60° at noon). */
  solarPosition(out: THREE.Vector3): THREE.Vector3 {
    const h = this.currentHours()
    const dayP = (h - 6) / 12
    const el = Math.sin(dayP * Math.PI) // negative at night
    const az = (h / 24) * Math.PI * 2 - Math.PI / 2
    out.set(Math.cos(az), el * 0.7, Math.sin(az) * 0.6).normalize()
    return out
  }

  /** Moon direction — rises ~18:00, highest ~00:00, sets ~06:00. */
  moonPosition(out: THREE.Vector3): THREE.Vector3 {
    const mh = (this.currentHours() + 12) % 24
    const mP = (mh - 6) / 12
    const el = mP >= 0 && mP <= 1 ? Math.sin(mP * Math.PI) : -1
    const az = (mh / 24) * Math.PI * 2 - Math.PI / 2
    out.set(Math.cos(az), Math.max(0.06, el), Math.sin(az) * 0.6).normalize()
    return out
  }

  currentHours(): number {
    const elapsed = (performance.now() / 1000 - this.baseReal) * this.speed
    return ((this.baseHours + elapsed / 3600) % 24 + 24) % 24
  }

  /** Night: never fully black — readable moonlight + lifted fog floor. */
  update(): void {
    const h = this.currentHours()
    // Sun path: 6:00 rise → 12:00 noon → 18:00 set.
    const dayP = (h - 6) / 12 // 0 at 6h, 1 at 18h
    const inDay = dayP >= 0 && dayP <= 1
    const el = inDay ? Math.sin(dayP * Math.PI) : 0 // 0..1..0
    this.dayFactor = inDay ? Math.max(0.12, el) : 0.24 // floor: readable night
    // Dusk ramps within ±1h of rise/set.
    const dusk = inDay ? Math.min(1, Math.min(Math.abs(h - 6), Math.abs(h - 18))) : 1
    this.duskFactor = 1 - Math.min(1, dusk)

    const az = (h / 24) * Math.PI * 2 - Math.PI / 2 // east→west
    const dist = 60
    // At night the "sun" becomes the moon (dim, cool) — still readable.
    const isNight = !inDay
    const elev = isNight ? 0.55 : Math.max(0.08, el)
    this.rig.sun.position.set(Math.cos(az) * dist, elev * dist, Math.sin(az) * dist * 0.6)
    if (isNight) {
      this.rig.sun.intensity = 0.9
      this.rig.sun.color.setHex(0x9fc0ff)
    } else {
      this.rig.sun.intensity = 0.35 + el * 2.0
      // Warm at low sun, white at noon.
      this.rig.sun.color.setHSL(0.1, 0.55 * (1 - el) + 0.05, 0.78 + el * 0.18)
    }
    this.rig.hemi.intensity = 0.5 + this.dayFactor * 0.65

    // Fog colour = the sky horizon colour — terrain melts into the haze seamlessly.
    const c = this.skyColors()
    if (this.rig.scene.fog instanceof THREE.Fog) {
      _fog.copy(c.horizon)
      this.rig.scene.fog.color.copy(_fog)
    }
    // Stars fade in at night.
    const starMat = this.rig.stars.material as THREE.PointsMaterial
    starMat.opacity = isNight ? 0.9 : Math.max(0, 0.25 - this.dayFactor * 0.25)
    starMat.transparent = true

    const hh = Math.floor(h)
    const mm = Math.floor((h - hh) * 60)
    const phase = isNight ? 'night' : this.duskFactor > 0.55 ? 'dusk' : 'day'
    this.label = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} · ${phase}`
  }
}
