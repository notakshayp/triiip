import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { mergeGeometries } from './geometry'
import { toonMat } from './toon'

// ---------------------------------------------------------------------------
// Kenney Nature Kit props (CC0, kenney.nl) — GLB mirrors of the official pack.
// The models use per-material flat colours; we BAKE those colours into vertex
// colour attributes and merge every model into ONE BufferGeometry. That way
// they join the chunk scatter pipeline (MeshLambertMaterial, vertexColors) —
// all rocks/trees/bushes/flowers in a chunk stay a single draw call.
// ---------------------------------------------------------------------------

export interface KenneyModel {
  /** Baked, XZ-centred, feet-at-y=0 geometry (world scale = metres). */
  geometry: THREE.BufferGeometry
  height: number
  radius: number
}

export const KENNEY_PROPS = [
  // Rocks, trees, bushes and flowers are procedural (foliage.ts) — only the
  // spawn-meadow log + stumps still come from the kit.
  'log',
  'stump-round', 'stump-squaredetailed', 'stump-old',
] as const

export type KenneyName = (typeof KENNEY_PROPS)[number]

class KenneyLib {
  private models = new Map<string, KenneyModel>()
  readonly ready: Promise<void>

  constructor() {
    const loader = new GLTFLoader()
    this.ready = Promise.all(
      KENNEY_PROPS.map(
        (name) =>
          new Promise<void>((resolve) => {
            loader.load(
              `${import.meta.env.BASE_URL}kenney/${name}.glb`,
              (gltf) => {
                try {
                  this.models.set(name, bake(gltf.scene, name))
                } catch (e) {
                  console.error(`[Kenney] bake failed: ${name}`, e)
                }
                resolve()
              },
              undefined,
              () => {
                console.error(`[Kenney] load failed: ${name}.glb`)
                resolve()
              },
            )
          }),
      ),
    ).then(() => undefined)
  }

  has(name: string): boolean {
    return this.models.has(name)
  }

  get(name: string): KenneyModel | undefined {
    return this.models.get(name)
  }
}

export const kenney = new KenneyLib()

/** Shared material for every baked (vertex-coloured) model — cel-shaded. */
let _mat: THREE.MeshToonMaterial | null = null
export function kenneyMat(): THREE.MeshToonMaterial {
  _mat ??= toonMat({ vertexColors: true })
  return _mat
}


const _stone = new THREE.Color(0x8b959b)
const _wood = new THREE.Color(0x7a5a3a)
const _bakeC = new THREE.Color()

/** Merge a GLTF scene into one geometry with baked vertex colours + normalised pivot. */
function bake(root: THREE.Object3D, name = ''): KenneyModel {
  const stonify = name.startsWith('rock')
  const woodify = name.startsWith('log') || name.startsWith('stump')
  root.updateWorldMatrix(true, true)
  const parts: THREE.BufferGeometry[] = []
  const color = new THREE.Color()
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    const src = mesh.geometry.clone()
    src.applyMatrix4(mesh.matrixWorld)
    const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial | undefined
    color.copy(mat?.color ?? new THREE.Color(0xff00ff))
    if (stonify) {
      // Kenney's "dirt" rock sides read as sand bags — nudge warm browns
      // toward stone grey while keeping the mossy green tops untouched.
      _bakeC.copy(color)
      if (_bakeC.r > _bakeC.g * 1.05) _bakeC.lerp(_stone, 0.72)
      // Greens stay, slightly desaturated toward meadow olive.
      if (_bakeC.g >= _bakeC.r) _bakeC.offsetHSL(0.02, -0.12, 0)
      color.copy(_bakeC)
    } else if (woodify) {
      // Pale tan bark → a richer meadow-wood brown.
      _bakeC.copy(color)
      if (_bakeC.r > _bakeC.b) {
        _bakeC.lerp(_wood, 0.45)
      }
      color.copy(_bakeC)
    }
    const n = src.getAttribute('position').count
    const colors = new Float32Array(n * 3)
    for (let i = 0; i < n; i++) {
      colors[i * 3] = color.r
      colors[i * 3 + 1] = color.g
      colors[i * 3 + 2] = color.b
    }
    src.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    // Keep attribute sets uniform across the pack (models ship POSITION,
    // NORMAL, TEXCOORD_0) — drop nothing, merge everything.
    parts.push(src)
  })
  const merged = mergeGeometries(parts)
  for (const p of parts) p.dispose()
  // Pivot: centre XZ, feet at y=0. Report real-world dims before decimation.
  merged.computeBoundingBox()
  const bb = merged.boundingBox!
  const size = bb.getSize(new THREE.Vector3())
  merged.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2)
  merged.computeBoundingSphere()
  return { geometry: merged, height: size.y, radius: Math.max(size.x, size.z) / 2 }
}

const _jc = new THREE.Color()

/** Place a Kenney model: returns a positioned clone (build-time only). */
export function placeKenney(
  name: string,
  x: number,
  y: number,
  z: number,
  scale: number,
  rotY: number,
  jitter = 0,
  rng: () => number = Math.random,
  colorJitter = 0,
): THREE.BufferGeometry | undefined {
  const model = kenney.get(name)
  if (!model) return undefined
  const clone = model.geometry.clone()
  clone.rotateY(rotY)
  clone.scale(scale, scale * (1 + (rng() - 0.5) * jitter), scale)
  clone.translate(x, y, z)
  if (colorJitter > 0) {
    const col = clone.getAttribute('color') as THREE.BufferAttribute | undefined
    if (col) {
      const dh = (rng() - 0.5) * colorJitter
      const dl = (rng() - 0.5) * colorJitter * 0.6
      for (let i = 0; i < col.count; i++) {
        _jc.setRGB(col.getX(i), col.getY(i), col.getZ(i))
        _jc.offsetHSL(dh, 0, dl)
        col.setXYZ(i, _jc.r, _jc.g, _jc.b)
      }
      col.needsUpdate = true
    }
  }
  return clone
}
