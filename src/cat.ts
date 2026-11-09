import * as THREE from 'three'
import { toonMat } from './toon'
import { addShells, furMat, updateFur } from './fur'

// ---------------------------------------------------------------------------
// The player: a fluffy long-haired cream-and-ginger cat. Procedural shapes wrapped in shell fur (fur.ts) — a soft, wavy coat,
// big chest ruff, cheek fluff and a plume tail.
//
// Motion is driven by what the body is actually doing (speed, turn rate,
// acceleration, slope), not by a fixed cycle:
//   • gait  — walk (4-beat) → trot (diagonal pairs) → gallop (bound with
//             spine flex), blended by speed; stride length grows with speed
//   • spine — front and rear halves bend into turns and flex in the gallop
//   • momentum — lean into turns, head leads the turn and stays level,
//             pitch on acceleration / braking, body follows the slope
//   • tail + ears — damped springs: the tail swings out on turns and trails
//             behind at speed, ears pin back when running
//   • idle life — blinks, looks around, grooms a paw, play-bow stretches
// States from Player:
//   • walk  — diagonal-pair trot (front-left with back-right), stride driven
//             by distance travelled so paws never slide; body bob, head
//             counter-bob, tail raised and swaying
//   • stand — breathing, lazy S-curve tail, occasional ear flick
//   • air   — forelegs reach forward, hind legs stretch back
//   • sit   — the classic cat sit: haunches down, front legs straight, chest
//             up, tail curled around the front paws
// Forward is +Z. Same public API as before: group / setPose / setSquash.
// ---------------------------------------------------------------------------

export type AnimState = 'stand' | 'walk' | 'air' | 'sit'

const _hip = new THREE.Vector3()
const _home = new THREE.Vector3()
const _land = new THREE.Vector3()
const _t = new THREE.Vector3()

/** Camera rig heights for a cat-sized player (eye, third-person look-at). */
export const CAT_EYE_STAND = 0.92
export const CAT_EYE_SIT = 0.78
export const CAT_LOOK_AT = 0.62

const BODY_Y = 0.53 // body centre above the paws
const UPPER = 0.23
const LOWER = 0.26
const TAIL_SEGS = 9

/** Two-segment leg: hip/shoulder pivot → knee/elbow pivot → paw. */
class Leg {
  readonly root = new THREE.Group()
  readonly joint = new THREE.Group()
  constructor(radius: number, fur: THREE.Material, paw: THREE.Material) {
    // Swing (x) in the leg's plane first, then splay that plane sideways (z).
    this.root.rotation.order = 'ZYX'
    const upper = new THREE.Mesh(new THREE.CapsuleGeometry(radius, UPPER - radius, 4, 10), fur)
    upper.position.y = -UPPER / 2
    addShells(upper)
    this.root.add(upper)
    this.joint.position.y = -UPPER
    const lower = new THREE.Mesh(new THREE.CapsuleGeometry(radius * 0.78, LOWER - radius, 4, 10), paw)
    lower.position.y = -LOWER / 2
    addShells(lower)
    this.joint.add(lower)
    const p = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.05, 12, 8), paw)
    addShells(p)
    p.scale.set(1, 0.7, 1.25)
    p.position.set(0, -LOWER, radius * 0.25)
    this.joint.add(p)
    this.root.add(this.joint)
  }
}

export class Cat {
  readonly group = new THREE.Group()
  private root = new THREE.Group() // squash pivot at the paws
  private body = new THREE.Group() // pitch (sit) + bob
  private head = new THREE.Group()
  private earL!: THREE.Group
  private earR!: THREE.Group
  private front = new THREE.Group() // chest / head / forelegs (spine front half)
  private rear = new THREE.Group() // hind legs / tail (spine rear half)
  private eyes: THREE.Group[] = []
  private legs: {
    leg: Leg
    front: boolean
    side: number
    phase: number
    idx: number
    /** Where the paw is (world), where it lifted from, whether it's planted. */
    foot: THREE.Vector3
    from: THREE.Vector3
    planted: boolean
    /** Keyframed (non-IK) pose for sit / swim / air / idle actions. */
    animHip: number
    animKnee: number
    /** > 0 while doing a catch-up step (counts down to 0). */
    forceSwing: number
  }[] = []
  /** Height of whatever is underfoot at (x, z) — set by the Player. */
  ground: (x: number, z: number) => number = () => 0
  private ikW = 0
  private feetReady = false
  private tail: THREE.Group[] = []
  private t = 0
  private squashY = 0
  private squashVel = 0
  private flick = 0
  private swim = 0 // 0..1 eased: low in the water, paddling
  private swimming = false
  private lastPos = new THREE.Vector3()
  private vel = new THREE.Vector3()
  private lastYaw = 0
  private speedS = 0
  private prevSpeed = 0
  private accelS = 0
  private yawRateS = 0
  private gaitPhase = 0
  private slope = 0
  // Tail springs (per segment: pitch, yaw, and their velocities).
  private tailX = new Float32Array(TAIL_SEGS)
  private tailY = new Float32Array(TAIL_SEGS)
  private tailVX = new Float32Array(TAIL_SEGS)
  private tailVY = new Float32Array(TAIL_SEGS)
  // Idle behaviour.
  private idleT = 0
  private nextIdle = 4
  private action: 'look' | 'groom' | 'stretch' | null = null
  private actionT = 0
  private actionDur = 0
  private actionW = 0
  private lookYaw = 0
  private lookPitch = 0
  private blinkT = 3

  constructor() {
    // Fur: long on the body, longest on the ruff and tail, short on face/legs.
    const fur = furMat(0xf3b37c, 0.09, 75)
    const furHead = furMat(0xf3b37c, 0.05, 100)
    const furEar = furMat(0xf3b37c, 0.02, 160)
    const cream = furMat(0xfff6ea, 0.09, 75)
    const creamRuff = furMat(0xfff6ea, 0.13, 60)
    const creamFace = furMat(0xfff6ea, 0.04, 120)
    const creamLeg = furMat(0xfff6ea, 0.04, 110)
    const legFur = furMat(0xf3b37c, 0.045, 100)
    const tailFur = furMat(0xf3b37c, 0.1, 55)
    const tailTip = furMat(0xfff6ea, 0.1, 55)
    const pink = toonMat({ color: 0xf2a0a8 })

    this.group.add(this.root)
    this.root.add(this.body)
    this.body.position.y = BODY_Y

    // Torso: a long capsule along Z, cream belly underneath.
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, 0.4, 6, 16), fur)
    torso.rotation.x = Math.PI / 2
    torso.scale.set(1.04, 1, 0.92)
    addShells(torso)
    this.body.add(torso)
    const belly = new THREE.Mesh(new THREE.SphereGeometry(0.18, 18, 12), cream)
    belly.scale.set(0.95, 0.6, 1.9)
    belly.position.set(0, -0.08, 0.02)
    addShells(belly)
    this.body.add(belly)
    // Big fluffy chest ruff (mane) joins torso to head.
    const chest = new THREE.Mesh(new THREE.SphereGeometry(0.18, 18, 12), creamRuff)
    chest.scale.set(1.1, 1.15, 0.95)
    chest.position.set(0, 0.03, 0.3)
    addShells(chest)
    this.body.add(chest)

    // Head.
    this.head.position.set(0, 0.24, 0.42)
    this.body.add(this.head)
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.18, 26, 18), furHead)
    skull.scale.set(1.12, 0.95, 1)
    addShells(skull)
    this.head.add(skull)
    // Cheek fluff: the round long-hair face.
    for (const side of [-1, 1]) {
      const cheek = new THREE.Mesh(new THREE.SphereGeometry(0.08, 14, 10), creamFace)
      cheek.scale.set(1, 0.85, 0.9)
      cheek.position.set(side * 0.13, -0.07, 0.07)
      addShells(cheek)
      this.head.add(cheek)
    }
    const muzzle = new THREE.Mesh(new THREE.SphereGeometry(0.085, 16, 12), creamFace)
    muzzle.scale.set(1.35, 0.85, 0.8)
    muzzle.position.set(0, -0.06, 0.15)
    addShells(muzzle)
    this.head.add(muzzle)
    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.018, 12, 8), pink)
    nose.scale.set(1.3, 0.8, 0.8)
    nose.position.set(0, -0.03, 0.225)
    this.head.add(nose)
    // Big anime eyes: dark amber iris, black pupil, white sparkle — unlit so
    // they always read.
    const irisMat = new THREE.MeshBasicMaterial({ color: 0x3a2a12 })
    const pupilMat = new THREE.MeshBasicMaterial({ color: 0x0c0806 })
    const sparkMat = new THREE.MeshBasicMaterial({ color: 0xffffff })
    for (const side of [-1, 1]) {
      const eye = new THREE.Group()
      eye.position.set(side * 0.085, 0.015, 0.165)
      eye.rotation.y = side * 0.35
      const iris = new THREE.Mesh(new THREE.SphereGeometry(0.044, 20, 14), irisMat)
      iris.scale.set(0.95, 1.2, 0.45)
      const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.03, 16, 12), pupilMat)
      pupil.scale.set(0.75, 1.15, 0.4)
      pupil.position.z = 0.012
      const spark = new THREE.Mesh(new THREE.SphereGeometry(0.011, 10, 8), sparkMat)
      spark.position.set(side * -0.012, 0.022, 0.024)
      eye.add(iris, pupil, spark)
      this.head.add(eye)
      this.eyes.push(eye)
    }
    // Ears: outer fur cone + pink inner, on a pivot so they can flick.
    const mkEar = (side: number) => {
      const ear = new THREE.Group()
      ear.position.set(side * 0.11, 0.15, 0.0)
      ear.rotation.set(-0.1, 0, side * -0.28)
      const outer = new THREE.Mesh(new THREE.ConeGeometry(0.072, 0.15, 24), furEar)
      outer.position.y = 0.06
      outer.scale.set(1, 1, 0.55)
      addShells(outer)
      const inner = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.11, 20), pink)
      inner.position.set(0, 0.05, 0.022)
      inner.scale.set(1, 1, 0.3)
      ear.add(outer, inner)
      this.head.add(ear)
      return ear
    }
    this.earL = mkEar(-1)
    this.earR = mkEar(1)
    // Whiskers (thin, unlit).
    const whiskerMat = new THREE.MeshBasicMaterial({ color: 0xfff8ee })
    for (const side of [-1, 1]) {
      for (let k = 0; k < 2; k++) {
        const w = new THREE.Mesh(new THREE.CylinderGeometry(0.0025, 0.0025, 0.16, 4), whiskerMat)
        w.rotation.z = Math.PI / 2 + side * (0.08 + k * 0.12)
        w.position.set(side * 0.13, -0.05 - k * 0.015, 0.15)
        this.head.add(w)
      }
    }

    // Legs (shoulder/hip pivots under the torso).
    const legSpec: Array<[boolean, number, number]> = [
      [true, -1, 0], // front-left
      [true, 1, Math.PI], // front-right
      [false, -1, Math.PI], // back-left (diagonal pair with front-right)
      [false, 1, 0], // back-right
    ]
    for (const [front, side, phase] of legSpec) {
      const leg = new Leg(front ? 0.054 : 0.064, legFur, creamLeg)
      leg.root.position.set(side * 0.11, -0.04, front ? 0.27 : -0.26)
      this.body.add(leg.root)
      this.legs.push({ leg, front, side, phase, idx: this.legs.length, foot: new THREE.Vector3(), from: new THREE.Vector3(), planted: true, animHip: 0, animKnee: 0, forceSwing: 0 })
    }

    // Tail: a chain of tapering segments, each a child of the last.
    let parent: THREE.Object3D = this.body
    const tailBase = new THREE.Group()
    tailBase.position.set(0, 0.06, -0.36)
    this.body.add(tailBase)
    parent = tailBase
    for (let i = 0; i < TAIL_SEGS; i++) {
      const seg = new THREE.Group()
      if (i > 0) seg.position.z = -0.065
      // Plume: thickest mid-tail, long fur, cream tip.
      const k = i / (TAIL_SEGS - 1)
      const r = 0.04 + Math.sin(Math.min(1, k * 1.3) * Math.PI) * 0.018
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 9), i >= TAIL_SEGS - 2 ? tailTip : tailFur)
      m.scale.set(1, 1, 1.8)
      m.position.z = -0.03
      addShells(m)
      seg.add(m)
      parent.add(seg)
      this.tail.push(seg)
      parent = seg
    }

    // Split the spine: everything forward of the waist rides the front half,
    // everything behind it the rear half (both pivot at the body centre, so
    // nothing moves until they bend).
    this.body.add(this.front, this.rear)
    for (const o of [...this.body.children]) {
      if (o === this.front || o === this.rear) continue
      if (o.position.z > 0.15) this.front.add(o)
      else if (o.position.z < -0.15) this.rear.add(o)
    }

    this.group.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh && !(m as THREE.InstancedMesh).isInstancedMesh) {
        m.castShadow = true
        m.receiveShadow = true
      }
    })
    document.getElementById('loader')?.remove()
  }

  /**
   * Walking legs, the way animated animals do it: each paw is planted on the
   * ground and stays put in the world while the body moves over it (no
   * sliding), then lifts, folds, swings forward and lands ahead of the hip.
   * Two-bone IK bends the elbow / hock to keep each paw where it belongs.
   * Blends with the keyframed poses (sit, swim, air, grooming) by weight.
   */
  private plantFeet(dt: number, s: number, gph: number, duty: number, stride: number, trotW: number, gallopW: number, state: AnimState, sit: number, actW: number): void {
    const lerp = THREE.MathUtils.lerp
    const clamp = THREE.MathUtils.clamp
    const want = state === 'air' ? 0 : (1 - sit) * (1 - this.swim)
    this.ikW = lerp(this.ikW, want, 1 - Math.exp(-dt * 10))
    this.group.updateMatrixWorld(true)
    const yaw = this.group.rotation.y
    const fx = Math.sin(yaw)
    const fz = Math.cos(yaw)
    const vx = this.vel.x
    const vz = this.vel.z
    const lift = lerp(lerp(0.05, 0.07, trotW), 0.11, gallopW)
    const WALK = [Math.PI / 2, Math.PI * 1.5, 0, Math.PI]
    const TROT = [0, Math.PI, Math.PI, 0]
    const GALLOP = [0, 0.4, Math.PI, Math.PI + 0.4]
    const moving = state === 'walk'
    for (const L of this.legs) {
      const { leg, idx } = L
      // Home: under the hip (a touch outward), on the ground.
      leg.root.getWorldPosition(_hip)
      const sx = Math.cos(yaw) * L.side * 0.012
      const sz = -Math.sin(yaw) * L.side * 0.012
      _home.set(_hip.x + sx, 0, _hip.z + sz)
      _home.y = this.ground(_home.x, _home.z)
      if (!this.feetReady || L.foot.distanceToSquared(_home) > 1.5 * 1.5) {
        L.foot.copy(_home)
        L.from.copy(_home)
        L.planted = true
      }
      if (moving) {
        const off = lerp(lerp(WALK[idx], TROT[idx], trotW), GALLOP[idx], gallopW)
        let ph = ((gph + off) / (Math.PI * 2)) % 1
        if (ph < 0) ph += 1
        // A planted paw left beyond reach (sharp turn, sudden start) steps now.
        const reach = UPPER + LOWER
        const stretched = L.planted && Math.hypot(L.foot.x - _hip.x, L.foot.y + 0.035 - _hip.y, L.foot.z - _hip.z) > reach * 1.02
        if (stretched) L.forceSwing = 1
        if (L.forceSwing > 0) {
          // Quick catch-up step to just ahead of the hip.
          if (L.planted) {
            L.planted = false
            L.from.copy(L.foot)
            L.forceSwing = 1
          }
          L.forceSwing = Math.max(0, L.forceSwing - dt / 0.16)
          const u = 1 - L.forceSwing
          const sp = Math.max(s, 0.01)
          _land.set(_home.x + (vx / sp) * 0.08, 0, _home.z + (vz / sp) * 0.08)
          _land.y = this.ground(_land.x, _land.z)
          L.foot.lerpVectors(L.from, _land, u * u * (3 - 2 * u))
          L.foot.y += Math.sin(Math.PI * u) * lift
          if (L.forceSwing === 0) {
            L.planted = true
            L.foot.y = _land.y
          }
        } else if (ph < duty) {
          // Stance: planted. (Lands exactly where the swing put it.)
          if (!L.planted) {
            L.planted = true
            L.foot.y = this.ground(L.foot.x, L.foot.z)
          }
        } else {
          if (L.planted) {
            L.planted = false
            L.from.copy(L.foot)
          }
          // Swing: aim ahead of the hip by half the stance travel (along the
          // actual motion, so turns and slopes work), arc up and over.
          const u = (ph - duty) / (1 - duty)
          const sp = Math.max(s, 0.01)
          const ahead = (duty * stride) / 2
          _land.set(_home.x + (vx / sp) * ahead, 0, _home.z + (vz / sp) * ahead)
          _land.y = this.ground(_land.x, _land.z)
          const e = u * u * (3 - 2 * u)
          L.foot.lerpVectors(L.from, _land, e)
          L.foot.y += Math.pow(Math.sin(Math.PI * u), 0.8) * lift
        }
      } else {
        // Standing: settle any paw that's far from home with a little step.
        const d = Math.hypot(L.foot.x - _home.x, L.foot.z - _home.z)
        const k = 1 - Math.exp(-dt * 6)
        L.foot.x += (_home.x - L.foot.x) * k
        L.foot.z += (_home.z - L.foot.z) * k
        L.foot.y = lerp(L.foot.y, _home.y + Math.min(d, 0.06) * 0.8, k)
        L.planted = true
      }
      // Two-bone IK in the leg's plane (parent space of the hip).
      _t.copy(L.foot)
      _t.y += 0.035 // paw centre sits a paw-radius above the ground
      leg.root.parent!.worldToLocal(_t)
      const dx = _t.x - leg.root.position.x
      const dy = _t.y - leg.root.position.y
      const dzz = _t.z - leg.root.position.z
      // Splay sideways (roll about z, applied before the swing about x), then
      // solve the two bones in the leg's own plane.
      const down = Math.hypot(dx, dy)
      const splay = Math.atan2(dx, -dy)
      const D = clamp(Math.hypot(down, dzz), 0.08, (UPPER + LOWER) * 0.995)
      const a = Math.atan2(dzz, down) // forward angle of the paw from straight down
      const alpha = Math.acos(clamp((UPPER * UPPER + D * D - LOWER * LOWER) / (2 * UPPER * D), -1, 1))
      const gamma = Math.acos(clamp((UPPER * UPPER + LOWER * LOWER - D * D) / (2 * UPPER * LOWER), -1, 1))
      // Elbow / hock point backwards: the upper bone swings back from the
      // line to the paw, the lower bone folds forward.
      const ikHip = -(a - alpha)
      const ikKnee = -(Math.PI - gamma)
      const w = this.ikW * (L.front ? 1 - actW : 1 - actW * 0.6)
      leg.root.rotation.x = lerp(L.animHip, ikHip, w)
      leg.root.rotation.z = lerp(0, splay, w)
      leg.joint.rotation.x = lerp(L.animKnee, ikKnee, w)
    }
    this.feetReady = true
  }

  /** Player tells us when we're in deep water (body sinks to the waterline, legs paddle). */
  setSwimming(on: boolean): void {
    this.swimming = on
  }

  /** Ground slope along the facing direction (radians, + = uphill ahead). */
  setSlope(rad: number): void {
    this.slope = rad
  }

  setSquash(v: number): void {
    this.squashVel -= v * 6
  }

  setPose(state: AnimState, _walkPhase: number, sitMix: number, airT: number, dt: number): void {
    if (dt <= 0) return
    this.t += dt
    const lerp = THREE.MathUtils.lerp
    const clamp = THREE.MathUtils.clamp
    const sstep = THREE.MathUtils.smoothstep
    const ease = 1 - Math.exp(-dt * 14)

    // -- What the body is doing: speed, vertical speed, turn rate, accel.
    const gp = this.group.position
    const v = this.vel.copy(gp).sub(this.lastPos).divideScalar(dt)
    if (v.lengthSq() > 400) v.set(0, 0, 0) // teleports
    this.lastPos.copy(gp)
    updateFur(this.t, v) // fur streams back against the motion
    const speed = Math.hypot(v.x, v.z)
    let dYaw = this.group.rotation.y - this.lastYaw
    dYaw = Math.atan2(Math.sin(dYaw), Math.cos(dYaw))
    this.lastYaw = this.group.rotation.y
    this.speedS += (speed - this.speedS) * (1 - Math.exp(-dt * 8))
    const accel = (this.speedS - this.prevSpeed) / dt
    this.prevSpeed = this.speedS
    this.accelS += (clamp(accel, -30, 30) - this.accelS) * (1 - Math.exp(-dt * 5))
    this.yawRateS += (clamp(dYaw / dt, -8, 8) - this.yawRateS) * (1 - Math.exp(-dt * 10))
    const s = this.speedS
    const sit = state === 'sit' ? 1 : sitMix
    this.swim = lerp(this.swim, this.swimming ? 1 : 0, 1 - Math.exp(-dt * 6))
    const moving = state === 'walk' ? 1 : 0

    // Landing squash & stretch spring.
    this.squashVel += (-150 * this.squashY - 13 * this.squashVel) * dt
    this.squashY = clamp(this.squashY + this.squashVel * dt, -0.4, 0.25)
    this.root.scale.set(1 - this.squashY * 0.4, 1 + this.squashY, 1 - this.squashY * 0.4)

    // -- Gait: walk → trot → gallop by speed. Stride lengthens with speed,
    // so cadence rises gently instead of legs spinning.
    const trotW = sstep(s, 1.6, 2.8)
    const gallopW = sstep(s, 4.6, 6.4)
    // Duty factor: the share of each cycle a paw is on the ground — long in
    // a walk, half in a trot, short in a gallop (the body flies between).
    const duty = lerp(lerp(0.64, 0.46, trotW), 0.24, gallopW)
    // How far the body travels over one planted paw, limited by leg reach.
    const travel = clamp(0.14 + s * 0.08, 0.14, 0.36)
    const stride = travel / duty
    // The gait clock runs on the actual ground speed (a smoothed one lags
    // when setting off and leaves paws stranded behind the hips).
    if (moving && this.swim < 0.5) this.gaitPhase += ((Math.PI * 2 * speed) / stride) * dt
    const gph = this.gaitPhase
    // Per-leg phase offsets [FL, FR, BL, BR] for each gait.
    const WALK = [Math.PI / 2, Math.PI * 1.5, 0, Math.PI]
    const TROT = [0, Math.PI, Math.PI, 0]
    const GALLOP = [0, 0.4, Math.PI, Math.PI + 0.4]

    // -- Body pose ------------------------------------------------------------
    let bodyY = BODY_Y
    let pitch = 0
    let roll = 0
    let headPitch = 0
    let headYaw = 0
    let frontPitch = 0
    let rearPitch = 0
    let bend = 0
    if (state === 'walk') {
      // Bob: two soft bumps per cycle walking/trotting, one big bound galloping.
      const bob = Math.abs(Math.sin(gph)) * lerp(0.012, 0.024, trotW)
      bodyY += lerp(bob, Math.sin(gph) * 0.05, gallopW)
      // Gallop: the spine coils and extends; the body rocks.
      pitch += Math.sin(gph) * 0.12 * gallopW
      frontPitch = -Math.sin(gph + 0.6) * 0.2 * gallopW
      rearPitch = Math.sin(gph + 0.6) * 0.2 * gallopW
      // Walking cats sway their hips side to side.
      bend += Math.sin(gph) * 0.07 * (1 - trotW)
      roll += Math.sin(gph) * 0.03 * (1 - gallopW)
    } else if (state === 'air') {
      // Stretch out rising, tuck the nose down falling.
      pitch = clamp(-v.y * 0.035, -0.3, 0.35)
      frontPitch = -0.15 * (1 - airT)
      rearPitch = 0.15 * (1 - airT)
    } else {
      bodyY += Math.sin(this.t * 1.7) * 0.004 // breathing
      headYaw = Math.sin(this.t * 0.35) * 0.18
      headPitch = Math.sin(this.t * 0.5) * 0.05
    }
    // Momentum: lean into turns, bend the spine round them, pitch with
    // acceleration (nose dips pushing off, rises braking), follow the slope.
    const turn = clamp(this.yawRateS, -5, 5)
    roll += clamp(-turn * s * 0.03, -0.28, 0.28)
    bend += clamp(turn * 0.1, -0.35, 0.35)
    pitch += clamp(this.accelS * 0.012, -0.12, 0.12) - clamp(this.slope, -0.5, 0.5) * 0.85
    headYaw += clamp(turn * 0.14, -0.5, 0.5) // the head leads the turn

    // -- Idle life: blink; after a while standing, look about / groom / stretch.
    this.blinkT -= dt
    if (this.blinkT < -0.13) this.blinkT = 2.5 + Math.random() * 3.5
    const lid = this.blinkT < 0 ? 0.12 : 1
    for (const e of this.eyes) e.scale.y = lerp(e.scale.y, lid, 1 - Math.exp(-dt * 40))
    const idle = state === 'stand' && !this.swimming && s < 0.15
    this.idleT = idle ? this.idleT + dt : 0
    if (!idle) this.action = null
    if (idle && !this.action && this.idleT > this.nextIdle) {
      const r = Math.random()
      this.action = r < 0.45 ? 'look' : r < 0.75 ? 'groom' : 'stretch'
      this.actionT = 0
      this.actionDur = this.action === 'look' ? 2.4 : this.action === 'groom' ? 3.6 : 2.6
      this.lookYaw = (Math.random() - 0.5) * 1.8
      this.lookPitch = (Math.random() - 0.4) * 0.4
    }
    if (this.action) {
      this.actionT += dt
      if (this.actionT > this.actionDur) {
        this.action = null
        this.idleT = 0
        this.nextIdle = 4 + Math.random() * 5
      }
    }
    const act = this.action
    // Fade in/out at the ends of each action.
    const actTarget = act ? sstep(this.actionT, 0, 0.45) * (1 - sstep(this.actionT, this.actionDur - 0.5, this.actionDur)) : 0
    this.actionW = lerp(this.actionW, actTarget, 1 - Math.exp(-dt * 10))
    const aw = this.actionW * (1 - sit)
    if (act === 'look') {
      headYaw = lerp(headYaw, this.lookYaw, aw)
      headPitch = lerp(headPitch, this.lookPitch, aw)
    } else if (act === 'groom') {
      headPitch = lerp(headPitch, 0.5 + Math.sin(this.t * 9) * 0.07, aw) // licking
      headYaw = lerp(headYaw, -0.35, aw)
    } else if (act === 'stretch') {
      pitch = lerp(pitch, 0.3, aw) // play bow: chest down, rump up
      bodyY -= 0.05 * aw
    }

    // Sit: chest up, haunches down. Swim: only head + back above water.
    bodyY = lerp(bodyY, 0.4, sit)
    bodyY = lerp(bodyY, 0.12 + Math.sin(this.t * 2.2) * 0.015, this.swim)
    headPitch = lerp(headPitch, -0.25, this.swim)
    pitch = lerp(pitch, -0.62, sit)
    bend *= 1 - sit
    this.body.position.y = lerp(this.body.position.y, bodyY, ease)
    this.body.rotation.x = lerp(this.body.rotation.x, pitch, ease)
    this.body.rotation.z = lerp(this.body.rotation.z, roll * (1 - sit), ease)
    this.front.rotation.x = lerp(this.front.rotation.x, frontPitch * (1 - sit), ease)
    this.rear.rotation.x = lerp(this.rear.rotation.x, rearPitch * (1 - sit), ease)
    this.front.rotation.y = lerp(this.front.rotation.y, bend, ease)
    this.rear.rotation.y = lerp(this.rear.rotation.y, -bend * 0.7, ease)
    // Head stays level while the body rocks (counter the spine's pitch/roll).
    const bodyPitch = this.body.rotation.x + this.front.rotation.x
    this.head.rotation.x = lerp(this.head.rotation.x, headPitch + sit * 0.55 - bodyPitch * 0.7 * (1 - sit), ease)
    this.head.rotation.y = lerp(this.head.rotation.y, headYaw - bend * 0.5, ease)
    this.head.rotation.z = lerp(this.head.rotation.z, -this.body.rotation.z * 0.7, ease)

    // -- Legs -----------------------------------------------------------------
    const amp = 0.38 + 0.2 * trotW + 0.32 * gallopW
    for (const { leg, front, phase: _p, idx } of this.legs) {
      const off = lerp(lerp(WALK[idx], TROT[idx], trotW), GALLOP[idx], gallopW)
      const ph = gph + off
      let hip = 0
      let knee = front ? -0.15 : 0.25 // resting angles (back legs have a hock)
      if (state === 'walk') {
        hip = Math.sin(ph) * amp
        // Lift the paw on the forward swing; higher at speed.
        const lift = Math.max(0, Math.cos(ph)) * (0.7 + gallopW * 0.5)
        knee += front ? -lift : lift * 1.1
        // Gallop: forelegs reach far forward, hind legs drive far back.
        hip += (front ? -0.15 : 0.1) * gallopW
      } else if (state === 'air') {
        hip = front ? -0.7 : 0.75 // reach forward / stretch back
        knee = front ? -0.5 : 0.35
      }
      // Idle actions.
      if (act === 'groom' && front && idx === 0) {
        hip = lerp(hip, -1.15, aw) // paw up to the mouth
        knee = lerp(knee, -1.7, aw)
      } else if (act === 'stretch' && front) {
        hip = lerp(hip, -0.95, aw) // forelegs out in front
        knee = lerp(knee, -0.1, aw)
      } else if (act === 'stretch') {
        hip = lerp(hip, -0.25, aw)
      }
      // Sit: front legs stay vertical (cancel the body pitch); hind legs fold.
      const sitHip = front ? 0.62 : -1.35
      const sitKnee = front ? -0.05 : 2.35
      // Swimming: a steady doggy-paddle cycle, independent of ground stride.
      const paddle = Math.sin(this.t * 7 + this.legs[idx].phase)
      const swimHip = paddle * 0.7 + (front ? -0.4 : 0.5)
      const swimKnee = (front ? -0.6 : 0.6) + Math.max(0, paddle) * (front ? -0.6 : 0.6)
      const L = this.legs[idx]
      L.animHip = lerp(L.animHip, lerp(lerp(hip, sitHip, sit), swimHip, this.swim), ease)
      L.animKnee = lerp(L.animKnee, lerp(lerp(knee, sitKnee, sit), swimKnee, this.swim), ease)
    }
    this.plantFeet(dt, s, gph, duty, stride, trotW, gallopW, state, sit, act === 'groom' || act === 'stretch' ? aw : 0)

    // -- Tail: damped springs, stiff at the root and loose at the tip, so it
    // lags, swings out on turns and settles with a little overshoot.
    const n = this.tail.length
    const sub = Math.min(4, Math.ceil(dt / (1 / 120)))
    const h = dt / sub
    for (let i = 0; i < n; i++) {
      const k = i / (n - 1)
      const wave = Math.sin(this.t * (moving ? 3.2 : 1.3) - i * 0.55)
      // Proud question-mark walking, low and straight galloping, lazy idle S.
      // Walking/trotting: carried high with a hook at the tip; galloping:
      // streamed out behind for balance.
      const hook = i >= n - 3 ? 0.22 : -0.05
      let rx = i === 0 ? lerp(0.7, lerp(0.95, -0.2, gallopW), moving) : lerp(-0.12, lerp(hook, 0.02, gallopW), moving)
      let ry = wave * (moving ? 0.12 : 0.09) * (0.4 + k)
      ry += clamp(-turn * 0.06, -0.3, 0.3) * (0.4 + k) // swings outward on turns
      rx += clamp(v.y * 0.015, -0.15, 0.15) * k // flicks with jumps
      if (act === 'stretch') rx = lerp(rx, i === 0 ? -1.1 : 0.1, aw) // tail up in the bow
      // Sit: sweep around to wrap the front paws.
      rx = lerp(rx, i === 0 ? 1.2 : 0.02, sit)
      ry = lerp(ry, 0.32 + wave * 0.02, sit)
      const K = 160 * (1 - 0.65 * k)
      const D = 2 * Math.sqrt(K) * 0.55 // under-damped: a soft swish
      for (let j = 0; j < sub; j++) {
        this.tailVX[i] += ((rx - this.tailX[i]) * K - this.tailVX[i] * D) * h
        this.tailVY[i] += ((ry - this.tailY[i]) * K - this.tailVY[i] * D) * h
        this.tailX[i] += this.tailVX[i] * h
        this.tailY[i] += this.tailVY[i] * h
      }
      this.tail[i].rotation.x = this.tailX[i]
      this.tail[i].rotation.y = this.tailY[i]
    }

    // -- Ears: flick now and then idle; pinned back when running, perked
    // forward when looking around.
    this.flick -= dt
    if (this.flick < -4 - Math.random() * 3) this.flick = 0.18
    const f = this.flick > 0 ? Math.sin((this.flick / 0.18) * Math.PI) * 0.5 : 0
    const back = -0.1 - gallopW * 0.55 - trotW * 0.1 + (act === 'look' ? 0.15 * aw : 0)
    this.earL.rotation.x = lerp(this.earL.rotation.x, back, ease)
    this.earR.rotation.x = lerp(this.earR.rotation.x, back, ease)
    this.earL.rotation.z = lerp(this.earL.rotation.z, 0.28 + f + gallopW * 0.2, ease * 2)
    this.earR.rotation.z = lerp(this.earR.rotation.z, -0.28 - gallopW * 0.2, ease)
  }
}
