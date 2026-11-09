import * as THREE from 'three'
import { WATER_Y } from './water'
import { kenney, kenneyMat } from './kenney'
import { toonMat } from './toon'
import { rockGeometry } from './foliage'
import { mergeGeometries } from './geometry'

// ---------------------------------------------------------------------------
// Procedural grassland terrain (infinite), Minecraft-style climate model:
// FIVE decoupled noises drive everything —
//   continentalness  → deep ocean / ocean / coast / inland bands (~600 m)
//   erosion          → flat plains vs hilly country
//   weirdness→PV     → peaks and valleys (mountains + cliffs)
//   temperature      → biome splitting (cool peaks stay bare, warm grows)
//   humidity         → forest vs meadow vs sparse grass
// Height is a spline over continentalness, plus PV mountains, erosion-flat
// detail and a river carve. Biomes can never sit far from their neighbours —
// no desert next to snow, because every layer is a smooth low-freq noise.
// ---------------------------------------------------------------------------

export interface Sittable {
  label: string
  kind: 'rock' | 'log' | 'stump' | 'crate'
  x: number
  z: number
  topY: number
  radius: number
}

export interface TrunkCollider {
  x: number
  z: number
  r: number
}

export const WORLD_SEED = 2026

function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 2246822519)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295
}

const sCurve = (t: number) => t * t * (3 - 2 * t)

export function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = x - xi
  const yf = y - yi
  const a = hash2(xi, yi, seed)
  const b = hash2(xi + 1, yi, seed)
  const c = hash2(xi, yi + 1, seed)
  const d = hash2(xi + 1, yi + 1, seed)
  const u = sCurve(xf)
  const v = sCurve(yf)
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v
}

function fbm(x: number, y: number, seed: number, oct = 4): number {
  let v = 0
  let amp = 1
  let freq = 1
  let norm = 0
  for (let i = 0; i < oct; i++) {
    v += valueNoise(x * freq, y * freq, seed + i * 101) * amp
    norm += amp
    amp *= 0.5
    freq *= 2.13
  }
  return v / norm
}

/** Deterministic RNG per chunk: same world layout every visit. */
export function chunkRng(cx: number, cz: number): () => number {
  let a = (Math.imul(cx | 0, 374761393) + Math.imul(cz | 0, 668265263) + Math.imul(WORLD_SEED, 2246822519)) >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * t

// --- Minecraft-style climate fields -----------------------------------------

/** Continentalness 0..1 — the land/ocean master band (very low freq). */
export function continentalAt(x: number, z: number): number {
  let c = fbm(x * 0.0016, z * 0.0016, WORLD_SEED + 5, 3)
  // Spawn guarantee: blend toward a plains value near the origin so the game
  // always opens on a walkable meadow (Minecraft spawns on land likewise).
  const home = Math.exp(-(x * x + z * z) / (150 * 150))
  c = Math.max(c, lerp(c, 0.56, home))
  return Math.min(1, c)
}

/** Erosion 0..1 — high = flat grass sea, low = hills & relief. */
export function erosionAt(x: number, z: number): number {
  return fbm(x * 0.0035, z * 0.0035, WORLD_SEED + 401, 3)
}

/** Weirdness 0..1 (Minecraft `ridges folded` PV 0..1, triangular). */
export function weirdnessAt(x: number, z: number): number {
  return fbm(x * 0.0045, z * 0.0045, WORLD_SEED + 777, 3)
}

function pvAt(x: number, z: number): number {
  const w = weirdnessAt(x, z)
  return 1 - Math.abs(3 * w - 2)
}

/** Mountain mass 0..1 — only inland + PV peaks (used for biome + height). */
export function mountainsAt(x: number, z: number): number {
  const pv = pvAt(x, z)
  const c = continentalAt(x, z)
  const inland = smoothstep(0.5, 0.75, c)
  return smoothstep(0.62, 0.97, pv) * inland
}

/** A winding river further east (kept from the old world; ocean is natural). */
function riverXAt(z: number): number {
  return 34 + Math.sin(z * 0.045) * 12 + Math.sin(z * 0.013) * 8
}

function carveRiver(x: number, z: number, h: number): number {
  const rd = x - riverXAt(z)
  const rw = 2.6
  return h - 1.6 * Math.exp(-(rd * rd) / (rw * rw))
}

/** Continentalness → elevation spline (metres). Water level = WATER_Y. */
function continentalElevation(c: number): number {
  if (c < 0.34) return -5.0 - 2.0 * (1 - c / 0.34) // abyssal
  if (c < 0.44) return lerp(-5.0, -1.2, (c - 0.34) / 0.1) // shelf
  if (c < 0.5) return lerp(-1.2, 0.5, (c - 0.44) / 0.06) // beach rise
  if (c < 0.58) return lerp(1.0, 2.2, smoothstep(0, 1, (c - 0.5) / 0.08)) // near inland
  if (c < 0.72) return lerp(1.8, 3.6, smoothstep(0, 1, (c - 0.58) / 0.14)) // mid inland
  if (c < 0.88) return lerp(3.6, 5.2, smoothstep(0, 1, (c - 0.72) / 0.16)) // far inland
  return lerp(5.2, 6.6, smoothstep(0, 1, (c - 0.88) / 0.12)) // high plateau base
}

/**
 * Infinite ground height: continents float in a big ocean, PV builds
 * mountains + cliffs inland, erosion flattens grass seas, a river winds east.
 * Pure function of (x, z) — any coordinate works.
 */
export function groundHeight(x: number, z: number): number {
  const c = continentalAt(x, z)
  let h = continentalElevation(c)

  // Erosion: high → flat plains; low → hilly relief (only matters on land).
  // Scaled up for a grander, more vertical world — a human standing in these
  // hills should feel small against them, not the other way around.
  const e = erosionAt(x, z)
  const landF = smoothstep(WATER_Y - 0.4, WATER_Y + 0.8, h)
  const relief = (fbm(x * 0.02, z * 0.02, WORLD_SEED, 4) - 0.5) * lerp(7.5, 1.0, smoothstep(0.35, 0.8, e)) * landF
  h += relief + Math.sin(x * 0.06) * Math.cos(z * 0.05) * 0.22 * landF

  // Peaks & valleys: mountains rise only inland (PV high + continent high).
  const mtn = mountainsAt(x, z)
  if (mtn > 0) h += Math.pow(mtn, 1.3) * 34 * landF

  h = carveRiver(x, z, h)
  // Inland lakes are relief dips that only just drop below the water line —
  // ~0.5 m deep everywhere, which reads as a milky sheet over sand. Deepen
  // them away from the shore (the waterline itself doesn't move).
  if (h < WATER_Y && c >= 0.5) h = WATER_Y - (WATER_Y - h) * 2.6
  return h
}

export function slopeAt(x: number, z: number): number {
  const e = 0.8
  const hx = groundHeight(x + e, z) - groundHeight(x - e, z)
  const hz = groundHeight(x, z + e) - groundHeight(x, z - e)
  return Math.hypot(hx, hz) / (2 * e)
}

// --- Biome type spread (kept clustered by the shared noise fields) ----------

export type Biome =
  | 'meadow' // dense short grass + flowers
  | 'tallgrass' // humid warm grasslands
  | 'clearing' // dry or cool sparse fields
  | 'forest' // humid woodlands — heavy tree cover
  | 'beach' // sand along every shoreline
  | 'ocean' // the true sea — part of the continent-scale low band, not a pocket
  | 'lake' // inland water — a local depression surrounded by land, not the sea
  | 'rock' // steep slopes, cliffs, mountain peaks — no grass
  | 'desert' // hot + very dry inland — dunes, cacti, bare sand

export const BIOME_LIST: Biome[] = ['meadow', 'tallgrass', 'clearing', 'forest', 'desert', 'beach', 'ocean', 'lake', 'rock']

/**
 * Dev tool: spiral-search outward from (fromX, fromZ) for the nearest point
 * sampling as `target` biome, so the biome switcher panel can teleport there
 * without faking the noise fields (every biome stays internally consistent).
 */
export function findBiome(target: Biome, fromX: number, fromZ: number, maxR = 2600): { x: number; z: number } | null {
  if (biomeAt(fromX, fromZ) === target) return { x: fromX, z: fromZ }
  const step = 22 // biome patches run hundreds of metres wide — no need for metre-precision sampling
  for (let r = step; r <= maxR; r += step) {
    const samples = Math.max(10, Math.floor((2 * Math.PI * r) / step))
    for (let i = 0; i < samples; i++) {
      const a = (i / samples) * Math.PI * 2
      const x = fromX + Math.cos(a) * r
      const z = fromZ + Math.sin(a) * r
      if (biomeAt(x, z) === target) return { x, z }
    }
  }
  return null
}

/** Moisture (humidity) 0..1 — Minecraft-style vegetation lane. */
export function moistureAt(x: number, z: number): number {
  return fbm(x * 0.013 + 120, z * 0.013 - 80, WORLD_SEED + 31, 3)
}

/** Temperature 0..1 — drops with height (peaks cool → bare rock). */
export function temperatureAt(x: number, z: number): number {
  const h = groundHeight(x, z)
  return 0.72 - Math.max(0, h - 1) * 0.05 + (valueNoise(x * 0.02, z * 0.02, WORLD_SEED + 61) - 0.5) * 0.18
}

/**
 * Biome picker — Minecraft order: water first, then beach band, then
 * mountain/cliff by slope or PV, then temperature+humidity split inland.
 */
export function biomeAt(x: number, z: number): Biome {
  const h = groundHeight(x, z)
  const c = continentalAt(x, z)
  if (h < WATER_Y - 0.02) {
    // True sea = part of the continent-scale low-c band. Anything underwater
    // despite land-range continentalness is a local depression — a lake, not
    // the ocean (the biome switcher was landing "Ocean" in random puddles).
    return c < 0.5 ? 'ocean' : 'lake'
  }
  // Beach = the true coast band (continental shelf side) or river banks —
  // NOT anywhere that happens to dip low inland (no random sand puddles).
  const nearRiver = Math.abs(x - riverXAt(z)) < 4.5
  if (h < WATER_Y + 0.7 && (c < 0.505 || nearRiver)) return 'beach'
  const mtn = mountainsAt(x, z)
  if (slopeAt(x, z) > 0.85 || (mtn > 0.3 && h > 5.0)) return 'rock'
  const m = moistureAt(x, z)
  const t = temperatureAt(x, z)
  if (t < 0.34) return 'clearing' // freak cold patches → sparse fields
  if (m < 0.2 && t > 0.56) return 'desert' // hot + bone-dry — before the generic dry-clearing catch-all
  if (m > 0.62 && t > 0.42 && slopeAt(x, z) < 0.55) return 'forest'
  if (m > 0.5 && t > 0.5) return 'tallgrass'
  if (m < 0.36) return 'clearing'
  return 'meadow'
}

/** Grass accepts this biome (ocean/beach/rock get none). */
export function grassy(b: Biome): boolean {
  return b === 'meadow' || b === 'tallgrass' || b === 'clearing' || b === 'forest'
}

const _tc = new THREE.Color()
const _tc2 = new THREE.Color()
const _tc3 = new THREE.Color()

/**
 * Grassland vertex colour: patchy meadow greens, lighter on crests,
 * darker in hollows, sun-bleached "dry" patches. All grass, all the way.
 */
export function terrainColorAt(x: number, z: number, out: THREE.Color): void {
  const h = groundHeight(x, z)
  // Base meadow green, patchy by noise.
  const n1 = valueNoise(x * 0.08, z * 0.08, WORLD_SEED + 17)
  const n2 = valueNoise(x * 0.32, z * 0.32, WORLD_SEED + 41)
  // Matches the grass blades' mid-stem green (not the bright lime it was) so
  // the gaps between clumps read as more grass in shadow — one continuous
  // carpet instead of tufts on bare ground. Flat ground catches the brightest
  // toon band, so this sits darker than the blades on purpose.
  _tc.setHSL(0.27 + (n1 - 0.5) * 0.05, 0.55, 0.24 + (n2 - 0.5) * 0.06 + Math.min(h, 20) * 0.003)
  // Dry golden patches (Ghibli summer meadows).
  const dry = smoothstep(0.68, 0.82, valueNoise(x * 0.035 + 9, z * 0.035 - 4, WORLD_SEED + 93))
  if (dry > 0) {
    _tc2.setHSL(0.14, 0.5, 0.33) // golden-olive, matched to the darker carpet base
    _tc.lerp(_tc2, dry * 0.45)
  }
  // Biome ground tint: sand on beaches, mud ocean beds, oak-brown woods.
  const biome = biomeAt(x, z)
  if (biome === 'beach') {
    // Dry sand with wind-ripple variation, darkening to wet sand at the waterline.
    const ripple = valueNoise(x * 0.35, z * 0.12, WORLD_SEED + 131)
    _tc2.setHSL(0.11, 0.42, 0.66 + (ripple - 0.5) * 0.06)
    const wet = 1 - smoothstep(WATER_Y + 0.05, WATER_Y + 0.4, h)
    _tc3.setHSL(0.09, 0.32, 0.42)
    _tc2.lerp(_tc3, wet * 0.85)
    _tc.copy(_tc2)
  } else if (biome === 'ocean' || biome === 'lake') {
    // Bed colour is set below for everything underwater (the water shader
    // does the depth tint — absorption — so the bed is painted as it is).
  } else if (biome === 'forest') {
    _tc.offsetHSL(0.0, 0.06, -0.045) // deep woodland floor
  } else if (biome === 'tallgrass') {
    _tc.offsetHSL(0.01, 0, -0.02)
  } else if (biome === 'desert') {
    // Warm dune sand with soft ripple banding (not a flat tan slab).
    const ripple = valueNoise(x * 0.05, z * 0.05, WORLD_SEED + 71)
    _tc2.setHSL(0.1, 0.55, 0.64 + (ripple - 0.5) * 0.08)
    _tc.copy(_tc2)
  }
  // Lake / sea bed: natural sand and silt with weed patches. The water's
  // absorption supplies the turquoise-to-deep-blue, so painting the bed
  // blue (as before) made shallow water read as pale, milky paint.
  if (h < WATER_Y + 0.02) {
    const depth = Math.max(0, WATER_Y - h)
    const patch = valueNoise(x * 0.08, z * 0.08, WORLD_SEED + 307)
    const fine = valueNoise(x * 0.6, z * 0.6, WORLD_SEED + 311)
    _tc2.setHSL(0.11, 0.36, 0.56 + (fine - 0.5) * 0.08) // clean shallow sand
    _tc3.setHSL(0.14, 0.26, 0.33) // olive silt
    _tc2.lerp(_tc3, smoothstep(0.4, 2.5, depth))
    _tc3.setHSL(0.24, 0.4, 0.26) // weed beds
    _tc2.lerp(_tc3, smoothstep(0.55, 0.75, patch) * smoothstep(0.3, 1.2, depth) * 0.7)
    _tc.lerp(_tc2, smoothstep(WATER_Y + 0.02, WATER_Y - 0.15, h))
  }
  // Stone: steep faces and the rock biome read as weathered cliff, not as
  // flat green slabs. Strata noise breaks up the toon bands on big faces;
  // a little moss survives on gentler ledges.
  const sl = slopeAt(x, z)
  const strata = valueNoise(x * 0.09, h * 0.6 + z * 0.02, WORLD_SEED + 211)
  const grain = valueNoise(x * 0.4, z * 0.4, WORLD_SEED + 223)
  const stoneMix = biome === 'rock' ? Math.max(0.7, smoothstep(0.35, 0.8, sl)) : smoothstep(0.6, 1.1, sl) * 0.9
  if (stoneMix > 0) {
    _tc2.setHSL(0.075 + strata * 0.03, 0.1 + grain * 0.08, 0.36 + strata * 0.16 + (grain - 0.5) * 0.06)
    // High, cold peaks pale toward snowy grey-white.
    if (h > 18) _tc2.lerp(_tc3.setHSL(0.58, 0.08, 0.86), smoothstep(18, 30, h) * 0.8)
    _tc.lerp(_tc2, stoneMix)
  }
  out.copy(_tc)
}
// --- shared materials for the (static) base sit spots near spawn ---------------
const matWood = toonMat({ color: 0x8a6a4a })
const matWoodTop = toonMat({ color: 0xc9a06b })

/** Spawn prop layout (sittable metadata is stable; meshes upgrade when the
 *  Kenney (CC0) models finish loading). */
const SEAT_ROCKS = [
  { x: 5, z: -4, s: 1.5 },
  { x: -8, z: 6, s: 1.8 },
  { x: 11, z: 10, s: 1.2 },
  { x: -13, z: -9, s: 2.1 },
  { x: 16, z: -14, s: 1.4 },
  { x: -4, z: -17, s: 1.3 },
  { x: 20, z: 4, s: 1.6 },
  { x: 0, z: 16, s: 1.1 },
]
const SEAT_LOG = { x: -6, z: -3 }
const SEAT_STUMPS = [
  { x: 9, z: 14 },
  { x: -16, z: 12 },
]

/**
 * Guaranteed sit spots around the spawn meadow (rock, log, stumps). Chunk
 * rocks cover the wider infinite world (see chunks.ts). Procedural fallback
 * meshes render instantly; kenney.ready swaps in the real CC0 models and
 * corrects the seat metadata in place.
 */
export function buildSittables(): { group: THREE.Group; sittables: Sittable[] } {
  const group = new THREE.Group()
  const sittables: Sittable[] = []

  for (const spot of SEAT_ROCKS) {
    const gy = groundHeight(spot.x, spot.z)
    sittables.push({ label: 'flat rock', kind: 'rock', x: spot.x, z: spot.z, topY: gy + spot.s * 0.55, radius: spot.s * 0.95 })
  }
  sittables.push({ label: 'fallen log', kind: 'log', x: SEAT_LOG.x, z: SEAT_LOG.z, topY: groundHeight(SEAT_LOG.x, SEAT_LOG.z) + 1.02, radius: 1.1 })
  for (const s of SEAT_STUMPS) {
    const gy = groundHeight(s.x, s.z)
    sittables.push({ label: 'tree stump', kind: 'stump', x: s.x, z: s.z, topY: gy + 1.06, radius: 0.8 })
  }

  // -- Spawn rocks: smooth, mossy, high-subdivision (foliage.ts) — final,
  // not a placeholder. Seat heights come from the actual generated crest.
  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const rockParts: THREE.BufferGeometry[] = []
  SEAT_ROCKS.forEach((r, i) => {
    const g = rockGeometry(chunkRng(i, 9001), r.s * 0.95)
    g.computeBoundingBox()
    const top = g.boundingBox!.max.y
    const gy = groundHeight(r.x, r.z) - 0.12
    g.rotateY(i * 0.93 + 0.4)
    g.translate(r.x, gy, r.z)
    rockParts.push(g)
    const seat = sittables.find((t) => t.kind === 'rock' && t.x === r.x && t.z === r.z)
    if (seat) {
      seat.topY = gy + top * 0.9
      seat.radius = Math.max(0.7, r.s * 0.85)
    }
  })
  const rocks = new THREE.Mesh(mergeGeometries(rockParts), toonMat({ vertexColors: true }, 0xcfe8ff, 0.2, 0.9))
  for (const p of rockParts) p.dispose()
  rocks.castShadow = true
  rocks.receiveShadow = true
  group.add(rocks)

  {
    const gy = groundHeight(SEAT_LOG.x, SEAT_LOG.z)
    const geo = new THREE.CylinderGeometry(0.55, 0.55, 3.2, 12)
    geo.rotateZ(Math.PI / 2)
    const log = new THREE.Mesh(geo, matWood)
    log.name = 'fallback'
    log.position.set(SEAT_LOG.x, gy + 0.55, SEAT_LOG.z)
    log.rotation.y = 0.5
    log.castShadow = true
    log.receiveShadow = true
    group.add(log)
  }
  {
    const geo = new THREE.CylinderGeometry(0.8, 0.95, 0.7, 14)
    const tops = new THREE.InstancedMesh(geo, matWoodTop, SEAT_STUMPS.length)
    const bodies = new THREE.InstancedMesh(geo, matWood, SEAT_STUMPS.length)
    tops.name = 'fallback'
    bodies.name = 'fallback'
    const qi = new THREE.Quaternion()
    SEAT_STUMPS.forEach((s, i) => {
      const gy = groundHeight(s.x, s.z)
      m.compose(new THREE.Vector3(s.x, gy + 0.35, s.z), qi, new THREE.Vector3(1, 1, 1))
      bodies.setMatrixAt(i, m)
      m.compose(new THREE.Vector3(s.x, gy + 0.72, s.z), qi, new THREE.Vector3(1, 1, 1))
      tops.setMatrixAt(i, m)
    })
    tops.castShadow = true
    bodies.castShadow = true
    bodies.receiveShadow = true
    tops.receiveShadow = true
    group.add(bodies, tops)
  }

  // -- Upgrade to Kenney CC0 models once loaded ------------------------------
  void upgradeSpawnProps(group, sittables)

  return { group, sittables }
}

/** Swap the fallback log/stump meshes for Kenney Nature Kit models + real seat heights. */
async function upgradeSpawnProps(group: THREE.Group, sittables: Sittable[]): Promise<void> {
  await kenney.ready
  const mat = kenneyMat()
  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const e = new THREE.Euler()

  // Log (lying, long axis is Z in the model — capped ends, ringed wood).
  {
    const model = kenney.get('log')
    if (model) {
      const scale = 3.2
      const gy = groundHeight(SEAT_LOG.x, SEAT_LOG.z)
      const inst = new THREE.InstancedMesh(model.geometry, mat, 1)
      e.set(0, 0.5, 0)
      q.setFromEuler(e)
      m.compose(new THREE.Vector3(SEAT_LOG.x, gy - 0.04, SEAT_LOG.z), q, new THREE.Vector3(scale, scale, scale))
      inst.setMatrixAt(0, m)
      inst.castShadow = true
      inst.receiveShadow = true
      group.add(inst)
      const s = sittables.find((t) => t.kind === 'log')
      if (s) {
        s.topY = gy + model.height * scale * 0.95
        s.radius = model.radius * scale * 0.66
      }
    }
  }

  // Stumps.
  {
    const model = kenney.get('stump-squaredetailed')
    if (model) {
      const inst = new THREE.InstancedMesh(model.geometry, mat, SEAT_STUMPS.length)
      SEAT_STUMPS.forEach((spot, i) => {
        const scale = 3.1
        const gy = groundHeight(spot.x, spot.z)
        e.set(0, i * 1.4 + 0.7, 0)
        q.setFromEuler(e)
        m.compose(new THREE.Vector3(spot.x, gy - 0.04, spot.z), q, new THREE.Vector3(scale, scale, scale))
        inst.setMatrixAt(i, m)
        const s = sittables.find((t) => t.kind === 'stump' && t.x === spot.x && t.z === spot.z)
        if (s) {
          s.topY = gy + model.height * scale * 0.92
          s.radius = Math.max(0.7, model.radius * scale * 0.9)
        }
      })
      inst.castShadow = true
      inst.receiveShadow = true
      group.add(inst)
    }
  }

  // Dispose the marked fallbacks (rocks/stumps/log all tagged at creation).
  const stale: THREE.Object3D[] = []
  group.children.forEach((c) => {
    if (c.name === 'fallback') stale.push(c)
  })
  for (const c of stale) {
    group.remove(c)
    const mesh = c as THREE.InstancedMesh
    if (mesh.geometry) mesh.geometry.dispose()
  }
}

/** Nearest sittable within reach (for the sit prompt / auto-climb). */
export function nearestSittable(sittables: Sittable[], x: number, z: number, reach = 2.2): Sittable | null {
  let best: Sittable | null = null
  let bestD = reach
  for (const s of sittables) {
    // Cheap AABB pre-check before hypot.
    const dx = s.x - x
    if (dx > bestD || dx < -bestD) continue
    const dz = s.z - z
    if (dz > bestD || dz < -bestD) continue
    const d = Math.hypot(dx, dz)
    if (d < bestD) {
      bestD = d
      best = s
    }
  }
  return best
}
