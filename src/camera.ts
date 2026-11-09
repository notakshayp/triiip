import * as THREE from 'three'
import { groundHeight } from './terrain'
import { WATER_Y } from './water'
import { CAT_EYE_SIT, CAT_EYE_STAND, CAT_LOOK_AT } from './cat'

// Third-person by default (you're a cat — you should see it); V toggles
// first-person. Drag = look. Wheel = zoom (TP only). All damped, zero
// allocation. While you walk and leave the mouse alone, the orbit eases
// round behind the cat, pulls back a little with speed and leads toward
// where you're heading — the camera follows the walk instead of being steered.

const _desired = new THREE.Vector3()
const _look = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _lead = new THREE.Vector3()

export class FollowCamera {
  /** First-person look direction (yaw/pitch). */
  lookYaw = Math.PI
  lookPitch = 0.18 // slight upward tilt — shows the blue upper sky
  /** Third-person orbit (used when firstPerson = false). */
  private orbYaw = Math.PI * 0.85
  private orbPitch = 0.38
  private orbDist = 4.6 // cat-sized player: sit closer
  firstPerson = false
  /** Seconds since the player last turned the camera by hand. */
  private idleLook = 99
  private distKick = 0
  private leadS = new THREE.Vector3()

  private dragging = false
  private lastX = 0
  private lastY = 0
  private pointerId = -1
  private headBob = 0
  /** True once the browser grants continuous mouselook (no button hold). */
  private locked = false

  constructor(private canvas: HTMLCanvasElement, private camera: THREE.PerspectiveCamera) {
    canvas.addEventListener('pointerdown', (e) => this.onDown(e))
    window.addEventListener('pointermove', (e) => this.onMove(e))
    window.addEventListener('pointerup', (e) => this.onUp(e))
    window.addEventListener('pointercancel', (e) => this.onUp(e))
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false })
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas
      document.getElementById('lock-hint')?.toggleAttribute('hidden', this.locked)
    })
  }

  toggleMode(): void {
    this.firstPerson = !this.firstPerson
    // Keep yaw continuous between modes.
    if (this.firstPerson) {
      this.lookYaw = this.orbYaw + Math.PI
    } else {
      this.orbYaw = this.lookYaw - Math.PI
    }
  }

  private onDown(e: PointerEvent): void {
    const t = e.target as HTMLElement
    if (t.closest('#touch-ui') || t.closest('button')) return
    // Mouse (not touch): click-to-lock for continuous look, the standard
    // feel for this genre — no more holding the button down to turn.
    if (e.pointerType === 'mouse' && document.pointerLockElement !== this.canvas) {
      this.canvas.requestPointerLock()
    }
    this.dragging = true
    this.pointerId = e.pointerId
    this.lastX = e.clientX
    this.lastY = e.clientY
  }

  private onMove(e: PointerEvent): void {
    if (this.locked) {
      // Pointer-locked: look follows raw mouse movement, button or not.
      this.applyLook(e.movementX, e.movementY)
      return
    }
    if (!this.dragging || e.pointerId !== this.pointerId) return
    const dx = e.clientX - this.lastX
    const dy = e.clientY - this.lastY
    this.lastX = e.clientX
    this.lastY = e.clientY
    this.applyLook(dx, dy)
  }

  /** Touch drag + locked mouse both funnel through here. */
  private applyLook(dx: number, dy: number): void {
    this.idleLook = 0
    if (this.firstPerson) {
      this.lookYaw -= dx * 0.0042
      this.lookPitch = Math.min(1.35, Math.max(-1.35, this.lookPitch - dy * 0.004))
    } else {
      this.orbYaw -= dx * 0.005
      this.orbPitch = Math.min(1.15, Math.max(-0.15, this.orbPitch + dy * 0.004))
    }
  }

  private onUp(e: PointerEvent): void {
    if (e.pointerId === this.pointerId) {
      this.dragging = false
      this.pointerId = -1
    }
  }

  private onWheel(e: WheelEvent): void {
    if (this.firstPerson) return
    e.preventDefault()
    this.orbDist = Math.min(9, Math.max(2.4, this.orbDist + e.deltaY * 0.008))
  }

  /** Eye height above feet for the current sit blend. */
  static eyeHeight(sitMix: number, moving: number, walkPhase: number): number {
    const sit = THREE.MathUtils.lerp(CAT_EYE_STAND, CAT_EYE_SIT, sitMix)
    const bob = moving > 0.3 ? Math.abs(Math.sin(walkPhase)) * 0.045 : 0
    return sit + bob
  }

  update(
    dt: number,
    playerPos: THREE.Vector3,
    sitMix: number,
    moving: number,
    walkPhase: number,
    snap = false,
    facing = 0,
    vel?: THREE.Vector3,
  ): void {
    this.idleLook += dt
    const speed = vel ? Math.hypot(vel.x, vel.z) : 0
    if (this.firstPerson) {
      const eye = FollowCamera.eyeHeight(sitMix, moving, walkPhase)
      // Gentle sway adds life without motion sickness.
      this.headBob = snap ? 0 : this.headBob + dt * 1.4
      const sway = Math.sin(this.headBob) * 0.006 * (moving > 0.3 ? 0 : 1)
      this.camera.position.set(
        playerPos.x + Math.sin(this.lookYaw) * sway,
        playerPos.y + eye,
        playerPos.z + Math.cos(this.lookYaw) * sway,
      )
      _dir.set(
        -Math.sin(this.lookYaw) * Math.cos(this.lookPitch),
        Math.sin(this.lookPitch),
        -Math.cos(this.lookYaw) * Math.cos(this.lookPitch),
      )
      _look.copy(this.camera.position).add(_dir)
      this.camera.lookAt(_look)
      return
    }

    // Third person: damped orbit follow.
    if (!snap && speed > 0.6 && this.idleLook > 1.2) {
      // Ease round behind the cat — only when it's already heading mostly
      // away from the camera. Movement is camera-relative, so chasing a
      // diagonal or a strafe would turn the cat in endless circles.
      const behind = facing + Math.PI
      let d = behind - this.orbYaw
      d = Math.atan2(Math.sin(d), Math.cos(d))
      const ahead = 1 - THREE.MathUtils.smoothstep(Math.abs(d), 0.2, 0.6)
      const rate = Math.min(1, (speed - 0.6) / 4) * 1.4 * ahead * Math.min(1, (this.idleLook - 1.2) / 1.0)
      this.orbYaw += d * (1 - Math.exp(-dt * rate))
    }
    // Pull back a touch at a gallop; lead the framing toward where you go.
    this.distKick += (THREE.MathUtils.smoothstep(speed, 3, 7.5) * 1.3 - this.distKick) * (1 - Math.exp(-dt * 1.5))
    if (vel) _lead.set(vel.x, 0, vel.z).multiplyScalar(0.18)
    else _lead.set(0, 0, 0)
    this.leadS.lerp(_lead, snap ? 1 : 1 - Math.exp(-dt * 2))
    const dist = this.orbDist + this.distKick
    _desired.set(playerPos.x + this.leadS.x, playerPos.y + CAT_LOOK_AT, playerPos.z + this.leadS.z)
    const cp = Math.cos(this.orbPitch)
    const sp = Math.sin(this.orbPitch)
    _look.set(
      _desired.x + Math.sin(this.orbYaw) * cp * dist,
      _desired.y + sp * dist,
      _desired.z + Math.cos(this.orbYaw) * cp * dist,
    )
    // Never let the orbit camera dip below the ground or the water surface —
    // that's what was showing the underside of the lake (fine from above,
    // reads as broken/see-through from below since nothing renders there).
    const floorAtLook = Math.max(groundHeight(_look.x, _look.z), WATER_Y)
    if (_look.y < floorAtLook + 0.35) _look.y = floorAtLook + 0.35
    if (snap) {
      this.camera.position.copy(_look)
    } else {
      const k = 1 - Math.exp(-dt * 8)
      this.camera.position.lerp(_look, k)
    }
    _desired.y += 0.15
    this.camera.lookAt(_desired)
  }

  /** Camera-relative forward/right for movement. */
  getBasis(outF: THREE.Vector3, outR: THREE.Vector3): void {
    if (this.firstPerson) {
      outF.set(-Math.sin(this.lookYaw), 0, -Math.cos(this.lookYaw))
    } else {
      outF.set(-Math.sin(this.orbYaw), 0, -Math.cos(this.orbYaw))
    }
    outR.set(-outF.z, 0, outF.x)
  }

  /** Hide the avatar body in FP so the camera isn't inside the head. */
  static setBodyVisible(characterGroup: THREE.Object3D, firstPerson: boolean): void {
    characterGroup.visible = !firstPerson
  }
}
