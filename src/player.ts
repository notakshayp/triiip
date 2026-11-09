import * as THREE from 'three'
import { groundHeight, nearestSittable, type Sittable, type TrunkCollider } from './terrain'
import { WATER_Y } from './water'
import type { Cat } from './cat'
import type { Input } from './input'
import type { FollowCamera } from './camera'

export type PlayerMode = 'move' | 'sitting' | 'swimming'

const SPEED = 3.0 // a brisk cat trot (stride/cadence look right at this pace)
const SPRINT = 7.6 // gallop (Shift)
const ACCEL = 14
const DECEL = 18
const GRAVITY = -30
const JUMP_V = 10.2
const COYOTE = 0.1
const SIT_DURATION = 0.38
const PLAYER_RADIUS = 0.38

const _fwd = new THREE.Vector3()
const _rgt = new THREE.Vector3()
const _move = new THREE.Vector3()

/**
 * Kinematic character: acceleration + friction, gravity, coyote time,
 * jump buffering. No physics engine — a few groundHeight() + circle checks.
 * Fixed-step friendly: deterministic, allocation-free.
 */
export class Player {
  readonly pos = new THREE.Vector3(0, 0, 8)
  readonly vel = new THREE.Vector3()
  /** Position to draw/follow this frame (interpolated between physics steps). */
  readonly renderPos = new THREE.Vector3()
  private prevPos = new THREE.Vector3()
  private prevFacing = Math.PI
  mode: PlayerMode = 'move'
  /** 0 = standing, 1 = fully seated. */
  sitMix = 0
  /** Sittable we are sitting on, null = ground. */
  sitSeat: Sittable | null = null
  /** Nearest sittable prompt (for UI). */
  nearbySeat: Sittable | null = null
  /** Distance actually walked (drives walk cycle, prevents foot slide). */
  walkPhase = 0
  facing = Math.PI
  /** Live water surface height (waves); flat WATER_Y until World provides one. */
  waterSurface: (x: number, z: number) => number = () => WATER_Y

  private grounded = true
  private coyoteT = 0
  private jumpBufferT = 0
  private splashT = 0
  private wakeT = 0
  isSwimming = false
  private sitT = -1 // <0 idle, 0..1 transition progress
  private sitFrom = 0
  private sitTo = 0
  private sitFromPos = new THREE.Vector3()
  private sitToPos = new THREE.Vector3()
  private groundLockY = 0 // feet y while seated on ground
  private airCap = 0 // horizontal speed kept through a jump

  constructor(
    private sittables: Sittable[],
    private trunks: TrunkCollider[],
    private input: Input,
    private cam: FollowCamera,
    private character: Cat,
    private onDust: (x: number, y: number, z: number, n: number) => void,
  ) {
    this.pos.y = this.floorAt(this.pos.x, this.pos.z, this.pos.y)
    // The cat plants its paws on whatever is underfoot (ground, rocks, logs).
    this.character.ground = (x, z) => this.floorAt(x, z, this.pos.y + 0.4)
  }

  /** Highest walkable surface under (x, z) at or below `feetY` + snap. */
  private floorAt(x: number, z: number, feetY: number): number {
    let floor = groundHeight(x, z)
    for (const s of this.sittables) {
      const d = Math.hypot(s.x - x, s.z - z)
      if (d < s.radius) {
        // Can stand on top if feet are at/above the lip (jumped up or already on it).
        if (s.topY <= feetY + 0.55) floor = Math.max(floor, s.topY)
      }
    }
    return floor
  }

  /** Push out of sittable sides + tree trunks (circle colliders). */
  private resolveSides(): void {
    for (const s of this.sittables) {
      const dx = this.pos.x - s.x
      const dz = this.pos.z - s.z
      const d = Math.hypot(dx, dz)
      const minD = s.radius + PLAYER_RADIUS
      if (d < minD && d > 1e-5) {
        const feetY = this.pos.y
        // If feet are below the top lip, block horizontally.
        if (feetY < s.topY - 0.45) {
          const push = (minD - d) / d
          this.pos.x += dx * push
          this.pos.z += dz * push
        }
      }
    }
    // Tree trunks are solid at any jump height we can reach.
    for (const t of this.trunks) {
      const dx = this.pos.x - t.x
      const dz = this.pos.z - t.z
      const d = Math.hypot(dx, dz)
      const minD = t.r + PLAYER_RADIUS
      if (d < minD && d > 1e-5) {
        const push = (minD - d) / d
        this.pos.x += dx * push
        this.pos.z += dz * push
      }
    }
  }

  /**
   * Move instantly to (x, z), landing on top of whatever is there. Cancels any
   * sit/sit-transition first — otherwise the sit logic keeps re-pinning height
   * to the *old* seat every frame, which dropped you under the map whenever
   * the destination was higher. Over water, you arrive floating at the surface.
   */
  teleport(x: number, z: number): void {
    this.mode = 'move'
    this.sitT = -1
    this.sitMix = 0
    this.sitSeat = null
    this.vel.set(0, 0, 0)
    this.jumpBufferT = 0
    const ground = this.floorAt(x, z, Infinity)
    this.pos.set(x, Math.max(ground, WATER_Y - 0.45) + 0.05, z)
    this.grounded = true
    this.prevPos.copy(this.pos)
    this.prevFacing = this.facing
    this.updateCharacter(0)
  }

  /**
   * Physics runs at a fixed 60 Hz; the screen doesn't. Place the cat (and
   * hand the camera) the state `alpha` of the way from the previous physics
   * step to the current one, so motion is even on every display — without
   * this, frames with 0 or 2 steps made the cat jump sideways on screen
   * whenever it moved across the view (diagonals shook).
   */
  interpolate(alpha: number, frameDt: number): void {
    this.renderPos.lerpVectors(this.prevPos, this.pos, alpha)
    let d = this.facing - this.prevFacing
    d = Math.atan2(Math.sin(d), Math.cos(d))
    this.character.group.position.copy(this.renderPos)
    this.character.group.rotation.y = this.prevFacing + d * alpha
    this.poseCharacter(frameDt)
  }

  /** Toggle sitting. Called once per sit keypress (edge-triggered). */
  toggleSit(): void {
    if (this.sitT >= 0) return // mid-transition: ignore
    if (this.mode === 'sitting') {
      this.standUp()
    } else {
      this.sitDown()
    }
  }

  private sitDown(): void {
    // Sitting works from the ground or mid-jump (land straight into the sit).
    // Not while actually swimming, though — sitting while floating in open
    // water isn't a real pose, and snapping to the (often much shallower or
    // deeper) floor height made the body pop weirdly above the waterline.
    const seat = this.nearbySeat
    if (this.isSwimming && !seat) return
    if (!seat && !this.grounded) return
    this.mode = 'sitting'
    this.vel.set(0, 0, 0)
    this.sitFrom = this.sitMix
    this.sitTo = 1
    this.sitT = 0
    this.sitSeat = seat
    this.sitFromPos.copy(this.pos)
    if (seat) {
      this.sitToPos.set(seat.x, seat.topY, seat.z)
      this.facing = Math.atan2(this.pos.x - seat.x, this.pos.z - seat.z)
    } else {
      this.sitToPos.copy(this.pos)
      this.groundLockY = this.floorAt(this.pos.x, this.pos.z, this.pos.y)
      this.sitToPos.y = this.groundLockY
    }
    this.onDust(this.pos.x, this.pos.y + 0.1, this.pos.z, 6)
  }

  private standUp(): void {
    this.mode = 'move'
    this.sitFrom = this.sitMix
    this.sitTo = 0
    this.sitT = 0
    // Step off the seat: keep current pos/y so landing feels continuous.
    const base = this.sitSeat ? this.sitSeat.topY : this.groundLockY
    this.pos.y = base
    this.sitSeat = null
  }

  update(dt: number): void {
    this.prevPos.copy(this.pos)
    this.prevFacing = this.facing
    // --- sit transition tween ------------------------------------------------
    if (this.sitT >= 0) {
      this.input.consumeJump() // swallow Space so standing up doesn't auto-jump
      this.sitT = Math.min(1, this.sitT + dt / SIT_DURATION)
      const e = this.sitT * this.sitT * (3 - 2 * this.sitT)
      this.sitMix = THREE.MathUtils.lerp(this.sitFrom, this.sitTo, e)
      this.pos.lerpVectors(this.sitFromPos, this.sitToPos, e)
      if (this.sitT >= 1) this.sitT = -1
      this.grounded = true
      this.updateCharacter(dt)
      return
    }

    // --- seated: locked, gentle idle only -------------------------------------
    if (this.mode === 'sitting') {
      this.input.consumeJump() // must stand (C) before jumping
      this.sitMix = 1
      const seatY = this.sitSeat ? this.sitSeat.topY : this.groundLockY
      this.pos.y = seatY
      this.updateCharacter(dt)
      return
    }

    this.nearbySeat = nearestSittable(this.sittables, this.pos.x, this.pos.z, 2.2)

    // --- swimming detection ----------------------------------------------------
    const floorHere = this.floorAt(this.pos.x, this.pos.z, this.pos.y + 0.15)
    const surface = this.waterSurface(this.pos.x, this.pos.z)
    const swimming = floorHere < WATER_Y - 0.35 && this.pos.y < surface + 0.05
    this.isSwimming = swimming
    // Was 0.55 — read as sluggish with zero visual feedback for speed.
    // Still slower than walking (water drag is real), but the wake trail
    // below is what actually sells "I'm moving", not the number itself.
    const swimMul = swimming ? 0.74 : 1
    if (swimming) {
      this.grounded = true // water supports you (walk / paddle)
      this.coyoteT = COYOTE
      // Buoyancy: float at the surface.
      // Buoyancy: float at the (moving) surface — you bob with the waves.
      const target = surface - 0.45
      this.vel.y += (target - this.pos.y) * 14 * dt - this.vel.y * 4 * dt
      this.splashT -= dt
      if (this.splashT <= 0) {
        this.onDust(this.pos.x, WATER_Y, this.pos.z, 2)
        this.splashT = 0.22
      }
      // Wake trail: small bursts behind the player, cadence tied to speed
      // (not a timer) so sprinting across water visibly throws more spray.
      const spd = Math.hypot(this.vel.x, this.vel.z)
      if (spd > 0.6) {
        this.wakeT -= spd * dt
        if (this.wakeT <= 0) {
          this.onDust(this.pos.x, WATER_Y + 0.02, this.pos.z, 3)
          this.wakeT = 0.9
        }
      }
      if (this.mode === 'move' && this.input.consumeJump()) {
        // Hop out of the water.
        this.vel.y = 5
        this.grounded = false
        this.onDust(this.pos.x, WATER_Y, this.pos.z, 8)
      }
    }

    // --- jump buffering (dry land only — water hop handled above) -------------
    if (!swimming) {
      if (this.input.consumeJump()) this.jumpBufferT = 0.12
      else this.jumpBufferT = Math.max(0, this.jumpBufferT - dt)
      if (this.jumpBufferT > 0 && (this.grounded || this.coyoteT > 0)) {
        this.vel.y = JUMP_V
        // A running leap carries its speed (galloping jumps go far).
        this.airCap = Math.hypot(this.vel.x, this.vel.z)
        this.grounded = false
        this.coyoteT = 0
        this.jumpBufferT = 0
        this.onDust(this.pos.x, this.pos.y, this.pos.z, 8)
      }
    }

    // --- camera-relative accelerate -------------------------------------------
    this.cam.getBasis(_fwd, _rgt)
    const mv = this.input.getMove()
    _move.set(0, 0, 0)
    _move.addScaledVector(_fwd, mv.y)
    _move.addScaledVector(_rgt, mv.x)
    const hasInput = _move.lengthSq() > 1e-6
    if (hasInput) _move.normalize()

    if (this.grounded) {
      // Steering, like an animal: the body turns toward the input (quick
      // pivots when slow, wide arcs at a gallop) and momentum runs along the
      // facing — no instant sideways strafing. Speed builds and bleeds off
      // with weight rather than snapping.
      const sprint = this.input.isSprinting() && !swimming
      const mag = Math.min(1, Math.hypot(mv.x, mv.y))
      const cur = Math.hypot(this.vel.x, this.vel.z)
      let target = 0
      if (hasInput) {
        const targetYaw = Math.atan2(_move.x, _move.z)
        let diff = targetYaw - this.facing
        diff = Math.atan2(Math.sin(diff), Math.cos(diff))
        const turnRate = THREE.MathUtils.lerp(14, 4.5, THREE.MathUtils.smoothstep(cur, 2, SPRINT))
        this.facing = dampAngle(this.facing, targetYaw, turnRate, dt)
        // Slow down through sharp turns (and to pivot when reversing).
        const align = Math.max(0, Math.cos(diff))
        target = (sprint ? SPRINT : SPEED) * swimMul * mag * (0.25 + 0.75 * align)
      }
      const rate = (target > cur ? ACCEL * (sprint ? 0.8 : 1) : DECEL) * dt
      const next = cur + THREE.MathUtils.clamp(target - cur, -rate, rate)
      this.vel.x = Math.sin(this.facing) * next
      this.vel.z = Math.cos(this.facing) * next
      if (next < 0.05 && !hasInput) {
        this.vel.x = 0
        this.vel.z = 0
      }
      this.coyoteT = COYOTE
    } else {
      // Air control (lighter).
      this.vel.x += _move.x * ACCEL * 0.45 * dt
      this.vel.z += _move.z * ACCEL * 0.45 * dt
      const h = Math.hypot(this.vel.x, this.vel.z)
      const cap = Math.max(SPEED * 1.05, this.airCap)
      if (h > cap) {
        this.vel.x = (this.vel.x / h) * cap
        this.vel.z = (this.vel.z / h) * cap
      }
      this.coyoteT = Math.max(0, this.coyoteT - dt)
    }

    // --- gravity + integrate (buoyancy replaces gravity while swimming) ----------
    if (!swimming) {
      this.vel.y += GRAVITY * dt
      if (this.vel.y < -22) this.vel.y = -22
    }

    this.pos.x += this.vel.x * dt
    this.pos.z += this.vel.z * dt
    this.pos.y += this.vel.y * dt

    // Infinite world: no world clamp. Chunks stream around the player.
    this.resolveSides()

    // --- ground snap --------------------------------------------------------------
    const floor = this.floorAt(this.pos.x, this.pos.z, this.pos.y + 0.15)
    if (this.pos.y <= floor) {
      const wasAir = !this.grounded && this.vel.y < -6
      this.pos.y = floor
      this.vel.y = 0
      this.grounded = true
      this.airCap = 0
      if (wasAir) {
        this.onDust(this.pos.x, this.pos.y, this.pos.z, 10)
        this.character.setSquash(0.5)
      }
    } else if (this.pos.y > floor + 0.02 && !swimming) {
      // While swimming the lakebed is far below — water supports us.
      this.grounded = false
    }
    if (swimming) this.grounded = true

    // Walk phase from horizontal travel (no foot slide, even when accelerating).
    const hs = Math.hypot(this.vel.x, this.vel.z)
    if (this.grounded) this.walkPhase += hs * dt * 2.6

    this.updateCharacter(dt)
  }

  private updateCharacter(_dt: number): void {
    this.character.group.position.copy(this.pos)
    this.character.group.rotation.y = this.facing
  }

  /**
   * Pose the cat for this rendered frame (after interpolate placed it). Runs
   * per frame, not per physics step: planted paws are locked in the world,
   * so the pose must be solved where the body is actually drawn.
   */
  private poseCharacter(dt: number): void {
    // Slope under the body along the facing (for the body's pitch).
    const fx = Math.sin(this.facing) * 0.35
    const fz = Math.cos(this.facing) * 0.35
    const ahead = groundHeight(this.pos.x + fx, this.pos.z + fz)
    const behind = groundHeight(this.pos.x - fx, this.pos.z - fz)
    this.character.setSlope(this.grounded && !this.isSwimming ? Math.atan2(ahead - behind, 0.7) : 0)
    const hs = Math.hypot(this.vel.x, this.vel.z)
    let state: 'stand' | 'walk' | 'air' | 'sit' = 'stand'
    if (this.mode === 'sitting' || this.sitMix > 0.02) state = this.sitMix > 0.6 ? 'sit' : this.grounded ? 'stand' : 'air'
    else if (!this.grounded) state = 'air'
    else if (hs > 0.3) state = 'walk'
    else state = 'stand'
    const airT = this.grounded ? 0 : Math.min(1, Math.abs(this.vel.y) / 12)
    this.character.setSwimming(this.isSwimming)
    this.character.setPose(state, this.walkPhase, this.sitMix, airT, dt)
  }

  /** UI label for the contextual prompt. */
  getPrompt(): string {
    if (this.mode === 'sitting') {
      return this.sitSeat ? `Sitting on ${this.sitSeat.label} — press C to stand` : 'Sitting — press C to stand'
    }
    if (this.sitT >= 0) return '…'
    // Swimming hint: feet below water level.
    if (this.floorAt(this.pos.x, this.pos.z, this.pos.y + 0.15) < WATER_Y - 0.35) {
      return this.nearbySeat ? `Swimming · Space to hop out · C to sit on the ${this.nearbySeat.label}` : 'Swimming · Space to hop out'
    }
    if (this.nearbySeat) return `Press C to sit on the ${this.nearbySeat.label}`
    return 'Press C to sit'
  }
}

function dampAngle(a: number, b: number, lambda: number, dt: number): number {
  let d = (b - a) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d < -Math.PI) d += Math.PI * 2
  return a + d * (1 - Math.exp(-lambda * dt))
}
