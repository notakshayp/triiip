import * as THREE from 'three'
import './style.css'
import { World } from './world'
import { Cat } from './cat'
import { Input } from './input'
import { FollowCamera } from './camera'
import { Player } from './player'
import { AdaptiveQuality } from './quality'
import { DayNight } from './daynight'
import { Sfx } from './sfx'
import { WATER_Y } from './water'
import { AnimeFx } from './animefx'
import { biomeAt, findBiome, type Biome } from './terrain'
import { Spotify } from './spotify'
import { mountMusic } from './music-ui'
import { isTyping } from './input'

// ----------------------------------------------------------------------------
// Boot: renderer (WebGL2, no stencil, high-performance), fixed-step loop.
// Optimisations live where they belong:
//  • fixed timestep accumulator (60 Hz physics, decoupled render)
//  • zero allocation in the hot loop (preallocated vectors everywhere)
//  • adaptive pixel ratio + paused-when-hidden + texel-snapped shadows
//  • instanced/merged world (grass/flowers, trees/rocks per chunk) + far LOD
// ----------------------------------------------------------------------------

const canvas = document.getElementById('game') as HTMLCanvasElement
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  stencil: false, // we never need a stencil buffer
  powerPreference: 'high-performance',
  alpha: false,
})
renderer.outputColorSpace = THREE.SRGBColorSpace
// Khronos PBR Neutral: gentler shoulder + toe than ACES, keeps hues pastel
// instead of crushing shadows and over-saturating mids.
renderer.toneMapping = THREE.NeutralToneMapping
renderer.toneMappingExposure = 1.12
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
// EffectComposer resets renderer.info per internal pass — reset once/frame
// ourselves so the HUD's call/tri counter still reflects the whole frame.
renderer.info.autoReset = false

const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 2000)

const world = new World()
// Far-LOD tree impostors are rendered from the real tree models — needs the renderer.
for (const inst of world.far.bakeImpostors(renderer)) world.scene.add(inst)
const character = new Cat()
world.scene.add(character.group)

const input = new Input()
const followCam = new FollowCamera(canvas, camera)
const player = new Player(world.sittables, world.trunkColliders, input, followCam, character, (x, y, z, n) => world.dust.burst(x, y, z, n))
player.waterSurface = (x, z) => world.water.surfaceAt(x, z)
const dayNight = new DayNight(world.dayNightRig())
const sfx = new Sfx()
let surfT = 0
let swimHold = 0
let rippleWasSwimming = false
let lastWaterSfx = 0
let surf = { level: 0, phase: 0, period: 6 }

followCam.update(0, player.pos, 0, 0, 0, true)
FollowCamera.setBodyVisible(character.group, followCam.firstPerson)

// Ghibli toon post-process (ink outlines, posterised palette, ground haze, sun rays).
const animeFx = new AnimeFx(renderer, world.scene, camera, world.overlay, world.water)
animeFx.strength = 1.0

// Adaptive resolution (caps DPR, steps down under load, restores with headroom).
const quality = new AdaptiveQuality(renderer, canvas, (w, h, dpr) => {
  animeFx.setSize(w, h, dpr)
  world.dust.setViewportHeight(h * dpr)
  world.ambience.setViewportHeight(h * dpr)
  // Below native resolution the GPU is struggling: thin the grass too.
  world.setGrassDensity(dpr <= 0.6 ? 0.5 : dpr <= 0.75 ? 0.72 : 1)
})

// Show touch UI on coarse-pointer devices.
const needsTouch = window.matchMedia('(pointer: coarse)').matches
const touchUi = document.getElementById('touch-ui')
if (touchUi && needsTouch) touchUi.hidden = false

// Help collapse.
const helpToggle = document.getElementById('help-toggle')
const helpBody = document.getElementById('help-body')
helpToggle?.addEventListener('click', () => {
  const hidden = helpBody?.hasAttribute('hidden') ?? false
  helpBody?.toggleAttribute('hidden', !hidden)
  helpToggle.setAttribute('aria-expanded', String(hidden))
})

// Resize (debounced via rAF flag, not a timer storm).
let resized = false
const onResize = () => {
  if (resized) return
  resized = true
  requestAnimationFrame(() => {
    resized = false
    const w = window.innerWidth
    const h = window.innerHeight
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    renderer.setSize(w, h, false)
    animeFx.setSize(w, h, renderer.getPixelRatio())
    // Point particles size by viewport height so they look the same at any resolution.
    world.dust.setViewportHeight(h * renderer.getPixelRatio())
    world.ambience.setViewportHeight(h * renderer.getPixelRatio())
  })
}
window.addEventListener('resize', onResize)
onResize()

// HUD.
const perfEl = document.getElementById('perf-text')
const timeEl = document.getElementById('clock')
const coordsEl = document.getElementById('coords')
const promptEl = document.getElementById('prompt')
const modeEl = document.getElementById('mode')
const timePanel = document.getElementById('time-panel')
const timeSlider = document.getElementById('time-slider') as HTMLInputElement | null
const timeSpeedEl = document.getElementById('time-speed')

// Time-of-day switcher: scrub slider + presets + re-sync to real clock.
function setTimeAndSync(h: number): void {
  dayNight.setHours(h)
}
timeEl?.addEventListener('click', () => {
  if (!timePanel) return
  const open = timePanel.hasAttribute('hidden')
  timePanel.toggleAttribute('hidden', !open)
  if (open && timeSlider) timeSlider.value = String(dayNight.currentHours())
})
document.getElementById('time-close')?.addEventListener('click', () => timePanel?.setAttribute('hidden', ''))
document.getElementById('time-sync')?.addEventListener('click', () => dayNight.syncToLocal())
timeSlider?.addEventListener('input', () => {
  const v = Number(timeSlider.value)
  if (Number.isFinite(v)) setTimeAndSync(v)
})
document.querySelectorAll<HTMLButtonElement>('#time-panel [data-hour]').forEach((b) => {
  b.addEventListener('click', () => setTimeAndSync(Number(b.dataset.hour)))
})

// Dev: biome switcher — spiral-searches the real noise field and teleports
// there (doesn't fake the biome, so terrain/props/grass all stay consistent).
const biomeToggle = document.getElementById('biome-toggle')
const biomePanel = document.getElementById('biome-panel')
function toggleBiomePanel(): void {
  biomePanel?.toggleAttribute('hidden', !biomePanel.hasAttribute('hidden'))
}
biomeToggle?.addEventListener('click', toggleBiomePanel)
document.getElementById('biome-close')?.addEventListener('click', () => biomePanel?.setAttribute('hidden', ''))
document.querySelectorAll<HTMLButtonElement>('#biome-panel [data-biome]').forEach((b) => {
  b.addEventListener('click', () => {
    const target = b.dataset.biome as Biome
    const found = findBiome(target, player.pos.x, player.pos.z)
    if (!found) {
      console.warn(`[biome-dev] no "${target}" found within range of`, player.pos)
      return
    }
    world.prehydrateAround(new THREE.Vector3(found.x, 0, found.z)) // build destination first…
    player.teleport(found.x, found.z) // …so the landing check sees its rocks/props too
  })
})

let hudT = 0
let frames = 0
let accFps = 0

// Dev/QA hooks: window.__chill.setTime(6.5 | 12 | 17.8 | 23.5), window.__chill.setSky(t, r, m)
;(window as unknown as Record<string, unknown>).__chill = {
  setTime: (h: number) => setTimeAndSync(h),
  setSky: (top: THREE.ColorRepresentation, horizon: THREE.ColorRepresentation, sunGlow: THREE.ColorRepresentation) => {
    const sky = world.skyMat
    ;(sky.uniforms.topColor.value as THREE.Color).set(top)
    ;(sky.uniforms.horizonColor.value as THREE.Color).set(horizon)
    ;(sky.uniforms.sunGlowColor.value as THREE.Color).set(sunGlow)
  },
  setPos: (x: number, z: number) => {
    world.prehydrateAround(new THREE.Vector3(x, 0, z))
    player.teleport(x, z)
  },
  scene: world.scene,
  cam: followCam,
  player,
  biomeAt,
  findBiome,
  fx: animeFx,
  weather: world.weather,
  world,
}

// --- SFX: unlock on first gesture, stride footsteps, splashes, crickets. ------
const unlockAudio = (e: Event) => {
  if (!isTyping(e)) sfx.unlock()
}
window.addEventListener('keydown', unlockAudio)
window.addEventListener('pointerdown', unlockAudio)
document.addEventListener('touchstart', unlockAudio, { passive: true })
let strideAcc = 0
let wasSwimming = false
const SOUND_PILL = document.getElementById('sound')
const refreshSoundPill = () => {
  SOUND_PILL?.setAttribute('aria-pressed', String(sfx.enabled))
  if (SOUND_PILL) SOUND_PILL.textContent = sfx.enabled ? '🔊' : '🔇'
}
SOUND_PILL?.addEventListener('click', () => {
  sfx.unlock()
  sfx.toggle()
  refreshSoundPill()
})
// --- Music: the player's own Spotify (see spotify.ts). ------------------------
const music = new Spotify()
mountMusic(music)
let musicDuck = 1

window.addEventListener('keydown', (e) => {
  if (isTyping(e)) return
  if (e.key.toLowerCase() === 'p' && !e.repeat) music.togglePlay()
  if (e.key.toLowerCase() === 'm') {
    sfx.unlock()
    sfx.toggle()
    refreshSoundPill()
  }
})

// --- Help collapse / minimize -----------------------------------------------
const minBtn = document.getElementById('help-min')
const helpFab = document.getElementById('help-fab')
minBtn?.addEventListener('click', (e) => {
  e.stopPropagation()
  helpBody?.setAttribute('hidden', '')
  helpToggle?.setAttribute('aria-expanded', 'false')
  helpFab?.removeAttribute('hidden')
})
helpFab?.addEventListener('click', () => {
  helpBody?.removeAttribute('hidden')
  helpToggle?.setAttribute('aria-expanded', 'true')
  helpFab?.setAttribute('hidden', '')
})

// --- Perf sparkline (frame-time graph + JS heap). -----------------------------
const spark = document.getElementById('spark') as HTMLCanvasElement | null
const sparkCtx = spark?.getContext('2d') ?? null
const frameTimes: number[] = new Array(120).fill(16.7)
let frameIdx = 0
function drawSpark(): void {
  if (!spark || !sparkCtx) return
  const w = spark.width
  const h = spark.height
  sparkCtx.clearRect(0, 0, w, h)
  sparkCtx.strokeStyle = 'rgba(255,255,255,0.25)'
  sparkCtx.beginPath()
  sparkCtx.moveTo(0, h - 16.7 / 50 * h)
  sparkCtx.lineTo(w, h - 16.7 / 50 * h)
  sparkCtx.stroke()
  sparkCtx.beginPath()
  for (let i = 0; i < 120; i++) {
    const ms = frameTimes[(frameIdx + i) % 120]
    const y = h - Math.min(1, ms / 50) * h
    if (i === 0) sparkCtx.moveTo(0, y)
    else sparkCtx.lineTo(i * (w / 119), y)
  }
  sparkCtx.strokeStyle = '#5ee0a0'
  sparkCtx.lineWidth = 1.5
  sparkCtx.stroke()
}

// Fixed-step loop.
const STEP = 1 / 60
let accumulator = 0
let last = performance.now()
let paused = false
const _sunDir = new THREE.Vector3()
const _deepFog = new THREE.Color(0x030a14)
const _stormGrey = new THREE.Color(0x717d8c)

document.addEventListener('visibilitychange', () => {
  paused = document.hidden
  if (!paused) {
    last = performance.now() // avoid a huge dt spike on return
    accumulator = 0
  }
})

function frame(now: number): void {
  requestAnimationFrame(frame)
  if (paused) return

  let dt = (now - last) / 1000
  last = now
  if (dt > 0.25) dt = 0.25 // clamp huge stutters (backgrounding, debugger)
  // Never let physics run more than 3 steps per frame.
  accumulator += dt
  let steps = 0
  while (accumulator >= STEP && steps < 3) {
    if (input.consumeSit()) player.toggleSit()
    if (input.consumeView()) {
      followCam.toggleMode()
      FollowCamera.setBodyVisible(character.group, followCam.firstPerson)
    }
    if (input.consumeTime()) dayNight.cycleSpeed()
    if (input.consumeBiome()) toggleBiomePanel()
    const nudge = input.consumeNudge()
    if (nudge !== 0) setTimeAndSync(dayNight.currentHours() + nudge)
    player.update(STEP)
    accumulator -= STEP
    steps++
  }
  if (accumulator >= STEP) accumulator = 0 // drop backlog instead of spiralling
  player.interpolate(accumulator / STEP, dt)

  dayNight.update()
  world.update(dt, player.pos, camera.position, dayNight, player.vel)

  // Underwater haze when the camera dips below the waterline — murkier the
  // deeper you go (fixed fog distance made every depth look identical, which
  // read as "the ocean has no depth").
  const fog = world.scene.fog as THREE.Fog | null
  if (camera.position.y < WATER_Y) {
    if (fog) {
      const under = WATER_Y - camera.position.y
      fog.near = 0.6
      fog.far = THREE.MathUtils.clamp(24 - under * 2.2, 5, 24)
      fog.color.setHex(0x1e6f8f).lerp(_deepFog, Math.min(1, under / 7))
    }
  } else if (fog) {
    const cloud = world.weather.cloudCover
    // Long, airy aerial-perspective fog (distant hills go hazy blue, Genshin
    // vista style) — storms pull it in tight.
    fog.near = THREE.MathUtils.lerp(60, 20, cloud)
    fog.far = THREE.MathUtils.lerp(900, 180, cloud)
    fog.color.lerp(_stormGrey, cloud * 0.6)
    world.sun.intensity *= 1 - cloud * 0.65
    world.hemi.intensity *= 1 - cloud * 0.3
  }

  const moving = Math.hypot(player.vel.x, player.vel.z)
  followCam.update(dt, player.renderPos, player.sitMix, moving, player.walkPhase, false, player.facing, player.vel)
  // Speed feel: the view widens a touch as you break into a gallop.
  const fovTarget = 58 + THREE.MathUtils.smoothstep(Math.hypot(player.vel.x, player.vel.z), 4.6, 7.6) * 7
  if (Math.abs(camera.fov - fovTarget) > 0.01) {
    camera.fov += (fovTarget - camera.fov) * (1 - Math.exp(-dt * 4))
    camera.updateProjectionMatrix()
  }
  dayNight.sunDirection(_sunDir)
  // Live ripples: the cat's wake when swimming or wading, a plunge on
  // entering deep water, rain dimpling the surface.
  {
    const surf = world.water.surfaceAt(player.pos.x, player.pos.z)
    const sp = Math.hypot(player.vel.x, player.vel.z)
    if (player.isSwimming) world.water.ripples.disturb(player.pos.x, player.pos.z, 0.42, 0.0025 + sp * 0.0016)
    else if (surf > player.pos.y + 0.02 && sp > 0.3) world.water.ripples.disturb(player.pos.x, player.pos.z, 0.3, sp * 0.0012)
    if (player.isSwimming && !rippleWasSwimming) world.water.ripples.disturb(player.pos.x, player.pos.z, 0.9, 0.06)
    rippleWasSwimming = player.isSwimming
    const rain = world.weather.intensity
    for (let i = 0; i < 6; i++) {
      if (Math.random() < rain * 0.9) world.water.ripples.disturb(player.pos.x + (Math.random() - 0.5) * 36, player.pos.z + (Math.random() - 0.5) * 36, 0.12, 0.004)
    }
    world.water.ripples.update(renderer, dt, player.pos)
  }
  renderer.info.reset()
  animeFx.setCloudCover(world.weather.cloudCover)
  animeFx.render(dt, _sunDir, world.sun.color, (world.scene.fog as THREE.Fog).color)
  quality.tick(dt)

  // Perf sparkline + stride footsteps + swim detection + night crickets.
  frameTimes[frameIdx] = dt * 1000
  frameIdx = (frameIdx + 1) % 120
  drawSpark()
  sfx.setRustle(moving / 5.2)
  // Swim state from the player (deep water + afloat), debounced: lapping
  // surf at the shoreline used to toggle "in water" every wave.
  swimHold = player.isSwimming === wasSwimming ? 0 : swimHold + dt
  if (swimHold > 0.25) {
    wasSwimming = player.isSwimming
    swimHold = 0
    const now = performance.now()
    if (now - lastWaterSfx > 1200) {
      if (wasSwimming) sfx.waterEnter()
      else sfx.waterExit()
      lastWaterSfx = now
    }
  }
  const swimmingNow = wasSwimming
  // Music sits back a little while you swim, so the water comes forward.
  musicDuck += ((swimmingNow ? 0.6 : 1) - musicDuck) * Math.min(1, dt * 1.5)
  music.setDuck(musicDuck)
  const wading = !swimmingNow && world.water.surfaceAt(player.pos.x, player.pos.z) > player.pos.y + 0.03
  if (moving > 0.5 && player.sitMix < 0.1) {
    strideAcc += moving * dt
    if (strideAcc > 2.2) {
      strideAcc = 0
      if (wading) sfx.paddle(true)
      else sfx.footstep(swimmingNow, dt)
    }
  }
  sfx.setNight(dayNight.dayFactor < 0.15)
  sfx.setRain(world.weather.intensity)
  // Surf: sample the shore around you a few times a second, run the breaker
  // phase forward in between.
  surfT -= dt
  if (surfT <= 0) {
    surfT = 0.3
    surf = world.water.surfNear(player.pos.x, player.pos.z)
  } else surf.phase = (surf.phase + dt / surf.period) % 1
  sfx.setSurf(surf.level, surf.phase)

  // HUD at ~4 Hz (cheap, no layout thrash).
  accFps += dt
  frames++
  hudT += dt
  if (hudT > 0.25) {
    const fps = frames / Math.max(1e-6, accFps)
    const calls = renderer.info.render.calls
    const tris = renderer.info.render.triangles
    const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
    const heapMs = Math.round((heap?.usedJSHeapSize ?? 0) / 1048576)
    if (perfEl) perfEl.textContent = `${Math.round(fps)} fps · ${calls} calls · ${tris.toLocaleString()} tris · ${heapMs} MB`
    const weatherIcon = world.weather.state === 'rain' ? ' 🌧' : world.weather.state === 'overcast' ? ' ☁️' : ''
    if (timeEl) timeEl.textContent = dayNight.label + weatherIcon
    if (coordsEl) coordsEl.textContent = `x ${Math.round(player.pos.x)} · z ${Math.round(player.pos.z)}`
    if (timeSpeedEl) {
      timeSpeedEl.textContent = dayNight.speed === 1 ? '1× live' : `${dayNight.speed}× preview`
    }
    if (timePanel && !timePanel.hasAttribute('hidden') && timeSlider && document.activeElement !== timeSlider) {
      timeSlider.value = String(dayNight.currentHours())
    }
    if (modeEl) modeEl.textContent = followCam.firstPerson ? '1st person' : '3rd person'
    if (biomeToggle) biomeToggle.textContent = `🧭 ${biomeAt(player.pos.x, player.pos.z)}`
    const prompt = player.getPrompt()
    if (promptEl && promptEl.textContent !== prompt) promptEl.textContent = prompt
    hudT = 0
    frames = 0
    accFps = 0
  }
}

requestAnimationFrame(frame)
