// Adaptive quality — steps pixel ratio down when FPS sags, restores when
// headroom returns. Single mechanism keeps any GPU smooth at 60 fps.

type RendererLike = { setPixelRatio: (n: number) => void; setSize: (w: number, h: number, b?: boolean) => void }

// Floor goes below native (0.6×) so weaker GPUs have real headroom to
// protect 60fps instead of bottoming out at "native res, whatever fps that is".
const DPR_STEPS = [0.6, 0.75, 1, 1.25, 1.5, 1.75, 2]

export class AdaptiveQuality {
  private step = 6 // start at highest sensible (clamped to devicePixelRatio)
  private acc = 0
  private frames = 0
  private cool = 0

  constructor(private renderer: RendererLike, private canvas: HTMLCanvasElement, private onApply?: (w: number, h: number, dpr: number) => void) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    // Pick the step closest to the device DPR.
    let best = 0
    for (let i = 0; i < DPR_STEPS.length; i++) {
      if (DPR_STEPS[i] <= dpr) best = i
    }
    this.step = best
    this.apply()
  }

  private apply(): void {
    const dpr = DPR_STEPS[this.step]
    this.renderer.setPixelRatio(dpr)
    const w = this.canvas.clientWidth || window.innerWidth
    const h = this.canvas.clientHeight || window.innerHeight
    this.renderer.setSize(w, h, false)
    this.onApply?.(w, h, dpr)
  }

  /** Feed each rendered frame's dt. Call from the render loop. */
  tick(dt: number): void {
    this.acc += dt
    this.frames++
    this.cool = Math.max(0, this.cool - dt)
    if (this.frames < 45) return // react within ~0.75s, not ~1.5s
    const avg = this.acc / this.frames
    const fps = avg > 0 ? 1 / avg : 60
    this.acc = 0
    this.frames = 0
    if (this.cool > 0) return

    if (fps < 54 && this.step > 0) {
      this.step--
      this.apply()
      this.cool = 1.5
    } else if (fps > 59 && this.step < DPR_STEPS.length - 1) {
      // Only upscale if device allows it.
      const maxStep = DPR_STEPS.findIndex((s) => s > (window.devicePixelRatio || 1) + 0.001)
      const cap = maxStep === -1 ? DPR_STEPS.length - 1 : maxStep - 1
      if (this.step < cap) {
        this.step++
        this.apply()
        this.cool = 4
      }
    }
  }
}
