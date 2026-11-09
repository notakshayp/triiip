import * as THREE from 'three'
import { biomeAt, groundHeight, terrainColorAt } from './terrain'
import { toonMat, playerPosUniform } from './toon'
import { TREE_VARIANTS, foliageMat, type TreeKind } from './foliage'

// ---------------------------------------------------------------------------
// Far LOD — fills the horizon past the streamed chunks (~150 m) out to ~1 km:
//   • one low-res terrain grid (12 m spacing), vertex-coloured with the same
//     terrainColorAt as the near chunks, sunk 0.6 m and discarded inside the
//     near radius so the detailed chunks always win;
//   • billboard "impostor" trees, one texture per tree kind, rendered at boot
//     from the real tree models, so distant forests look like the near ones.
// Rebuilds are time-sliced (a few ms per frame) whenever the player drifts
// far from the grid centre, so streaming never causes a frame spike. Tree
// placement is anchored to a world grid, so recentring doesn't reshuffle.
// ---------------------------------------------------------------------------

const R = 960 // half-size of the far grid
const SEG = 160 // 12 m spacing
const INNER = 95 // inside this the near chunks own the ground (far mesh discarded)
const TREE_INNER = 130 // impostors fade in from here (near chunk trees end ~145 m+)
const TREE_CELL = 12
const RECENTER = 128 // rebuild once the player is this far from the grid centre
const SNAP = 64
const MAX_PER_KIND = 8000
const KINDS: TreeKind[] = ['broadleaf', 'tall', 'pine']

interface Job {
  cx: number
  cz: number
  i: number // next vertex
  cellX: number // next tree cell (world grid)
  cellZ: number
  cellX0: number
  cellX1: number
  cellZ1: number
  pos: Float32Array
  col: Float32Array
  trees: Record<TreeKind, number[]> // x, y, z, scale tuples
  phase: 'terrain' | 'trees'
}

const _c = new THREE.Color()
const _m = new THREE.Matrix4()
const _q = new THREE.Quaternion()
const _p = new THREE.Vector3()
const _s = new THREE.Vector3()

/** Stable per-cell hash in [0,1) — world-anchored, so trees don't move on recenter. */
function cellHash(ix: number, iz: number, salt: number): number {
  let h = Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(salt, 2246822519)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

export class FarTerrain {
  readonly mesh: THREE.Mesh
  readonly impostors: THREE.InstancedMesh[] = []
  private geo: THREE.PlaneGeometry
  private baseX: Float32Array
  private baseZ: Float32Array
  private center = new THREE.Vector2(Infinity, Infinity)
  private job: Job | null = null
  private impostorMats: THREE.MeshBasicMaterial[] = []
  private impostorAspect: Record<TreeKind, number> = { broadleaf: 1, tall: 1, pine: 1 }

  constructor() {
    this.geo = new THREE.PlaneGeometry(R * 2, R * 2, SEG, SEG)
    this.geo.rotateX(-Math.PI / 2)
    const p = this.geo.getAttribute('position')
    this.baseX = new Float32Array(p.count)
    this.baseZ = new Float32Array(p.count)
    for (let i = 0; i < p.count; i++) {
      this.baseX[i] = p.getX(i)
      this.baseZ[i] = p.getZ(i)
    }
    this.geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(p.count * 3), 3))

    const mat = toonMat({ vertexColors: true }, 0xcfe8ff, 0, 1, true) // ground: no rim, painted like chunks.ts
    const base = mat.onBeforeCompile
    mat.onBeforeCompile = (shader, renderer) => {
      base.call(mat, shader, renderer)
      shader.uniforms.uPlayerPos = playerPosUniform
      shader.uniforms.uInnerR = { value: INNER }
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vFarW;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFarW = (modelMatrix * vec4(transformed, 1.0)).xyz;')
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vFarW;\nuniform vec3 uPlayerPos;\nuniform float uInnerR;')
        .replace(
          '#include <clipping_planes_fragment>',
          '#include <clipping_planes_fragment>\nif (distance(vFarW.xz, uPlayerPos.xz) < uInnerR) discard;',
        )
    }
    this.mesh = new THREE.Mesh(this.geo, mat)
    this.mesh.visible = false
    this.mesh.frustumCulled = false
  }

  /**
   * Render each tree kind once into a transparent texture (orthographic, side
   * view) and set up one billboard InstancedMesh per kind. Needs the renderer,
   * so it's called from main.ts after boot.
   */
  bakeImpostors(renderer: THREE.WebGLRenderer): THREE.InstancedMesh[] {
    const prevTarget = renderer.getRenderTarget()
    const prevClear = renderer.getClearColor(new THREE.Color())
    const prevAlpha = renderer.getClearAlpha()
    for (const kind of KINDS) {
      const v = TREE_VARIANTS[kind][0]
      const scene = new THREE.Scene()
      scene.add(new THREE.Mesh(v.trunk, toonMat({ vertexColors: true })))
      scene.add(new THREE.Mesh(v.canopy, foliageMat()))
      const sun = new THREE.DirectionalLight(0xfff2d9, 2.4)
      sun.position.set(0.6, 1.4, 1)
      scene.add(sun, new THREE.HemisphereLight(0xd8ecff, 0x6b7f5a, 1.0))
      const box = new THREE.Box3().setFromObject(scene)
      const w = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) * 1.04
      const h = box.max.y * 1.02
      const cam = new THREE.OrthographicCamera(-w / 2, w / 2, h / 2, -h / 2, 0.1, 200)
      cam.position.set(0, h / 2, 60)
      cam.lookAt(0, h / 2, 0)
      const texW = 256
      const texH = Math.min(512, Math.round((texW * h) / w))
      const rt = new THREE.WebGLRenderTarget(texW, texH, { generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter })
      // Clear to transparent foliage-green, not black, so mip-downsampled
      // edges fringe green instead of dark at a distance.
      renderer.setRenderTarget(rt)
      renderer.setClearColor(0x3d5a2c, 0)
      renderer.clear()
      renderer.render(scene, cam)
      this.impostorAspect[kind] = h / w

      const mat = new THREE.MeshBasicMaterial({ map: rt.texture, alphaTest: 0.32, side: THREE.DoubleSide })
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uPlayerPos = playerPosUniform
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nuniform vec3 uPlayerPos;')
          .replace(
            '#include <project_vertex>',
            `// Cylindrical billboard: always faces the camera around Y, scaled
            // from the instance matrix, grown in past the near-tree radius.
            vec3 instPos = (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz;
            float sc = length(instanceMatrix[0].xyz);
            sc *= smoothstep(${TREE_INNER.toFixed(1)}, ${(TREE_INNER + 45).toFixed(1)}, distance(instPos.xz, uPlayerPos.xz));
            vec3 camR = normalize(vec3(viewMatrix[0][0], 0.0, viewMatrix[2][0]));
            vec3 wp = instPos + camR * transformed.x * sc + vec3(0.0, transformed.y * sc, 0.0);
            vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
            gl_Position = projectionMatrix * mvPosition;`,
          )
      }
      this.impostorMats.push(mat)
      const quad = new THREE.PlaneGeometry(1, this.impostorAspect[kind])
      quad.translate(0, this.impostorAspect[kind] / 2, 0)
      const inst = new THREE.InstancedMesh(quad, mat, MAX_PER_KIND)
      inst.count = 0
      inst.frustumCulled = false
      inst.visible = false
      this.impostors.push(inst)
    }
    renderer.setRenderTarget(prevTarget)
    renderer.setClearColor(prevClear, prevAlpha)
    return this.impostors
  }

  /** Day factor dims the (pre-lit) impostors at dusk/night and in storms. */
  setLight(day: number, cloud: number): void {
    // Impostors were baked under noon sun: at night they need to drop much
    // further and shift moonlight-blue to match the live-lit trees nearby.
    const n = THREE.MathUtils.smoothstep(day, 0.3, 0.65) // 0 night … 1 day
    const k = (0.2 + n * 0.8) * (1 - cloud * 0.35)
    for (const m of this.impostorMats) m.color.setRGB(k * (0.72 + n * 0.28), k * (0.82 + n * 0.18), k * (1.08 - n * 0.08))
  }

  update(playerPos: THREE.Vector3): void {
    const dx = playerPos.x - this.center.x
    const dz = playerPos.z - this.center.y
    const dist = Math.hypot(dx, dz)
    if (!this.job && (!Number.isFinite(dist) || dist > RECENTER)) {
      // Teleported (or first frame): the old grid is wrong, hide it until rebuilt.
      if (!Number.isFinite(dist) || dist > R * 0.5) this.setVisible(false)
      const cx = Math.round(playerPos.x / SNAP) * SNAP
      const cz = Math.round(playerPos.z / SNAP) * SNAP
      const n = this.baseX.length
      this.job = {
        cx,
        cz,
        i: 0,
        cellX0: Math.floor((cx - R) / TREE_CELL),
        cellX1: Math.floor((cx + R) / TREE_CELL),
        cellZ1: Math.floor((cz + R) / TREE_CELL),
        cellX: Math.floor((cx - R) / TREE_CELL),
        cellZ: Math.floor((cz - R) / TREE_CELL),
        pos: new Float32Array(n * 3),
        col: new Float32Array(n * 3),
        trees: { broadleaf: [], tall: [], pine: [] },
        phase: 'terrain',
      }
    }
    if (this.job) this.work(this.mesh.visible ? 3.5 : 12)
  }

  private setVisible(v: boolean): void {
    this.mesh.visible = v
    for (const i of this.impostors) i.visible = v
  }

  /** Advance the current rebuild for at most `budgetMs`, then commit if done. */
  private work(budgetMs: number): void {
    const job = this.job!
    const deadline = performance.now() + budgetMs
    const n = this.baseX.length
    while (job.phase === 'terrain' && job.i < n) {
      const i = job.i++
      const x = job.cx + this.baseX[i]
      const z = job.cz + this.baseZ[i]
      job.pos[i * 3] = x
      job.pos[i * 3 + 1] = groundHeight(x, z) - 0.6
      job.pos[i * 3 + 2] = z
      terrainColorAt(x, z, _c)
      job.col[i * 3] = _c.r
      job.col[i * 3 + 1] = _c.g
      job.col[i * 3 + 2] = _c.b
      if ((i & 31) === 0 && performance.now() > deadline) return
    }
    job.phase = 'trees'
    while (job.cellZ <= job.cellZ1) {
      const ix = job.cellX
      const iz = job.cellZ
      if (++job.cellX > job.cellX1) {
        job.cellX = job.cellX0
        job.cellZ++
      }
      const x = (ix + 0.15 + cellHash(ix, iz, 1) * 0.7) * TREE_CELL
      const z = (iz + 0.15 + cellHash(ix, iz, 2) * 0.7) * TREE_CELL
      if (Math.hypot(x - job.cx, z - job.cz) < TREE_INNER - SNAP) continue
      const roll = cellHash(ix, iz, 3)
      // Cheap reject before the (costly) biome lookup: most cells are empty.
      if (roll > 0.9) continue
      const biome = biomeAt(x, z)
      let kind: TreeKind | null = null
      if (biome === 'forest') {
        const k = cellHash(ix, iz, 4)
        kind = k < 0.45 ? 'broadleaf' : k < 0.75 ? 'tall' : 'pine'
      } else if ((biome === 'meadow' || biome === 'tallgrass') && roll < 0.03) kind = 'broadleaf'
      else if (biome === 'clearing' && roll < 0.025) kind = 'pine'
      if (kind) {
        const list = job.trees[kind]
        if (list.length / 4 < MAX_PER_KIND) {
          const v = TREE_VARIANTS[kind][0]
          list.push(x, groundHeight(x, z) - 0.3, z, v.width * (0.85 + cellHash(ix, iz, 5) * 0.35))
        }
      }
      if ((ix & 7) === 0 && performance.now() > deadline) return
    }
    this.commit()
  }

  private commit(): void {
    const job = this.job!
    const pos = this.geo.getAttribute('position') as THREE.BufferAttribute
    const col = this.geo.getAttribute('color') as THREE.BufferAttribute
    ;(pos.array as Float32Array).set(job.pos)
    ;(col.array as Float32Array).set(job.col)
    pos.needsUpdate = true
    col.needsUpdate = true
    this.geo.computeVertexNormals()
    this.geo.computeBoundingSphere()
    KINDS.forEach((kind, k) => {
      const inst = this.impostors[k]
      if (!inst) return
      const list = job.trees[kind]
      const count = list.length / 4
      for (let t = 0; t < count; t++) {
        const s = list[t * 4 + 3]
        _m.compose(_p.set(list[t * 4], list[t * 4 + 1], list[t * 4 + 2]), _q, _s.set(s, s, s))
        inst.setMatrixAt(t, _m)
      }
      inst.count = count
      inst.instanceMatrix.needsUpdate = true
    })
    this.center.set(job.cx, job.cz)
    this.job = null
    this.setVisible(true)
  }
}
