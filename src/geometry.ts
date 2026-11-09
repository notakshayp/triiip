import * as THREE from 'three'

/**
 * Geometry merge across every attribute any part carries (uv, colour, custom
 * per-vertex attributes like the foliage sway weight). Parts missing an
 * attribute get a default (colour → white, everything else → 0). Indexed and
 * non-indexed parts can be mixed.
 */
export function mergeGeometries(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let verts = 0
  let idx = 0
  const sizes = new Map<string, number>()
  for (const g of parts) {
    const count = g.getAttribute('position').count
    verts += count
    idx += g.getIndex() ? g.getIndex()!.count : count
    for (const name of Object.keys(g.attributes)) {
      if (!sizes.has(name)) sizes.set(name, g.getAttribute(name).itemSize)
    }
  }
  const out = new THREE.BufferGeometry()
  const arrays = new Map<string, Float32Array>()
  for (const [name, size] of sizes) {
    const arr = new Float32Array(verts * size)
    if (name === 'color') arr.fill(1)
    arrays.set(name, arr)
  }
  const index = new Uint32Array(idx)
  let vOff = 0
  let iOff = 0
  for (const g of parts) {
    const count = g.getAttribute('position').count
    for (const [name, size] of sizes) {
      const src = g.getAttribute(name)
      if (!src) continue
      const dst = arrays.get(name)!
      if (src instanceof THREE.BufferAttribute && src.array instanceof Float32Array && src.itemSize === size && !src.normalized) {
        dst.set(src.array.subarray(0, count * size), vOff * size) // fast path: one memcpy
      } else {
        for (let i = 0; i < count; i++) {
          for (let k = 0; k < size; k++) dst[(vOff + i) * size + k] = src.getComponent(i, k)
        }
      }
    }
    const gi = g.getIndex()
    if (gi) {
      for (let i = 0; i < gi.count; i++) index[iOff + i] = gi.getX(i) + vOff
      iOff += gi.count
    } else {
      for (let i = 0; i < count; i++) index[iOff + i] = vOff + i
      iOff += count
    }
    vOff += count
  }
  for (const [name, size] of sizes) out.setAttribute(name, new THREE.BufferAttribute(arrays.get(name)!, size))
  out.setIndex(new THREE.BufferAttribute(index, 1))
  return out
}
