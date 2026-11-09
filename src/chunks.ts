import * as THREE from 'three'
import { biomeAt, chunkRng, grassy, groundHeight, slopeAt, terrainColorAt, type Biome, type Sittable, type TrunkCollider } from './terrain'
import { mergeGeometries } from './geometry'
import type { Grass } from './grass'
import { toonMat, bendyMat, setBendyPlayer, updateTrail } from './toon'
import { WATER_Y } from './water'
import { BOULDER_POOL, BUSH_VARIANTS, FLOWER_VARIANTS, FLOWER_WEIGHTS, flowerAtlas, PEBBLE_POOL, TREE_VARIANTS, foliageMat, setFoliageTime, withUv, type TreeKind } from './foliage'

// ---------------------------------------------------------------------------
// Infinite chunk streaming: 7×7 chunks of 48 m around the player (radius 3
// loaded, unloaded at 4 — hysteresis), built within a per-frame time budget.
// Each chunk: terrain + grass + merged trunks/rocks/cacti + merged leaf
// canopies + one instanced mesh per flower variety. All props are procedural
// stylised assets (foliage.ts) — no asset download gates the world. Past the
// chunks, farlod.ts carries the horizon out to ~1 km.
// ---------------------------------------------------------------------------

const CHUNK = 48
const SEG = 24
const LOAD_R = 3
const UNLOAD_R = 4
// Chunk builds are synchronous CPU work (noise grid + scatter placement +
// ~1-2k grass instances) — building the whole ring in one frame is exactly
// what caused the reported choppiness (worst on fast/diagonal movement and
// right after a teleport). Budgeting a few per frame trades a touch of
// pop-in distance for a frame-time that never spikes.
// Time-based (not count-based): always build ≥1, stop once ~4 ms is spent,
// so heavier chunks (dense forest) can't stack into a frame spike.
const BUILD_BUDGET_MS = 4
const GRASS_PER_CHUNK = 2800 // near-tier clumps per 48 m chunk (11 blades each)
const FLOWER_CLUSTERS = 7
const FLOWERS_PER_CLUSTER = 6

// Painterly ground: cel-shaded, vertex-colour only (terrainColorAt already
// paints rich noise-driven patchiness) — a photographic tiling texture read
// as a generic default-asset lawn next to the toon-shaded grass/character.
// No rim light on ground: flat terrain seen at grazing angles is all rim,
// which washed the whole field out to pale mint.
const matTerrain = toonMat({ vertexColors: true }, 0xcfe8ff, 0, 1, true)
const matScatter = toonMat({ vertexColors: true }, 0xcfe8ff, 0.2, 0.7)

const _tc = new THREE.Color()
const _fv = new THREE.Vector3()
const _fs = new THREE.Vector3()
const _spin = new THREE.Quaternion()
const _fm = new THREE.Matrix4()
const _fq = new THREE.Quaternion()
const _fe = new THREE.Euler()

type Blocker = { x: number; z: number; r: number }
type Placement = { x: number; y: number; z: number; scale: number; rotY: number }

interface Chunk {
  group: THREE.Group
  sittables: Sittable[]
  trunks: TrunkCollider[]
  cx: number
  cz: number
  hGrid: Float32Array // terrain heights at the 2 m vertex grid
  bGrid: Biome[] // biome at the same vertices
  blockers: Blocker[] // trees/rocks/bushes — grass + flowers keep clear
  /** Detail layer (grass + flowers), rebuilt when the chunk changes LOD tier. */
  detail: THREE.Group | null
  tier: number // -1 = needs a (re)build
}

/** Detail LOD tier by chunk ring: 0 = full meadow ... 3 = sparse far band. */
function tierFor(ring: number): number {
  return ring <= 1 ? 0 : ring === 2 ? 1 : ring === 3 ? 2 : 3
}
const GRASS_BY_TIER = [GRASS_PER_CHUNK, 1000, 450, 220]
const FLOWER_CLUSTERS_BY_TIER = [FLOWER_CLUSTERS, 3, 0, 0]

function pickFlower(rng: () => number): number {
  let t = rng()
  for (let i = 0; i < FLOWER_WEIGHTS.length; i++) {
    t -= FLOWER_WEIGHTS[i]
    if (t <= 0) return i
  }
  return 0
}

/** Procedural saguaro cactus — trunk + 0-2 angled arms, local origin at the base. */
function buildCactusGeometry(rng: () => number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const trunkH = 1.5 + rng() * 1.3
  const trunkR = 0.13 + rng() * 0.06
  const trunk = new THREE.CylinderGeometry(trunkR * 0.8, trunkR, trunkH, 8)
  trunk.translate(0, trunkH / 2, 0)
  parts.push(trunk)
  const nArms = rng() < 0.55 ? (rng() < 0.55 ? 1 : 2) : 0
  for (let i = 0; i < nArms; i++) {
    const armH = trunkH * (0.32 + rng() * 0.22)
    const armR = trunkR * 0.68
    const attachY = trunkH * (0.42 + rng() * 0.3)
    const side = i === 0 ? 1 : -1
    const arm = new THREE.CylinderGeometry(armR * 0.8, armR, armH, 6)
    arm.translate(0, armH / 2, 0)
    arm.rotateZ(side * 1.05)
    arm.translate(side * trunkR * 1.2, attachY, 0)
    parts.push(arm)
  }
  const merged = mergeGeometries(parts)
  for (const p of parts) p.dispose()
  merged.computeVertexNormals()
  return merged
}

/**
 * Lay a placed tree's roots over the terrain: each root vertex keeps its
 * height above the soil (relative to the tree's base `baseY`) but measured
 * from the ground right under it.
 */
function drapeRoots(g: THREE.BufferGeometry, baseY: number, soilAt: (x: number, z: number) => number): void {
  const flag = g.getAttribute('aRoot')
  if (!flag) return
  const pos = g.getAttribute('position')
  for (let i = 0; i < pos.count; i++) {
    if (flag.getX(i) < 0.5) continue
    const x = pos.getX(i)
    const z = pos.getZ(i)
    // Root designs treat local y = 0 as the soil surface.
    pos.setY(i, soilAt(x, z) - 0.02 + (pos.getY(i) - baseY))
  }
  pos.needsUpdate = true
  g.deleteAttribute('aRoot')
}

/** Paint per-vertex colours into a (possibly indexed) geometry copy. */
function colorPart(g: THREE.BufferGeometry, hex: number, jitter: number, rng: () => number): THREE.BufferGeometry {
  const n = g.getAttribute('position').count
  const colors = new Float32Array(n * 3)
  _tc.set(hex)
  _tc.offsetHSL(0, (rng() - 0.5) * 0.05, (rng() - 0.5) * jitter)
  for (let i = 0; i < n; i++) {
    colors[i * 3] = _tc.r
    colors[i * 3 + 1] = _tc.g
    colors[i * 3 + 2] = _tc.b
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return g
}

export class ChunkManager {
  private chunks = new Map<string, Chunk>()
  private time = 0
  /** 0..1 share of grass clumps drawn (adaptive quality thins it on slow GPUs). */
  private grassDensity = 1

  /**
   * Clumps are stored in rank order (each tier a prefix of the full set),
   * so drawing only the first N thins the meadow evenly — no holes, no pop.
   */
  setGrassDensity(f: number): void {
    this.grassDensity = THREE.MathUtils.clamp(f, 0.2, 1)
    for (const c of this.chunks.values()) {
      c.detail?.traverse((o) => {
        if (o.userData.grassPlaced !== undefined) (o as THREE.InstancedMesh).count = Math.floor(o.userData.grassPlaced * this.grassDensity)
      })
    }
  }
  private lastPlayer = new THREE.Vector3()

  constructor(
    private scene: THREE.Scene,
    private sittables: Sittable[],
    private trunks: TrunkCollider[],
    private avoid: Sittable[],
    private grass: Grass,
  ) {}

  /** Boot only: synchronously fill a radius around spawn so frame 1 has no sky holes (budgeting only applies to live streaming). */
  prehydrate(playerPos: THREE.Vector3, radius = 1): void {
    this.lastPlayer.copy(playerPos)
    const pcx = Math.floor(playerPos.x / CHUNK)
    const pcz = Math.floor(playerPos.z / CHUNK)
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const key = `${pcx + dx},${pcz + dz}`
        if (!this.chunks.has(key)) this.chunks.set(key, this.build(pcx + dx, pcz + dz, key))
      }
    }
  }

  /** Per-frame: stream chunks around the player (with move-ahead prefetch) + tick wind. */
  update(dt: number, playerPos: THREE.Vector3, playerVel?: THREE.Vector3, sunDir?: THREE.Vector3, day = 1): void {
    this.time += dt
    this.lastPlayer.copy(playerPos)
    this.grass.update(this.time, sunDir, day)
    setBendyPlayer(playerPos)
    setFoliageTime(this.time)
    updateTrail(playerPos, dt, playerPos.y - groundHeight(playerPos.x, playerPos.z) > 0.6)

    const pcx = Math.floor(playerPos.x / CHUNK)
    const pcz = Math.floor(playerPos.z / CHUNK)

    // Gather every missing cell we'd want loaded (ring + move-ahead
    // prefetch), nearest-first, then build until BUILD_BUDGET_MS is spent this
    // frame. The rest stay "missing" and get picked up next frame — no
    // separate queue needed, this naturally drains over a few frames.
    const missing: Array<{ cx: number; cz: number; key: string; d: number }> = []
    const consider = (cx: number, cz: number) => {
      const key = `${cx},${cz}`
      if (this.chunks.has(key) || missing.some((m) => m.key === key)) return
      const ddx = cx - pcx
      const ddz = cz - pcz
      missing.push({ cx, cz, key, d: ddx * ddx + ddz * ddz })
    }
    for (let dz = -LOAD_R; dz <= LOAD_R; dz++) {
      for (let dx = -LOAD_R; dx <= LOAD_R; dx++) consider(pcx + dx, pcz + dz)
    }
    if (playerVel) {
      const sp = Math.hypot(playerVel.x, playerVel.z)
      if (sp > 1.2) {
        const sx = Math.sign(playerVel.x)
        const sz = Math.sign(playerVel.z)
        consider(pcx + sx * (LOAD_R + 1), pcz)
        consider(pcx, pcz + sz * (LOAD_R + 1))
        consider(pcx + sx * (LOAD_R + 1), pcz + sz * (LOAD_R + 1))
      }
    }
    missing.sort((a, b) => a.d - b.d)
    const deadline = performance.now() + BUILD_BUDGET_MS
    for (const m of missing) {
      this.chunks.set(m.key, this.build(m.cx, m.cz, m.key))
      if (performance.now() > deadline) break
    }

    // Detail LOD: chunks are born at the outer (sparse) tier as you walk, so
    // refresh grass/flowers as they come closer — nearest first, same budget.
    // Without this, the ground under your feet kept far-band grass density.
    const stale: Array<{ chunk: Chunk; tier: number; ring: number }> = []
    for (const chunk of this.chunks.values()) {
      const ring = Math.max(Math.abs(chunk.cx - pcx), Math.abs(chunk.cz - pcz))
      const tier = tierFor(ring)
      if (tier !== chunk.tier) stale.push({ chunk, tier, ring })
    }
    stale.sort((a, b) => a.ring - b.ring)
    for (const st of stale) {
      // The chunk you're standing in / next to always gets done this frame.
      if (performance.now() > deadline && st.ring > 1) break
      this.buildDetail(st.chunk, st.tier)
    }
    // Unload far.
    for (const [key, chunk] of this.chunks) {
      const [cx, cz] = key.split(',').map(Number)
      if (Math.abs(cx - pcx) > UNLOAD_R || Math.abs(cz - pcz) > UNLOAD_R) {
        this.scene.remove(chunk.group)
        this.disposeChunk(chunk)
        this.chunks.delete(key)
      }
    }
  }

  /**
   * Dispose only per-chunk geometry. Shared geometry (flower variants) + materials are
   * SHARED across chunks — disposing them blanks every blade (the invisible-
   * grass bug). Materials are shared across chunks likewise: never dispose.
   */
  private disposeChunk(chunk: Chunk): void {
    chunk.group.traverse((o) => {
      const mesh = o as THREE.Mesh
      if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
        // Usually shared geometry — free this mesh's instance buffers, plus its
        // geometry only when it owns a private clone (grass clumps).
        ;(mesh as THREE.InstancedMesh).dispose()
        if (mesh.userData.ownsGeometry) mesh.geometry.dispose()
      } else if (mesh.geometry) {
        mesh.geometry.dispose()
      }
    })
    for (const s of chunk.sittables) {
      const i = this.sittables.indexOf(s)
      if (i >= 0) this.sittables.splice(i, 1)
    }
    for (const t of chunk.trunks) {
      const i = this.trunks.indexOf(t)
      if (i >= 0) this.trunks.splice(i, 1)
    }
  }

  private build(cx: number, cz: number, key: string): Chunk {
    const group = new THREE.Group()
    const x0 = cx * CHUNK
    const z0 = cz * CHUNK
    const rng = chunkRng(cx, cz)
    // Detail density (grass/flowers) follows the ring; it's refreshed in
    // update() as the chunk moves between tiers, not frozen at build time.
    const ring = Math.max(Math.abs(cx - Math.floor(this.lastPlayer.x / CHUNK)), Math.abs(cz - Math.floor(this.lastPlayer.z / CHUNK)))

    // -- Terrain patch ------------------------------------------------------
    // Height + biome + colour grid at 2 m spacing. Grass reads from this
    // instead of re-running the full noise stack per blade — that was ~15
    // terrain evaluations × 2300 blades, the bulk of chunk build time.
    const N1 = SEG + 1
    const step = CHUNK / SEG
    const hGrid = new Float32Array(N1 * N1)
    const bGrid: Biome[] = new Array(N1 * N1)
    const cGrid = new Float32Array(N1 * N1 * 3)
    for (let iz = 0; iz < N1; iz++) {
      for (let ix = 0; ix < N1; ix++) {
        const x = x0 + ix * step
        const z = z0 + iz * step
        const gi = iz * N1 + ix
        hGrid[gi] = groundHeight(x, z)
        bGrid[gi] = biomeAt(x, z)
        terrainColorAt(x, z, _tc)
        cGrid[gi * 3] = _tc.r
        cGrid[gi * 3 + 1] = _tc.g
        cGrid[gi * 3 + 2] = _tc.b
      }
    }
    // The mesh itself is 1 m: a 2 m grid cut shorelines into long straight
    // polygon edges. Heights are exact; colours interpolate the 2 m grid.
    const MSEG = SEG * 2
    const geo = new THREE.PlaneGeometry(CHUNK, CHUNK, MSEG, MSEG)
    geo.rotateX(-Math.PI / 2)
    geo.translate(x0 + CHUNK / 2, 0, z0 + CHUNK / 2)
    const pos = geo.getAttribute('position')
    const colors = new Float32Array(pos.count * 3)
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      const z = pos.getZ(i)
      pos.setY(i, groundHeight(x, z))
      const fx = (x - x0) / step
      const fz = (z - z0) / step
      const ix = Math.min(SEG - 1, Math.floor(fx))
      const iz = Math.min(SEG - 1, Math.floor(fz))
      const tx = fx - ix
      const tz = fz - iz
      const a = (iz * N1 + ix) * 3
      const b = a + 3
      const c = a + N1 * 3
      const d = c + 3
      for (let k = 0; k < 3; k++) {
        colors[i * 3 + k] = (cGrid[a + k] * (1 - tx) + cGrid[b + k] * tx) * (1 - tz) + (cGrid[c + k] * (1 - tx) + cGrid[d + k] * tx) * tz
      }
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    /** Soil height for draping roots: the chunk's height grid, noise outside it. */
    const soilAt = (x: number, z: number): number => {
      const fx = (x - x0) / step
      const fz = (z - z0) / step
      if (fx < 0 || fz < 0 || fx > SEG || fz > SEG) return groundHeight(x, z)
      const ix = Math.min(SEG - 1, Math.floor(fx))
      const iz = Math.min(SEG - 1, Math.floor(fz))
      const tx = fx - ix
      const tz = fz - iz
      const a = hGrid[iz * N1 + ix]
      const b = hGrid[iz * N1 + ix + 1]
      const c = hGrid[(iz + 1) * N1 + ix]
      const d = hGrid[(iz + 1) * N1 + ix + 1]
      return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz
    }
    geo.computeVertexNormals()
    geo.computeBoundingSphere()
    const terrain = new THREE.Mesh(geo, matTerrain)
    terrain.receiveShadow = true
    group.add(terrain)

    // -- Props: procedural stylised assets (foliage.ts) ------------------------
    const scatterParts: THREE.BufferGeometry[] = []
    const canopyParts: THREE.BufferGeometry[] = [] // leaf cards → one foliage mesh per chunk
    const madeSittables: Sittable[] = []
    const madeTrunks: TrunkCollider[] = []
    const blockers: Blocker[] = [] // grass/prop exclusion
    const chunkBiome = biomeAt(x0 + CHUNK / 2, z0 + CHUNK / 2)
    
    // Boulders — 1–2 per chunk, sittable. Smooth high-subdivision rocks with
    // moss on top (foliage.ts), not faceted low-poly kit models.
    const nRocks = 1 + Math.floor(rng() * 2)
    for (let i = 0; i < nRocks; i++) {
      const rx = x0 + rng() * CHUNK
      const rz = z0 + rng() * CHUNK
      if (this.nearAvoid(rx, rz, 4)) continue
      const biome = biomeAt(rx, rz)
      if (biome === 'ocean' || biome === 'lake') continue
      const s = 1.5 + rng() * 1.6
      const gy = groundHeight(rx, rz)
      const rock = BOULDER_POOL[Math.floor(rng() * BOULDER_POOL.length)]
      _fq.setFromEuler(_fe.set(0, rng() * Math.PI * 2, 0))
      const g = rock.geometry.clone().applyMatrix4(_fm.compose(_fv.set(rx, gy - 0.15, rz), _fq, _fs.set(s, s, s)))
      scatterParts.push(g)
      const topY = gy - 0.15 + rock.top * s * 0.9
      const radius = s * 0.85
      blockers.push({ x: rx, z: rz, r: radius })
      madeSittables.push({ label: 'flat rock', kind: 'rock', x: rx, z: rz, topY, radius })
    }

    // Cacti — desert only, fully procedural.
    if (chunkBiome === 'desert') {
      const nCacti = 2 + Math.floor(rng() * 4)
      for (let i = 0; i < nCacti; i++) {
        const cx = x0 + rng() * CHUNK
        const cz = z0 + rng() * CHUNK
        if (biomeAt(cx, cz) !== 'desert') continue
        if (this.nearBlocker(cx, cz, blockers, 1.4)) continue
        const g = buildCactusGeometry(rng)
        g.rotateY(rng() * Math.PI * 2)
        g.scale(1, 0.9 + rng() * 0.3, 1)
        const gy = groundHeight(cx, cz)
        g.translate(cx, gy, cz)
        scatterParts.push(colorPart(g, 0x4c7a4f, 0.08, rng))
        blockers.push({ x: cx, z: cz, r: 0.6 })
      }
    }

    // Pebbles — small smooth stones on meadows and beaches (water beds bare).
    const nPebbles = 3 + Math.floor(rng() * 5)
    for (let i = 0; i < nPebbles; i++) {
      const px = x0 + rng() * CHUNK
      const pz = z0 + rng() * CHUNK
      const biome = biomeAt(px, pz)
      if (biome === 'ocean' || biome === 'lake') continue
      if (this.nearBlocker(px, pz, blockers, 0.9)) continue
      const ps = 0.2 + rng() * 0.35
      _fq.setFromEuler(_fe.set(0, rng() * Math.PI * 2, 0))
      const g = PEBBLE_POOL[Math.floor(rng() * PEBBLE_POOL.length)].clone()
      g.applyMatrix4(_fm.compose(_fv.set(px, groundHeight(px, pz) - 0.06, pz), _fq, _fs.set(ps, ps, ps)))
      scatterParts.push(g)
    }

    // Bushes — round leafy clumps (forest understory + meadow hedgerows) that
    // part around the player (aBend in the foliage shader).
    const nBushes = (chunkBiome === 'forest' ? 6 : 3) + Math.floor(rng() * 3)
    for (let i = 0; i < nBushes; i++) {
      const bx = x0 + 3 + rng() * (CHUNK - 6)
      const bz = z0 + 3 + rng() * (CHUNK - 6)
      const biome = biomeAt(bx, bz)
      if (biome !== 'meadow' && biome !== 'tallgrass' && biome !== 'forest') continue
      if (slopeAt(bx, bz) > 0.7) continue
      if (this.nearBlocker(bx, bz, blockers, 1.6)) continue
      const sc = 0.9 + rng() * 0.7
      _fq.setFromEuler(_fe.set(0, rng() * Math.PI * 2, 0))
      const g = BUSH_VARIANTS[Math.floor(rng() * BUSH_VARIANTS.length)].clone()
      g.applyMatrix4(_fm.compose(_fv.set(bx, groundHeight(bx, bz) - 0.1, bz), _fq, _fs.set(sc, sc * (0.85 + rng() * 0.3), sc)))
      canopyParts.push(g)
      blockers.push({ x: bx, z: bz, r: 0.9 * sc })
    }

    // Trees — big stylised canopies (foliage.ts). Density by biome: forest
    // 9–14 mixed broadleaf/poplar/conifer, meadows the odd lone giant (the
    // Genshin landmark tree), clearings a sparse conifer, rock/water none.
    const forestAt = chunkBiome === 'forest'
    const treeCount = forestAt
      ? 9 + Math.floor(rng() * 6)
      : chunkBiome === 'meadow' || chunkBiome === 'tallgrass'
        ? rng() < 0.2 ? 2 : rng() < 0.7 ? 1 : 0
        : chunkBiome === 'clearing' ? (rng() < 0.3 ? 1 : 0) : 0
    for (let i = 0; i < treeCount; i++) {
      const tx = x0 + 4 + rng() * (CHUNK - 8)
      const tz = z0 + 4 + rng() * (CHUNK - 8)
      const biome = biomeAt(tx, tz)
      if (!grassy(biome)) continue
      if (slopeAt(tx, tz) > 0.55) continue
      if (tx * tx + tz * tz < 14 * 14) continue // keep spawn meadow open
      if (this.nearBlocker(tx, tz, blockers, forestAt ? 2.6 : 5)) continue
      const roll = rng()
      const kind: TreeKind = biome === 'clearing' ? 'pine' : forestAt ? (roll < 0.45 ? 'broadleaf' : roll < 0.75 ? 'tall' : 'pine') : 'broadleaf'
      const list = TREE_VARIANTS[kind]
      const v = list[Math.floor(rng() * list.length)]
      const sc = forestAt ? 0.85 + rng() * 0.3 : 1.0 + rng() * 0.25
      const rot = rng() * Math.PI * 2
      const gy = groundHeight(tx, tz) - 0.15
      // One combined transform per tree (rotate·scale·translate in a single
      // pass over the vertices, not three).
      _fq.setFromEuler(_fe.set(0, rot, 0))
      _fm.compose(_fv.set(tx, gy, tz), _fq, _fs.set(sc, sc, sc))
      const tg = withUv(v.trunk.clone().applyMatrix4(_fm))
      drapeRoots(tg, gy, soilAt)
      scatterParts.push(tg)
      canopyParts.push(v.canopy.clone().applyMatrix4(_fm))
      const trunkR = v.trunkR * sc * 1.25
      madeTrunks.push({ x: tx, z: tz, r: trunkR })
      blockers.push({ x: tx, z: tz, r: trunkR + 1.4 })
    }

    if (scatterParts.length > 0) {
      const merged = mergeGeometries(scatterParts)
      merged.computeBoundingSphere()
      for (const p of scatterParts) p.dispose()
      const scatter = new THREE.Mesh(merged, matScatter)
      scatter.castShadow = true
      scatter.receiveShadow = true
      group.add(scatter)
    }

    if (canopyParts.length > 0) {
      const merged = mergeGeometries(canopyParts)
      merged.computeBoundingSphere()
      for (const p of canopyParts) p.dispose()
      const canopy = new THREE.Mesh(merged, foliageMat())
      // Alpha-tested leaf cards cast dappled shadows (the depth pass honours
      // map + alphaTest); no self-receive — it speckles the soft blob shading.
      canopy.castShadow = true
      canopy.receiveShadow = false
      group.add(canopy)
    }

    for (const s of madeSittables) this.sittables.push(s)
    for (const t of madeTrunks) this.trunks.push(t)
    this.scene.add(group)
    const chunk: Chunk = { group, sittables: madeSittables, trunks: madeTrunks, cx, cz, hGrid, bGrid, blockers, detail: null, tier: -1 }
    this.buildDetail(chunk, tierFor(ring))
    return chunk
  }

  /**
   * (Re)build a chunk's detail layer — grass blades + wildflowers — at the
   * density for `tier`. Uses its own deterministic RNG stream so a chunk's
   * meadow looks the same every time it's rebuilt at a given tier.
   */
  private buildDetail(chunk: Chunk, tier: number): void {
    if (chunk.detail) {
      chunk.group.remove(chunk.detail)
      // Geometry is shared (grass GLB / flower variants) — free only the
      // per-mesh instance buffers.
      chunk.detail.traverse((o) => {
        const im = o as THREE.InstancedMesh
        if (!im.isInstancedMesh) return
        im.dispose()
        if (im.userData.ownsGeometry) im.geometry.dispose()
      })
    }
    const detail = new THREE.Group()
    const { cx, cz, hGrid, bGrid, blockers } = chunk
    const x0 = cx * CHUNK
    const z0 = cz * CHUNK
    const rng = chunkRng(cx * 31 + 7, cz * 17 + 3)
    const N1 = SEG + 1
    const step = CHUNK / SEG
    // Bilinear height on the same grid the terrain mesh is built from — so
    // blades/flowers sit exactly on the rendered surface.
    const gridH = (fx: number, fz: number) => {
      const ix = Math.min(SEG - 1, Math.floor(fx))
      const iz = Math.min(SEG - 1, Math.floor(fz))
      const tx = fx - ix
      const tz = fz - iz
      const a = hGrid[iz * N1 + ix]
      const b = hGrid[iz * N1 + ix + 1]
      const c = hGrid[(iz + 1) * N1 + ix]
      const d = hGrid[(iz + 1) * N1 + ix + 1]
      return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz
    }
    const biomeOf = (fx: number, fz: number) => bGrid[Math.round(fz) * N1 + Math.round(fx)]

    // -- Wildflowers (foliage.ts) — bendable instances, one per variety.
    // Scaled to stand a little proud of the meadow grass.
    const flowerPlacements = new Map<number, Placement[]>()
    for (let cIdx = 0; cIdx < FLOWER_CLUSTERS_BY_TIER[tier]; cIdx++) {
      const ccx = 4 + rng() * (CHUNK - 8)
      const ccz = 4 + rng() * (CHUNK - 8)
      const tint = pickFlower(rng) // clusters lean to one colour, with strays
      for (let f = 0; f < FLOWERS_PER_CLUSTER; f++) {
        const lx = THREE.MathUtils.clamp(ccx + (rng() - 0.5) * 4.5, 0, CHUNK)
        const lz = THREE.MathUtils.clamp(ccz + (rng() - 0.5) * 4.5, 0, CHUNK)
        const variant = rng() < 0.75 ? tint : pickFlower(rng)
        const scale = 1.6 + rng() * 0.5
        const rotY = rng() * Math.PI * 2
        const biome = biomeOf(lx / step, lz / step)
        if (biome !== 'meadow' && biome !== 'tallgrass' && biome !== 'clearing') continue
        if (this.nearBlocker(x0 + lx, z0 + lz, blockers, 0.5)) continue
        if (gridH(lx / step, lz / step) < WATER_Y + 0.05) continue
        const list = flowerPlacements.get(variant) ?? []
        list.push({ x: x0 + lx, y: gridH(lx / step, lz / step) - 0.03, z: z0 + lz, scale, rotY })
        flowerPlacements.set(variant, list)
      }
    }
    for (const [variant, list] of flowerPlacements) {
      const v = FLOWER_VARIANTS[variant]
      if (!v || list.length === 0) continue
      const inst = new THREE.InstancedMesh(v.geometry, bendyMat(v.height, 0.6, 1.1, flowerAtlas()), list.length)
      list.forEach((p, i) => {
        _fq.setFromEuler(_fe.set(0, p.rotY, 0))
        _fm.compose(_fv.set(p.x, p.y, p.z), _fq, _fs.set(p.scale, p.scale, p.scale))
        inst.setMatrixAt(i, _fm)
      })
      inst.castShadow = tier === 0
      inst.receiveShadow = true
      detail.add(inst)
    }

    // -- Grass (grass.ts): individual-blade clumps, gusting wind, contact.
    // Own RNG stream with every draw taken up front, so each sparser tier is
    // an exact prefix of the full one; aRank lets the shader thin density
    // smoothly by distance — a tier change never pops.
    {
      const maxGrass = GRASS_BY_TIER[tier]
      const grng = chunkRng(cx * 31 + 11, cz * 17 + 5)
      // Clump geometry is tiny (≤84 verts): clone per chunk so each carries its
      // own per-instance rank attribute. Freed with the detail layer.
      const ranks = new Float32Array(maxGrass)
      const clump = (tier === 0 ? this.grass.near : this.grass.far).clone()
      clump.setAttribute('aRank', new THREE.InstancedBufferAttribute(ranks, 1))
      const grass = new THREE.InstancedMesh(clump, this.grass.material, maxGrass)
      grass.userData.ownsGeometry = true
      const q = new THREE.Quaternion()
      const up = new THREE.Vector3(0, 1, 0)
      const nrm = new THREE.Vector3()
      let placed = 0
      for (let i = 0; i < maxGrass; i++) {
        const lx = grng() * CHUNK
        const lz = grng() * CHUNK
        const sxzR = grng()
        const syR = grng()
        const spin = grng() * Math.PI * 2
        const tip = grng() * 0.24
        const gx = x0 + lx
        const gz = z0 + lz
        const fx = lx / step
        const fz = lz / step
        const biome = biomeOf(fx, fz)
        if (!grassy(biome)) continue // water / sand / rock: no grass
        if (this.nearBlocker(gx, gz, blockers, 1.3)) continue
        const gy = gridH(fx, fz)
        if (gy < WATER_Y + 0.05) continue // nearest-vertex biome can be 'grassy' just past the waterline
        // Real metres: meadow ≈ 0.6–0.9 m (knee/thigh), tallgrass ≈ 1.0–1.35 m
        // (waist), clearings short. Footprint scales separately from height.
        const tall = biome === 'tallgrass'
        const sxz = tall ? 1.15 + sxzR * 0.35 : 1.0 + sxzR * 0.4
        const sy = tall ? 1.05 + syR * 0.3 : biome === 'clearing' ? 0.45 + syR * 0.25 : 0.65 + syR * 0.3
        // Align the clump to the hillside (finite difference on the grid).
        const fxl = Math.max(0, fx - 1)
        const fxh = Math.min(SEG, fx + 1)
        const fzl = Math.max(0, fz - 1)
        const fzh = Math.min(SEG, fz + 1)
        nrm.set(
          (gridH(fxl, fz) - gridH(fxh, fz)) / ((fxh - fxl) * step),
          1,
          (gridH(fx, fzl) - gridH(fx, fzh)) / ((fzh - fzl) * step),
        ).normalize()
        q.setFromUnitVectors(up, nrm)
        q.multiply(_spin.setFromEuler(_fe.set(0, spin, 0)))
        q.multiply(_spin.setFromEuler(_fe.set(tip, 0, 0))) // natural 0–14° lean
        _fm.compose(_fv.set(gx, gy - 0.04, gz), q, _fs.set(sxz, sy, sxz))
        grass.setMatrixAt(placed, _fm)
        ranks[placed] = i / GRASS_BY_TIER[0]
        placed++
      }
      grass.userData.grassPlaced = placed
      grass.count = Math.floor(placed * this.grassDensity)
      // Cull per chunk (bounds from the placed clumps, padded for sway and
      // blade height) — the meadow behind the camera isn't drawn.
      grass.computeBoundingSphere()
      if (grass.boundingSphere) grass.boundingSphere.radius += 2
      grass.receiveShadow = true
      grass.castShadow = false
      detail.add(grass)
    }

    chunk.group.add(detail)
    chunk.detail = detail
    chunk.tier = tier
  }

  private nearBlocker(x: number, z: number, blockers: Array<{ x: number; z: number; r: number }>, r: number): boolean {
    for (const b of blockers) {
      if (Math.hypot(b.x - x, b.z - z) < b.r + r) return true
    }
    return false
  }

  private nearAvoid(x: number, z: number, r: number): boolean {
    for (const a of this.avoid) {
      if (Math.abs(a.x - x) < r && Math.abs(a.z - z) < r && Math.hypot(a.x - x, a.z - z) < r) return true
    }
    return false
  }

}
