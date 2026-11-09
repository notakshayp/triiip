// Keyboard + touch input. Edge-triggered "jump" / "sit" via consume*() so a
// single keypress produces exactly one action (no repeat while held).

export class Input {
  private keys = new Set<string>()
  private jumpQueued = false
  private sitQueued = false
  private viewQueued = false
  private timeQueued = false
  private biomeQueued = false
  /** -1 / 0 / +1: [ and ] nudge the time of day by ±1h. */
  private nudgeQueued = 0
  /** Touch joystick vector (-1..1). */
  joyX = 0
  joyY = 0
  joyActive = false

  constructor() {
    window.addEventListener('keydown', (e) => this.onKey(e, true))
    window.addEventListener('keyup', (e) => this.onKey(e, false))
    window.addEventListener('blur', () => this.keys.clear())
    this.bindTouch()
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    const k = e.key.toLowerCase()
    // Prevent page scroll on game keys.
    if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) e.preventDefault()
    if (down) {
      if (!e.repeat) {
        if (k === ' ' || k === 'spacebar') this.jumpQueued = true
        if (k === 'c' || k === 'x' || k === 'e') this.sitQueued = true
        if (k === 'v') this.viewQueued = true
        if (k === 't') this.timeQueued = true
        if (k === 'b') this.biomeQueued = true
        if (k === '[') this.nudgeQueued -= 1
        if (k === ']') this.nudgeQueued += 1
      }
      this.keys.add(k)
    } else {
      this.keys.delete(k)
    }
  }

  /** Camera-relative move input in {-1..1} (forward+, right+). */
  getMove(): { x: number; y: number } {
    let x = 0
    let y = 0
    if (this.keys.has('w') || this.keys.has('arrowup')) y += 1
    if (this.keys.has('s') || this.keys.has('arrowdown')) y -= 1
    if (this.keys.has('a') || this.keys.has('arrowleft')) x -= 1
    if (this.keys.has('d') || this.keys.has('arrowright')) x += 1
    if (this.joyActive) {
      x += this.joyX
      y += this.joyY
    }
    // Clamp magnitude.
    const len = Math.hypot(x, y)
    if (len > 1) {
      x /= len
      y /= len
    }
    return { x, y }
  }

  /** Shift (or the touch stick pushed all the way) → sprint. */
  isSprinting(): boolean {
    return this.keys.has('shift') || (this.joyActive && Math.hypot(this.joyX, this.joyY) > 0.95)
  }

  consumeJump(): boolean {
    const j = this.jumpQueued
    this.jumpQueued = false
    return j
  }

  consumeSit(): boolean {
    const s = this.sitQueued
    this.sitQueued = false
    return s
  }

  consumeView(): boolean {
    const v = this.viewQueued
    this.viewQueued = false
    return v
  }

  consumeTime(): boolean {
    const t = this.timeQueued
    this.timeQueued = false
    return t
  }

  consumeBiome(): boolean {
    const b = this.biomeQueued
    this.biomeQueued = false
    return b
  }

  consumeNudge(): number {
    const n = this.nudgeQueued
    this.nudgeQueued = 0
    return n
  }

  private bindTouch(): void {
    const joy = document.getElementById('joystick')
    const stick = document.getElementById('stick')
    const btnJump = document.getElementById('btn-jump')
    const btnSit = document.getElementById('btn-sit')
    const btnView = document.getElementById('btn-view')
    if (!joy || !stick) return

    let joyId = -1
    const RADIUS = 44 // inner travel px
    const setStick = (dx: number, dy: number) => {
      stick.style.transform = `translate(${dx}px, ${dy}px)`
    }

    joy.addEventListener('pointerdown', (e) => {
      joyId = e.pointerId
      joy.setPointerCapture(e.pointerId)
      this.joyActive = true
      joy.dataset.active = '1'
      updateJoy(e)
    })
    joy.addEventListener('pointermove', (e) => {
      if (e.pointerId === joyId) updateJoy(e)
    })
    const endJoy = (e: PointerEvent) => {
      if (e.pointerId !== joyId) return
      joyId = -1
      this.joyActive = false
      this.joyX = 0
      this.joyY = 0
      setStick(0, 0)
      delete joy.dataset.active
    }
    joy.addEventListener('pointerup', endJoy)
    joy.addEventListener('pointercancel', endJoy)

    const updateJoy = (e: PointerEvent) => {
      const r = joy.getBoundingClientRect()
      let dx = e.clientX - (r.left + r.width / 2)
      let dy = e.clientY - (r.top + r.height / 2)
      const len = Math.hypot(dx, dy)
      if (len > RADIUS) {
        dx = (dx / len) * RADIUS
        dy = (dy / len) * RADIUS
      }
      setStick(dx, dy)
      const nx = dx / RADIUS
      const ny = -dy / RADIUS // screen up = forward
      const mag = Math.hypot(nx, ny)
      const DEAD = 0.16
      if (mag < DEAD) {
        this.joyX = 0
        this.joyY = 0
      } else {
        const clamped = Math.min(1, mag)
        this.joyX = (nx / mag) * clamped
        this.joyY = (ny / mag) * clamped
      }
    }

    btnJump?.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      this.jumpQueued = true
    })
    btnSit?.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      this.sitQueued = true
    })
    btnView?.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      this.viewQueued = true
    })
  }
}
