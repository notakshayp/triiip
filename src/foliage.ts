import * as THREE from 'three'
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js'
import { mergeGeometries } from './geometry'
import { playerPosUniform, toonGradient, trailUniform, TRAIL_GLSL } from './toon'

// ---------------------------------------------------------------------------
// Stylised foliage + rocks, built the way Genshin / Ghibli-style trees are:
// canopies are clouds of alpha-cut leaf cards whose normals are bent to point
// out of the canopy blob they belong to — so the toon gradient shades each
// blob as one soft, round, painterly mass instead of hundreds of facets.
// Trunks/rocks are high-subdivision, smooth-normal meshes (no flat facets).
// Everything is generated once into a handful of variants, then cloned +
// transformed into each chunk's merged meshes (2 draw calls per chunk).
// ---------------------------------------------------------------------------

export type TreeKind = 'broadleaf' | 'tall' | 'pine'

export interface TreeVariant {
  kind: TreeKind
  trunk: THREE.BufferGeometry // position/normal/uv/color — merges with scatter
  canopy: THREE.BufferGeometry // position/normal/uv/color/aSway/aBend
  height: number
  width: number
  trunkR: number
}

/** Deterministic small PRNG (variants must be identical every load). */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Cheap 3D-ish value noise for rock shaping (local — avoids an import cycle with terrain.ts). */
function noise3(x: number, y: number, z: number): number {
  const s = Math.sin(x * 1.7 + y * 3.1) * 0.5 + Math.sin(y * 2.3 + z * 1.3) * 0.3 + Math.sin(z * 2.9 + x * 0.7) * 0.2
  return s * 0.5 + 0.5
}

// -- Leaf card texture --------------------------------------------------------

let _leafTex: THREE.Texture | null = null
/**
 * Foliage atlas, 512×256: left tile = a loose cluster of chunky leaves
 * (broadleaf canopies); right tile = a conifer frond (stem + fine needles).
 */
function leafTexture(): THREE.Texture {
  if (_leafTex) return _leafTex
  const S = 256
  const c = document.createElement('canvas')
  c.width = S * 2
  c.height = S
  const ctx = c.getContext('2d')!
  const rnd = prng(7)
  // Left: chunky leaves — reads as foliage mass at a distance and as
  // individual leaves up close.
  for (let i = 0; i < 22; i++) {
    const r = Math.sqrt(rnd()) * S * 0.36
    const a = rnd() * Math.PI * 2
    const x = S / 2 + Math.cos(a) * r
    const y = S / 2 + Math.sin(a) * r
    const len = S * (0.13 + rnd() * 0.07)
    const wid = len * (0.45 + rnd() * 0.15)
    const shade = 200 + Math.floor(rnd() * 55)
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(a + (rnd() - 0.5) * 1.2)
    ctx.fillStyle = `rgb(${shade},${shade},${shade})`
    ctx.beginPath()
    ctx.ellipse(0, 0, len / 2, wid / 2, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }
  // Right: conifer frond running bottom→top, needles angled forward off a
  // central stem, a few side shoots — dense, spiky, no bare gaps.
  ctx.save()
  ctx.translate(S + S / 2, S)
  ctx.lineCap = 'round'
  const frond = (x0: number, y0: number, ang: number, len: number, needleLen: number) => {
    const dx = Math.sin(ang)
    const dy = -Math.cos(ang)
    // Body: a tapered silhouette under the needles, so the alpha-tested card
    // reads as a dense spray rather than a few sticks.
    ctx.fillStyle = 'rgb(150,150,150)'
    ctx.beginPath()
    for (let k = 0; k <= 12; k++) {
      const t = k / 12
      const w = needleLen * 0.62 * (1 - t * 0.7)
      ctx.lineTo(x0 + dx * len * t + dy * w, y0 + dy * len * t - dx * w)
    }
    for (let k = 12; k >= 0; k--) {
      const t = k / 12
      const w = needleLen * 0.62 * (1 - t * 0.7)
      ctx.lineTo(x0 + dx * len * t - dy * w, y0 + dy * len * t + dx * w)
    }
    ctx.closePath()
    ctx.fill()
    ctx.strokeStyle = 'rgb(175,175,175)'
    ctx.lineWidth = 4
    ctx.beginPath()
    ctx.moveTo(x0, y0)
    ctx.lineTo(x0 + dx * len, y0 + dy * len)
    ctx.stroke()
    for (let k = 0; k < 34; k++) {
      const t = k / 33
      const px = x0 + dx * len * t
      const py = y0 + dy * len * t
      const nl = needleLen * (1 - t * 0.55)
      for (const side of [-1, 1]) {
        const na = ang + side * (0.75 + rnd() * 0.25)
        const shade = 205 + Math.floor(rnd() * 50)
        ctx.strokeStyle = `rgb(${shade},${shade},${shade})`
        ctx.lineWidth = 4
        ctx.beginPath()
        ctx.moveTo(px, py)
        ctx.lineTo(px + Math.sin(na) * nl, py - Math.cos(na) * nl)
        ctx.stroke()
      }
    }
  }
  frond(0, -6, 0, S * 0.92, S * 0.2)
  for (let i = 0; i < 4; i++) {
    const t = 0.2 + i * 0.17
    frond(0, -6 - S * 0.92 * t, (i % 2 ? 1 : -1) * 0.75, S * 0.34 * (1 - t * 0.5), S * 0.11)
  }
  ctx.restore()
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  _leafTex = tex
  return tex
}

// -- Foliage material (shared) -------------------------------------------------

const _foliageTime = { value: 0 }
export function setFoliageTime(t: number): void {
  _foliageTime.value = t
}

let _foliageMat: THREE.MeshToonMaterial | null = null
/** Cel-shaded leaf-card material: wind sway by height, bushes part around the player, sky rim light. */
export function foliageMat(): THREE.MeshToonMaterial {
  if (_foliageMat) return _foliageMat
  const mat = new THREE.MeshToonMaterial({
    gradientMap: toonGradient(),
    map: leafTexture(),
    vertexColors: true,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
  })
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uFoliageTime = _foliageTime
    shader.uniforms.uTrail = trailUniform
    shader.uniforms.uPlayerPos = playerPosUniform
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>\nattribute float aSway;\nattribute float aBend;\nuniform float uFoliageTime;\nvarying vec3 vFolW;\n${TRAIL_GLSL}`,
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vFolW = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          // Geometry is merged in world space (mesh at identity).
          float sw = aSway * aSway;
          float ph = dot(transformed.xz, vec2(0.11, 0.07));
          transformed.x += sin(uFoliageTime * 1.3 + ph) * 0.16 * sw;
          transformed.z += cos(uFoliageTime * 1.05 + ph * 1.3) * 0.12 * sw;
          transformed.y += sin(uFoliageTime * 2.1 + ph * 2.0) * 0.03 * sw;
          // Bushes give where your body pushes through them (contact trail),
          // then settle back — stiffer than grass, so a smaller give.
          vec2 push = trailPush(transformed.xz, 1.05);
          transformed.xz += push * aBend * aSway * 0.45;
          transformed.y -= length(push) * aBend * aSway * 0.12;
        }`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uPlayerPos;\nvarying vec3 vFolW;')
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
        {
          // Leaves between the camera and the cat (and right at the lens)
          // fade out with an ordered screen-door pattern, so the cat stays in
          // view and orbiting through a tree never fills the screen.
          vec3 sp = uPlayerPos + vec3(0.0, 0.3, 0.0) - cameraPosition;
          float L = length(sp);
          float occl = 0.0;
          if (L > 0.8) {
            vec3 sd = sp / L;
            vec3 rel = vFolW - cameraPosition;
            float t = dot(rel, sd);
            float perp = length(rel - sd * t);
            occl = step(0.0, t) * (1.0 - smoothstep(L - 1.2, L - 0.4, t)) * (1.0 - smoothstep(1.0, 2.4, perp));
          }
          float fade = max(occl, 1.0 - smoothstep(0.8, 2.0, length(vViewPosition)));
          vec2 a = floor(gl_FragCoord.xy);
          vec2 h = floor(a * 0.5);
          float b2a = fract(dot(a, vec2(0.5, a.y * 0.75)));
          float b2h = fract(dot(h, vec2(0.5, h.y * 0.75)));
          float bayer = b2h * 0.25 + b2a; // 4×4 ordered threshold
          if (fade * 1.05 > bayer + 0.02) discard;
        }`,
      )
      .replace(
      '#include <opaque_fragment>',
      `{
        float rim = pow(1.0 - clamp(abs(dot(normalize(normal), normalize(vViewPosition))), 0.0, 1.0), 2.4);
        outgoingLight += vec3(0.86, 0.95, 0.7) * rim * 0.28;
      }
      #include <opaque_fragment>`,
    )
  }
  _foliageMat = mat
  return mat
}

// -- Canopy builder -----------------------------------------------------------

interface Blob {
  c: THREE.Vector3
  r: number
}

const _v = new THREE.Vector3()
const _n = new THREE.Vector3()
const _q = new THREE.Quaternion()
const _col = new THREE.Color()

/**
 * Leaf-card cloud over a set of blobs. Card normals point out of their blob
 * (blended with the whole-canopy normal) — the core of the soft painterly look.
 */
function buildCanopy(blobs: Blob[], hue: number, sat: number, light: number, rnd: () => number, bend: number, cardScale = 1): THREE.BufferGeometry {
  const center = new THREE.Vector3()
  for (const b of blobs) center.add(b.c)
  center.multiplyScalar(1 / blobs.length)
  let minY = Infinity
  let maxY = -Infinity
  for (const b of blobs) {
    minY = Math.min(minY, b.c.y - b.r)
    maxY = Math.max(maxY, b.c.y + b.r)
  }
  const parts: THREE.BufferGeometry[] = []
  for (const b of blobs) {
    const cards = Math.max(10, Math.round(b.r * b.r * 16))
    for (let i = 0; i < cards; i++) {
      // Point on/inside the blob, biased to the shell (that's what you see).
      _v.set(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1).normalize()
      const depth = 0.55 + Math.sqrt(rnd()) * 0.45
      const p = b.c.clone().addScaledVector(_v, b.r * depth)
      const size = b.r * (0.75 + rnd() * 0.45) * cardScale
      const g = new THREE.PlaneGeometry(size, size)
      const guv = g.getAttribute('uv')
      for (let k = 0; k < guv.count; k++) guv.setX(k, guv.getX(k) * 0.5) // left atlas tile
      _q.setFromEuler(new THREE.Euler(rnd() * Math.PI * 2, rnd() * Math.PI * 2, rnd() * Math.PI * 2))
      g.applyQuaternion(_q)
      g.translate(p.x, p.y, p.z)
      const pos = g.getAttribute('position')
      const nrm = g.getAttribute('normal')
      const n = pos.count
      const colors = new Float32Array(n * 3)
      const sway = new Float32Array(n)
      const bends = new Float32Array(n)
      for (let k = 0; k < n; k++) {
        _v.set(pos.getX(k), pos.getY(k), pos.getZ(k))
        _n.copy(_v).sub(b.c).normalize()
        const whole = _v.clone().sub(center).normalize()
        _n.addScaledVector(whole, 0.6).normalize()
        nrm.setXYZ(k, _n.x, _n.y, _n.z)
        // Darker underneath + toward the blob core; sunlit tops are brighter/yellower.
        const hT = (_v.y - minY) / Math.max(0.001, maxY - minY)
        const core = _v.distanceTo(b.c) / b.r
        _col.setHSL(hue + (rnd() - 0.5) * 0.025 - hT * 0.02, sat, light * (0.62 + hT * 0.45) * (0.75 + core * 0.3))
        colors[k * 3] = _col.r
        colors[k * 3 + 1] = _col.g
        colors[k * 3 + 2] = _col.b
        sway[k] = THREE.MathUtils.clamp(hT * 0.8 + 0.2, 0, 1)
        bends[k] = bend
      }
      g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
      g.setAttribute('aSway', new THREE.BufferAttribute(sway, 1))
      g.setAttribute('aBend', new THREE.BufferAttribute(bends, 1))
      parts.push(g)
    }
  }
  const merged = mergeGeometries(parts)
  for (const p of parts) p.dispose()
  return merged
}

/**
 * Conifer crown: whorls of drooping branches up the trunk, each branch a run
 * of needle-frond cards laid along it (right atlas tile). Whorls shrink to a
 * spire; normals point out from the trunk axis (and up) so the cone shades
 * as one soft mass. Dense enough that the trunk is hidden inside it.
 */
function buildConifer(baseY: number, topY: number, maxR: number, rnd: () => number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const whorls = 14
  const span = topY - baseY
  const addCard = (x: number, y: number, z: number, a: number, size: number, droop: number, t: number, along: number, twist = 0) => {
    const g = new THREE.PlaneGeometry(size * 0.8, size, 1, 2)
    const guv = g.getAttribute('uv')
    for (let k = 0; k < guv.count; k++) guv.setX(k, 0.5 + guv.getX(k) * 0.5) // right atlas tile
    g.rotateX(-Math.PI / 2 + droop) // lie along the branch, tip drooping
    g.rotateZ(twist + (rnd() - 0.5) * 0.5) // twist so fronds aren't all coplanar
    g.rotateY(Math.atan2(-Math.cos(a), -Math.sin(a)))
    g.translate(x, y, z)
    const pos = g.getAttribute('position')
    const nrm = g.getAttribute('normal')
    const n = pos.count
    const colors = new Float32Array(n * 3)
    const sway = new Float32Array(n)
    const bends = new Float32Array(n)
    for (let k = 0; k < n; k++) {
      _n.set(pos.getX(k), 0, pos.getZ(k)).normalize().multiplyScalar(0.75)
      _n.y = 0.65
      _n.normalize()
      nrm.setXYZ(k, _n.x, _n.y, _n.z)
      // Inner/lower needles darker; outer tips catch the light.
      _col.setHSL(0.37 + (rnd() - 0.5) * 0.02, 0.42, 0.18 + along * 0.13 + t * 0.06)
      colors[k * 3] = _col.r
      colors[k * 3 + 1] = _col.g
      colors[k * 3 + 2] = _col.b
      sway[k] = THREE.MathUtils.clamp(0.25 + t * 0.6 + along * 0.2, 0, 1)
      bends[k] = 0
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    g.setAttribute('aSway', new THREE.BufferAttribute(sway, 1))
    g.setAttribute('aBend', new THREE.BufferAttribute(bends, 1))
    parts.push(g)
  }
  for (let w = 0; w < whorls; w++) {
    const t = w / (whorls - 1)
    const y = baseY + span * t * 0.93
    const R = maxR * Math.pow(1 - t, 0.95) + 0.45
    const branches = Math.round(6 + (1 - t) * 4)
    for (let b = 0; b < branches; b++) {
      const a = (b / branches) * Math.PI * 2 + w * 0.7 + (rnd() - 0.5) * 0.35
      const cards = Math.max(2, Math.round(R / 0.5))
      for (let c = 0; c < cards; c++) {
        const f = (c + 0.6) / cards
        const dist = R * f * 0.9
        const droop = 0.12 + f * 0.35
        const size = (1.0 + (1 - t) * 0.8) * (1.05 - f * 0.25)
        const cx = Math.cos(a) * dist
        const cy = y - f * f * R * 0.35
        const cz = Math.sin(a) * dist
        addCard(cx, cy, cz, a, size, droop, t, f)
        // Crossed card at a steep angle: fills the spray seen edge-on.
        addCard(cx, cy - 0.05, cz, a, size * 0.85, droop, t, f * 0.9, (rnd() < 0.5 ? -1 : 1) * 1.1)
      }
    }
  }
  // Leader spire.
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2
    addCard(Math.cos(a) * 0.15, topY - 0.3, Math.sin(a) * 0.15, a, 0.9, -0.9, 1, 1)
  }
  const merged = mergeGeometries(parts)
  for (const p of parts) p.dispose()
  return merged
}

const _rc = new THREE.Vector3()
/**
 * Tapered, slightly flattened tube along a smooth curve through `pts`
 * (local, extending along +x), rotated `yaw` about the trunk axis.
 */
function rootTube(pts: THREE.Vector3[], r0: number, r1: number, yaw: number): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal')
  const SEGS = 18
  const RAD = 7
  const g = new THREE.TubeGeometry(curve, SEGS, 1, RAD, false)
  const pos = g.getAttribute('position')
  for (let s = 0; s <= SEGS; s++) {
    const t = s / SEGS
    curve.getPointAt(t, _rc)
    // Thick where it leaves the trunk, thinning fast, then a long thin tail.
    const rad = r1 + (r0 - r1) * Math.pow(1 - t, 1.15)
    for (let k = 0; k <= RAD; k++) {
      const i = s * (RAD + 1) + k
      const ox = pos.getX(i) - _rc.x
      const oy = pos.getY(i) - _rc.y
      const oz = pos.getZ(i) - _rc.z
      // Roots lying on soil spread sideways: an oval, flatter than tall.
      pos.setXYZ(i, _rc.x + ox * rad, _rc.y + oy * rad * 0.7, _rc.z + oz * rad)
    }
  }
  g.rotateY(yaw)
  g.computeVertexNormals()
  // Marks root vertices: at placement their height is laid over the real
  // terrain under each one (y here = height above the soil), so roots hug
  // slopes instead of poking out downhill or vanishing uphill.
  g.setAttribute('aRoot', new THREE.BufferAttribute(new Float32Array(pos.count).fill(1), 1))
  return g
}

/** Smooth tapered trunk (with base flare + gentle lean) plus a couple of branches into the canopy. */
function buildTrunk(h: number, r: number, rnd: () => number, branches: number, branchTopY: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = []
  const leanX = (rnd() - 0.5) * 0.25
  const leanZ = (rnd() - 0.5) * 0.25
  const trunk = new THREE.CylinderGeometry(r * 0.55, r, h, 14, 8)
  trunk.translate(0, h / 2, 0)
  const pos = trunk.getAttribute('position')
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i)
    const t = y / h
    const flare = 1 + Math.pow(1 - Math.min(1, t * 4), 2) * 0.45 // roots flare at the base
    pos.setX(i, pos.getX(i) * flare + leanX * t * t * h * 0.15)
    pos.setZ(i, pos.getZ(i) * flare + leanZ * t * t * h * 0.15)
  }
  trunk.computeVertexNormals()
  parts.push(trunk)
  // Surface roots: tapered tubes along curves. Each leaves the trunk flare,
  // bends down onto the soil, snakes along it with a little curl, and sinks
  // in at the tip — gripping the ground, never jutting out of it. Some fork
  // a thinner rootlet off to one side.
  const roots = 5 + Math.floor(rnd() * 3)
  for (let i = 0; i < roots; i++) {
    const a = (i / roots) * Math.PI * 2 + (rnd() - 0.5) * 0.6
    const len = r * (3.0 + rnd() * 2.2)
    const curl = (rnd() < 0.5 ? -1 : 1) * r * (0.35 + rnd() * 0.45)
    const pts = [
      new THREE.Vector3(r * 0.3, r * 0.9, 0),
      new THREE.Vector3(r * 0.95, r * 0.35, curl * 0.15),
      new THREE.Vector3(len * 0.38, r * 0.07, curl * 0.6),
      new THREE.Vector3(len * 0.62, r * 0.03, -curl * 0.25),
      new THREE.Vector3(len * 0.85, -r * 0.02, curl * 0.45),
      new THREE.Vector3(len, -r * 0.3, curl * 0.2),
    ]
    parts.push(rootTube(pts, r * (0.5 + rnd() * 0.12), r * 0.07, a))
    if (rnd() < 0.55) {
      // Rootlet forking off the middle of the root.
      const side = -Math.sign(curl) || 1
      const o = new THREE.Vector3().lerpVectors(pts[2], pts[3], 0.3)
      const rl = len * (0.35 + rnd() * 0.2)
      const lp = [
        o.clone().setY(r * 0.08),
        o.clone().add(new THREE.Vector3(rl * 0.35, -r * 0.02, side * rl * 0.3)),
        o.clone().add(new THREE.Vector3(rl * 0.7, -r * 0.03, side * rl * 0.45)),
        o.clone().add(new THREE.Vector3(rl, -r * 0.25, side * rl * 0.4)),
      ]
      parts.push(rootTube(lp, r * 0.2, r * 0.05, a))
    }
  }
  for (let i = 0; i < branches; i++) {
    const a = (i / branches) * Math.PI * 2 + rnd() * 0.8
    const len = h * (0.28 + rnd() * 0.15)
    const br = r * 0.32
    const b = new THREE.CylinderGeometry(br * 0.45, br, len, 8, 3)
    b.translate(0, len / 2, 0)
    b.rotateZ(0.75 + rnd() * 0.35)
    b.rotateY(a)
    b.translate(0, branchTopY * (0.62 + rnd() * 0.2), 0)
    parts.push(b)
  }
  const merged = mergeGeometries(parts)
  for (const p of parts) p.dispose()
  const n = merged.getAttribute('position').count
  const colors = new Float32Array(n * 3)
  const mp = merged.getAttribute('position')
  for (let i = 0; i < n; i++) {
    const v = noise3(mp.getX(i) * 6, mp.getY(i) * 2, mp.getZ(i) * 6)
    _col.setHSL(0.07 + v * 0.015, 0.38, 0.2 + v * 0.1 + Math.min(1, mp.getY(i) / h) * 0.05)
    colors[i * 3] = _col.r
    colors[i * 3 + 1] = _col.g
    colors[i * 3 + 2] = _col.b
  }
  merged.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return merged
}

function makeTree(kind: TreeKind, seed: number): TreeVariant {
  const rnd = prng(seed)
  const blobs: Blob[] = []
  let h: number
  let r: number
  let hue = 0.27
  let sat = 0.5
  let light = 0.46
  let branches = 3
  if (kind === 'broadleaf') {
    // Big round Mondstadt-style crown: a central mass + a ring of lobes.
    h = 5.2 + rnd() * 1.6
    r = 0.42 + rnd() * 0.12
    const cr = 3.0 + rnd() * 0.8
    const cy = h + cr * 0.55
    blobs.push({ c: new THREE.Vector3(0, cy, 0), r: cr })
    const lobes = 5 + Math.floor(rnd() * 3)
    for (let i = 0; i < lobes; i++) {
      const a = (i / lobes) * Math.PI * 2 + rnd() * 0.5
      const lr = cr * (0.55 + rnd() * 0.2)
      blobs.push({ c: new THREE.Vector3(Math.cos(a) * cr * 0.85, cy - cr * 0.15 + rnd() * cr * 0.5, Math.sin(a) * cr * 0.85), r: lr })
    }
    blobs.push({ c: new THREE.Vector3((rnd() - 0.5) * cr * 0.4, cy + cr * 0.7, (rnd() - 0.5) * cr * 0.4), r: cr * 0.6 })
    hue = 0.25 + rnd() * 0.04
  } else if (kind === 'tall') {
    // Poplar-ish: stacked blobs up a tall trunk.
    h = 7 + rnd() * 2
    r = 0.34 + rnd() * 0.08
    const layers = 4 + Math.floor(rnd() * 2)
    for (let i = 0; i < layers; i++) {
      const t = i / (layers - 1)
      const lr = 2.2 * (1 - t * 0.55) + rnd() * 0.3
      blobs.push({ c: new THREE.Vector3((rnd() - 0.5) * 0.8, h * 0.55 + t * h * 0.8, (rnd() - 0.5) * 0.8), r: lr })
    }
    hue = 0.29 + rnd() * 0.03
    light = 0.42
    branches = 2
  } else {
    // Conifer: whorled branches of needle fronds (buildConifer below).
    h = 1.4 + rnd() * 0.5 // bare trunk below the lowest whorl
    r = 0.36 + rnd() * 0.08
    branches = 0
  }
  if (kind === 'pine') {
    const top = h + 11 + rnd() * 3
    const trunk = buildTrunk(top * 0.94, r, rnd, 0, top)
    const canopy = buildConifer(h, top, 2.9 + rnd() * 0.5, rnd)
    canopy.computeBoundingBox()
    const bb = canopy.boundingBox!
    return { kind, trunk, canopy, height: bb.max.y, width: Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z), trunkR: r }
  }
  const trunk = buildTrunk(h + 1.2, r, rnd, branches, h)
  const canopy = buildCanopy(blobs, hue, sat, light, rnd, 0, 1)
  canopy.computeBoundingBox()
  const bb = canopy.boundingBox!
  return {
    kind,
    trunk,
    canopy,
    height: bb.max.y,
    width: Math.max(bb.max.x - bb.min.x, bb.max.z - bb.min.z),
    trunkR: r,
  }
}

/** A few variants of each kind, built once at load. */
export const TREE_VARIANTS: Record<TreeKind, TreeVariant[]> = {
  broadleaf: [0, 1, 2, 3].map((i) => makeTree('broadleaf', 101 + i * 17)),
  tall: [0, 1, 2].map((i) => makeTree('tall', 301 + i * 13)),
  pine: [0, 1, 2].map((i) => makeTree('pine', 503 + i * 11)),
}

/** Low, round leafy bushes that part around the player (aBend = 1). */
export const BUSH_VARIANTS: THREE.BufferGeometry[] = [0, 1, 2, 3].map((i) => {
  const rnd = prng(907 + i * 29)
  const blobs: Blob[] = []
  const n = 2 + Math.floor(rnd() * 3)
  for (let k = 0; k < n; k++) {
    const br = 0.55 + rnd() * 0.35
    blobs.push({ c: new THREE.Vector3((rnd() - 0.5) * 1.1, br * 0.75, (rnd() - 0.5) * 1.1), r: br })
  }
  return buildCanopy(blobs, 0.27 + rnd() * 0.04, 0.5, 0.42, rnd, 1, 0.9)
})

// -- Rocks --------------------------------------------------------------------

/**
 * Smooth, high-subdivision boulder (merged vertices → smooth normals), noise
 * displaced, flattened underneath, moss painted on upward-facing surfaces.
 * Local origin at the base centre; `s` ≈ footprint radius.
 */
export function rockGeometry(rnd: () => number, s: number, detail = 3): THREE.BufferGeometry {
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, detail)
  g.deleteAttribute('uv')
  g.deleteAttribute('normal')
  g = mergeVertices(g)
  const ox = rnd() * 50
  const oz = rnd() * 50
  const pos = g.getAttribute('position')
  for (let i = 0; i < pos.count; i++) {
    _v.set(pos.getX(i), pos.getY(i), pos.getZ(i))
    const n = noise3(_v.x * 1.6 + ox, _v.y * 1.6, _v.z * 1.6 + oz) * 0.6 + noise3(_v.x * 4 + oz, _v.y * 4, _v.z * 4 + ox) * 0.4
    _v.multiplyScalar(0.82 + n * 0.36)
    if (_v.y < -0.25) _v.y = -0.25 + (_v.y + 0.25) * 0.25 // sit flat on the ground
    pos.setXYZ(i, _v.x, _v.y, _v.z)
  }
  g.scale(s, s * (0.55 + rnd() * 0.15), s * (0.8 + rnd() * 0.2))
  g.translate(0, 0.25 * s * 0.6, 0)
  g.computeVertexNormals()
  const nrm = g.getAttribute('normal')
  const colors = new Float32Array(pos.count * 3)
  const moss = new THREE.Color()
  for (let i = 0; i < pos.count; i++) {
    const up = nrm.getY(i)
    const v = noise3(pos.getX(i) * 0.9 + ox, pos.getY(i) * 0.9, pos.getZ(i) * 0.9 + oz)
    _col.setHSL(0.08 + v * 0.03, 0.08 + v * 0.06, 0.42 + v * 0.14)
    moss.setHSL(0.24 + v * 0.04, 0.45, 0.32 + v * 0.08)
    _col.lerp(moss, THREE.MathUtils.smoothstep(up, 0.55, 0.85) * 0.85)
    colors[i * 3] = _col.r
    colors[i * 3 + 1] = _col.g
    colors[i * 3 + 2] = _col.b
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  // Dummy UVs so rocks merge with the other scatter parts (same attribute set).
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2))
  return g
}

/**
 * Pre-built rock shapes (unit size) — chunks clone + scale these instead of
 * subdividing/welding a fresh icosahedron per rock, which dominated chunk
 * build time. `top` is the unit crest height (for sit-spot metadata).
 */
export const BOULDER_POOL: Array<{ geometry: THREE.BufferGeometry; top: number }> = Array.from({ length: 10 }, (_, i) => {
  const g = rockGeometry(prng(1301 + i * 7), 1, 3)
  g.computeBoundingBox()
  return { geometry: g, top: g.boundingBox!.max.y }
})
export const PEBBLE_POOL: THREE.BufferGeometry[] = Array.from({ length: 8 }, (_, i) => rockGeometry(prng(1703 + i * 5), 1, 2))

/** Ensure a geometry carries a uv attribute (merge compatibility). */
export function withUv(g: THREE.BufferGeometry): THREE.BufferGeometry {
  if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2))
  return g
}

// -- Flowers ------------------------------------------------------------------

export interface FlowerVariant {
  geometry: THREE.BufferGeometry // position/normal/uv/color, base at y=0
  height: number
}

/**
 * Hand-painted flower atlas (512², 2×2 tiles), drawn once at boot. Tiles are
 * near-white with painted shading/veins so vertex colour tints them:
 *   0 long daisy petal · 1 broad ruffled petal · 2 seeded flower centre ·
 *   3 veined leaf. A solid white swatch in the corner textures the stems.
 */
let _flowerAtlas: THREE.Texture | null = null
export function flowerAtlas(): THREE.Texture {
  if (_flowerAtlas) return _flowerAtlas
  const S = 512
  const T = S / 2
  const c = document.createElement('canvas')
  c.width = c.height = S
  const ctx = c.getContext('2d')!
  const rnd = prng(4242)
  // Tile 0 — long daisy petal: rounded tip, darker toward the base, centre vein.
  {
    ctx.save()
    ctx.translate(T / 2, T)
    const g = ctx.createLinearGradient(0, 0, 0, -T)
    g.addColorStop(0, 'rgb(170,170,170)')
    g.addColorStop(0.35, 'rgb(240,240,240)')
    g.addColorStop(1, 'rgb(255,255,255)')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.moveTo(0, -4)
    ctx.bezierCurveTo(T * 0.2, -T * 0.25, T * 0.22, -T * 0.85, 0, -T * 0.97)
    ctx.bezierCurveTo(-T * 0.22, -T * 0.85, -T * 0.2, -T * 0.25, 0, -4)
    ctx.fill()
    ctx.strokeStyle = 'rgba(150,150,150,0.55)'
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.moveTo(0, -8)
    ctx.lineTo(0, -T * 0.8)
    ctx.stroke()
    ctx.restore()
  }
  // Tile 1 — broad fan petal: ruffled edge, radial streaks, deep base.
  {
    ctx.save()
    ctx.translate(T + T / 2, T)
    const g = ctx.createRadialGradient(0, 0, 4, 0, 0, T * 0.95)
    g.addColorStop(0, 'rgb(120,120,120)')
    g.addColorStop(0.3, 'rgb(225,225,225)')
    g.addColorStop(1, 'rgb(255,255,255)')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.moveTo(0, 0)
    const lobes = 7
    for (let i = 0; i <= lobes; i++) {
      const a = -Math.PI / 2 - 0.75 + (i / lobes) * 1.5
      const r = T * (0.86 + (i % 2) * 0.08 + rnd() * 0.04)
      ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r)
    }
    ctx.closePath()
    ctx.fill()
    ctx.strokeStyle = 'rgba(160,160,160,0.35)'
    ctx.lineWidth = 2
    for (let i = 0; i < 9; i++) {
      const a = -Math.PI / 2 - 0.6 + (i / 8) * 1.2
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.lineTo(Math.cos(a) * T * 0.75, Math.sin(a) * T * 0.75)
      ctx.stroke()
    }
    ctx.restore()
  }
  // Tile 2 — flower centre: domed disc of seeds (darker ring, lighter middle).
  {
    ctx.save()
    ctx.translate(T / 2, T + T / 2)
    const g = ctx.createRadialGradient(0, 0, 2, 0, 0, T * 0.45)
    g.addColorStop(0, 'rgb(255,255,255)')
    g.addColorStop(0.7, 'rgb(215,215,215)')
    g.addColorStop(1, 'rgb(150,150,150)')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(0, 0, T * 0.45, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = 'rgba(110,110,110,0.45)'
    for (let i = 0; i < 160; i++) {
      const r = Math.sqrt(i / 160) * T * 0.42
      const a = i * 2.39996 // golden-angle phyllotaxis, like real seed heads
      ctx.beginPath()
      ctx.arc(Math.cos(a) * r, Math.sin(a) * r, 3, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
  }
  // Tile 3 — leaf: pointed oval, midrib + side veins.
  {
    ctx.save()
    ctx.translate(T + T / 2, S)
    const g = ctx.createLinearGradient(-T * 0.3, 0, T * 0.3, 0)
    g.addColorStop(0, 'rgb(200,200,200)')
    g.addColorStop(0.5, 'rgb(250,250,250)')
    g.addColorStop(1, 'rgb(205,205,205)')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.moveTo(0, -4)
    ctx.bezierCurveTo(T * 0.34, -T * 0.3, T * 0.22, -T * 0.78, 0, -T * 0.97)
    ctx.bezierCurveTo(-T * 0.22, -T * 0.78, -T * 0.34, -T * 0.3, 0, -4)
    ctx.fill()
    ctx.strokeStyle = 'rgba(140,140,140,0.5)'
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.moveTo(0, -6)
    ctx.lineTo(0, -T * 0.9)
    ctx.stroke()
    ctx.lineWidth = 1.5
    for (let i = 1; i < 6; i++) {
      const y = -T * 0.15 * i
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(T * 0.16, y - T * 0.08)
      ctx.moveTo(0, y)
      ctx.lineTo(-T * 0.16, y - T * 0.08)
      ctx.stroke()
    }
    ctx.restore()
  }
  // Solid white swatch for stems (sampled at a single uv).
  ctx.fillStyle = '#fff'
  ctx.fillRect(S - 12, 0, 12, 12)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  _flowerAtlas = tex
  return tex
}

const TILE_UV: Array<[number, number]> = [
  [0, 0.5], // 0 daisy petal (u0, v0) — canvas y flips to uv v
  [0.5, 0.5], // 1 broad petal
  [0, 0], // 2 centre
  [0.5, 0], // 3 leaf
]
const STEM_UV: [number, number] = [1 - 6 / 512, 1 - 6 / 512]

function tint(g: THREE.BufferGeometry, hex: number, jitter: number, rnd: () => number): THREE.BufferGeometry {
  const n = g.getAttribute('position').count
  const colors = new Float32Array(n * 3)
  _col.set(hex).offsetHSL((rnd() - 0.5) * 0.02, 0, (rnd() - 0.5) * jitter)
  for (let i = 0; i < n; i++) {
    colors[i * 3] = _col.r
    colors[i * 3 + 1] = _col.g
    colors[i * 3 + 2] = _col.b
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return g
}

/**
 * A curved card textured with one atlas tile, growing from its base (y=0)
 * along +Y. `cup` curls it forward along its length (petals/leaves aren't flat).
 */
export function atlasCard(tile: number, w: number, len: number, cup: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, len, 2, 5)
  g.translate(0, len / 2, 0)
  const pos = g.getAttribute('position')
  const uv = g.getAttribute('uv')
  const [u0, v0] = TILE_UV[tile]
  for (let i = 0; i < pos.count; i++) {
    const t = pos.getY(i) / len
    const x = pos.getX(i) / w
    pos.setZ(i, cup * t * t * len + Math.abs(x) * cup * 0.4 * w) // curl tip forward, edges up
    uv.setXY(i, u0 + uv.getX(i) * 0.5, v0 + uv.getY(i) * 0.5)
  }
  g.computeVertexNormals()
  return g
}

/** Point a card outward from the flower centre: tilted `open` from vertical, at yaw `a`. */
function place(g: THREE.BufferGeometry, open: number, a: number, x: number, y: number, z: number): THREE.BufferGeometry {
  g.rotateX(open)
  g.rotateY(a)
  g.translate(x, y, z)
  return g
}

interface FlowerSpec {
  petal: number
  centre: number
  petals: number
  tile: 0 | 1
  petalW: number
  petalL: number
  open: number // 0 = petals point up (cup), π/2 = flat
  cup: number
  centreR: number
  stemH: number
}

function makeFlower(spec: FlowerSpec, seed: number): FlowerVariant {
  const rnd = prng(seed)
  const parts: THREE.BufferGeometry[] = []
  const stemH = spec.stemH * (0.9 + rnd() * 0.2)
  const bend = (rnd() - 0.5) * 0.08
  const stem = new THREE.CylinderGeometry(0.008, 0.013, stemH, 6, 6)
  stem.translate(0, stemH / 2, 0)
  const sp = stem.getAttribute('position')
  const suv = stem.getAttribute('uv')
  for (let i = 0; i < sp.count; i++) {
    const t = sp.getY(i) / stemH
    sp.setX(i, sp.getX(i) + bend * t * t)
    suv.setXY(i, STEM_UV[0], STEM_UV[1])
  }
  stem.computeVertexNormals()
  parts.push(tint(stem, 0x4f8a36, 0.04, rnd))
  for (let k = 0; k < 3; k++) {
    const leaf = place(atlasCard(3, 0.1, 0.22, 0.3), 0.9 + rnd() * 0.35, k * 2.1 + rnd() * 0.7, 0, stemH * (0.05 + k * 0.14), 0)
    parts.push(tint(leaf, 0x5c9a3e, 0.08, rnd))
  }
  // Head, tilted slightly to the sun-side of the stem.
  const tilt = 0.45 + rnd() * 0.3 // blooms tip toward you, not edge-on
  const head: THREE.BufferGeometry[] = []
  for (let i = 0; i < spec.petals; i++) {
    const a = (i / spec.petals) * Math.PI * 2 + rnd() * 0.12
    const len = spec.petalL * (0.9 + rnd() * 0.2)
    // Alternate layers sit a hair apart so overlapping petals don't z-fight.
    const g = place(atlasCard(spec.tile, spec.petalW, len, spec.cup), spec.open + (i % 2) * 0.06, a, 0, (i % 2) * 0.004, 0)
    head.push(tint(g, spec.petal, 0.08, rnd))
  }
  const disc = new THREE.CircleGeometry(spec.centreR, 16)
  disc.rotateX(-Math.PI / 2)
  const duv = disc.getAttribute('uv')
  for (let i = 0; i < duv.count; i++) duv.setXY(i, TILE_UV[2][0] + duv.getX(i) * 0.5, TILE_UV[2][1] + duv.getY(i) * 0.5)
  disc.translate(0, 0.012, 0)
  head.push(tint(disc, spec.centre, 0.04, rnd))
  for (const h of head) {
    h.rotateX(tilt)
    h.translate(bend, stemH, 0)
    parts.push(h)
  }
  const merged = mergeGeometries(parts)
  for (const p of parts) p.dispose()
  merged.computeBoundingBox()
  return { geometry: merged, height: merged.boundingBox!.max.y }
}

/** Lavender: a spike of small tinted bud-cards up the top of the stem. */
function makeLavender(seed: number): FlowerVariant {
  const rnd = prng(seed)
  const parts: THREE.BufferGeometry[] = []
  const stemH = 0.4 + rnd() * 0.1
  const stem = new THREE.CylinderGeometry(0.008, 0.012, stemH, 6, 4)
  stem.translate(0, stemH / 2, 0)
  const suv = stem.getAttribute('uv')
  for (let i = 0; i < suv.count; i++) suv.setXY(i, STEM_UV[0], STEM_UV[1])
  parts.push(tint(stem, 0x5f8a48, 0.04, rnd))
  const buds = 30
  for (let i = 0; i < buds; i++) {
    const t = i / (buds - 1)
    const y = stemH * (0.55 + t * 0.48)
    const g = place(atlasCard(0, 0.05, 0.075 * (1.2 - t * 0.55), 0.3), 0.7, i * 2.39996, 0, y, 0)
    parts.push(tint(g, t > 0.75 ? 0xb9a2ef : 0x9b7fe0, 0.1, rnd))
  }
  const leaf = place(atlasCard(3, 0.04, 0.16, 0.2), 0.5, rnd() * 6.28, 0, stemH * 0.15, 0)
  parts.push(tint(leaf, 0x6b9450, 0.06, rnd))
  const merged = mergeGeometries(parts)
  for (const p of parts) p.dispose()
  merged.computeBoundingBox()
  return { geometry: merged, height: merged.boundingBox!.max.y }
}

/** Meadow palette — weighted toward whites/yellows like real wildflower fields. */
export const FLOWER_VARIANTS: FlowerVariant[] = [
  // Oxeye daisy — many long white petals, nearly flat, golden centre.
  makeFlower({ petal: 0xfdfaf2, centre: 0xf2b630, petals: 16, tile: 0, petalW: 0.055, petalL: 0.14, open: 1.3, cup: 0.12, centreR: 0.045, stemH: 0.32 }, 11),
  // Cosmos — 8 broad pink petals, slightly cupped.
  makeFlower({ petal: 0xf59ac4, centre: 0xf4c544, petals: 8, tile: 1, petalW: 0.11, petalL: 0.14, open: 1.12, cup: 0.2, centreR: 0.035, stemH: 0.38 }, 23),
  // Poppy — 4 big red petals in a loose cup, dark centre.
  makeFlower({ petal: 0xf0443a, centre: 0x2a1c18, petals: 4, tile: 1, petalW: 0.17, petalL: 0.14, open: 0.72, cup: 0.35, centreR: 0.032, stemH: 0.34 }, 37),
  // Buttercup — 5 glossy yellow petals, cupped.
  makeFlower({ petal: 0xffd21f, centre: 0xe8a514, petals: 5, tile: 1, petalW: 0.09, petalL: 0.09, open: 0.9, cup: 0.3, centreR: 0.022, stemH: 0.26 }, 41),
  // Cornflower — ragged blue petals.
  makeFlower({ petal: 0x5b7ff0, centre: 0x3a3fa8, petals: 12, tile: 0, petalW: 0.06, petalL: 0.1, open: 1.05, cup: 0.25, centreR: 0.025, stemH: 0.33 }, 53),
  makeLavender(67),
]
export const FLOWER_WEIGHTS = [0.3, 0.17, 0.12, 0.17, 0.1, 0.14]
