// ---------------------------------------------------------------------------
// Environmental SFX — real footstep samples (Kenney "Impact Sounds", CC0,
// kenney.nl — same licence family as the Nature Kit props) layered with
// WebAudio-synthesised wind / rustle / crickets / splash (continuous ambient
// textures synthesise fine; percussive one-shots like footsteps did not).
// AudioContext starts on first user gesture; `M` or the pill toggles mute.
// ---------------------------------------------------------------------------

const FOOTSTEP_URLS = [0, 1, 2, 3, 4].map((i) => `${import.meta.env.BASE_URL}sfx/footstep-grass-${i}.ogg`)

export class Sfx {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private windGain: GainNode | null = null
  private windSrc: AudioBufferSourceNode | null = null
  private cricketTimer: number | null = null
  private footstepBuffers: AudioBuffer[] = []
  private lastFootstep = -1
  enabled = true
  private footCooldown = 0

  /** Call on any user gesture (keydown/pointer/touch). */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume()
      return
    }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!AC) return
    this.ctx = new AC()
    this.master = this.ctx.createGain()
    this.master.gain.value = 0.5
    this.master.connect(this.ctx.destination)
    this.startWind()
    this.loadFootsteps()
  }

  private loadFootsteps(): void {
    const ctx = this.ctx!
    for (const url of FOOTSTEP_URLS) {
      fetch(url)
        .then((r) => r.arrayBuffer())
        .then((buf) => ctx.decodeAudioData(buf))
        .then((decoded) => this.footstepBuffers.push(decoded))
        .catch((e) => console.error('[Sfx] footstep load failed', url, e))
    }
  }

  toggle(): boolean {
    this.enabled = !this.enabled
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(this.enabled ? 0.5 : 0, this.ctx.currentTime, 0.05)
    }
    return this.enabled
  }

  /** Grass/dirt footstep (real sample). Call on stride phase; `wet` = in water. */
  footstep(wet: boolean, dt: number): void {
    if (!this.ctx || !this.enabled) return
    this.footCooldown = Math.max(0, this.footCooldown - dt)
    if (this.footCooldown > 0) return
    this.footCooldown = wet ? 0.24 : 0.34
    const t = this.ctx.currentTime

    if (!wet && this.footstepBuffers.length > 0) {
      // Real sample, pick-not-repeat + slight pitch/volume jitter so a
      // steady stride doesn't sound like the same .wav on a loop.
      let i = Math.floor(Math.random() * this.footstepBuffers.length)
      if (i === this.lastFootstep) i = (i + 1) % this.footstepBuffers.length
      this.lastFootstep = i
      const src = this.ctx.createBufferSource()
      src.buffer = this.footstepBuffers[i]
      src.playbackRate.value = 0.92 + Math.random() * 0.18
      const g = this.ctx.createGain()
      g.gain.value = 0.55 + Math.random() * 0.15
      src.connect(g).connect(this.master!)
      src.start(t)
      return
    }

    this.paddle(false)
  }

  /**
   * Water sounds are all soft, low and short — water heard from close by,
   * not cartoon splashes. A filtered noise "slosh" (soft attack, a body that
   * sweeps down) plus, for a proper plunge, two or three low bubble "bloops"
   * (bubbles rise in pitch as they ring — a falling tone sounds like a laser).
   */
  private slosh(t: number, gain: number, freq: number, dur: number, attack = 0.03): void {
    const ctx = this.ctx!
    const src = ctx.createBufferSource()
    src.buffer = this.noiseBuffer(dur + 0.1)
    src.playbackRate.value = 0.9 + Math.random() * 0.2
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.Q.value = 0.9
    bp.frequency.setValueAtTime(freq, t)
    bp.frequency.exponentialRampToValueAtTime(freq * 0.55, t + dur)
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 1800
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.linearRampToValueAtTime(gain, t + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    src.connect(bp).connect(lp).connect(g).connect(this.master!)
    src.start(t)
    src.stop(t + dur + 0.1)
  }

  private bubble(t: number, gain: number): void {
    const ctx = this.ctx!
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    const f0 = 220 + Math.random() * 180
    osc.frequency.setValueAtTime(f0, t)
    osc.frequency.exponentialRampToValueAtTime(f0 * 1.9, t + 0.07)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.linearRampToValueAtTime(gain, t + 0.008)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09)
    osc.connect(g).connect(this.master!)
    osc.start(t)
    osc.stop(t + 0.1)
  }

  /** Slipping into deep water. */
  waterEnter(): void {
    if (!this.ctx || !this.master || !this.enabled) return
    const t = this.ctx.currentTime
    this.slosh(t, 0.16, 700, 0.55, 0.02)
    this.slosh(t + 0.12, 0.07, 420, 0.5, 0.06)
    for (let i = 0; i < 3; i++) this.bubble(t + 0.08 + Math.random() * 0.25, 0.025)
  }

  /** Climbing out: water running off the fur. */
  waterExit(): void {
    if (!this.ctx || !this.master || !this.enabled) return
    const t = this.ctx.currentTime
    this.slosh(t, 0.06, 900, 0.4, 0.05)
    this.slosh(t + 0.15, 0.035, 1200, 0.5, 0.08)
  }

  /** One swim stroke or a step through shallows — a quiet swish. */
  paddle(wading: boolean): void {
    if (!this.ctx || !this.master || !this.enabled) return
    const t = this.ctx.currentTime
    this.slosh(t, wading ? 0.06 : 0.045, wading ? 1100 : 650, wading ? 0.22 : 0.35, wading ? 0.015 : 0.06)
  }

  private noiseBuffer(dur: number): AudioBuffer {
    const ctx = this.ctx!
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur))
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
    return buf
  }

  /** Soft looping wind (filtered brown noise with slow gusts). */
  private startWind(): void {
    if (!this.ctx || !this.master || this.windSrc) return
    const ctx = this.ctx
    const len = ctx.sampleRate * 4
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)
    const data = buf.getChannelData(0)
    let last = 0
    for (let i = 0; i < len; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02
      data[i] = last * 3.5
    }
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.loop = true
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 520
    filter.Q.value = 0.4
    const g = ctx.createGain()
    g.gain.value = 0.22 // clearly audible hush, not a whisper
    const lfo = ctx.createOscillator()
    lfo.frequency.value = 0.11
    const lfoGain = ctx.createGain()
    lfoGain.gain.value = 260
    lfo.connect(lfoGain).connect(filter.frequency)
    const gust = ctx.createOscillator()
    gust.frequency.value = 0.043
    const gustGain = ctx.createGain()
    gustGain.gain.value = 0.08
    gust.connect(gustGain).connect(g.gain)
    src.connect(filter).connect(g).connect(this.master)
    src.start()
    lfo.start()
    gust.start()
    this.windSrc = src
    this.windGain = g
    // Continuous grass rustle while moving (band-passed noise loop).
    this.startRustle()
    this.startRain()
  }

  private surfWash: GainNode | null = null
  private surfBreak: GainNode | null = null
  private surfFilter: BiquadFilterNode | null = null

  /**
   * Surf: a low constant wash (the sea's roar) plus a breaker layer whose
   * loudness and brightness follow the breaking wave nearest you — a hiss
   * that swells as the crest tumbles, then drains away down the sand.
   */
  private startSurf(): void {
    if (!this.ctx || !this.master || this.surfWash) return
    const ctx = this.ctx
    const len = ctx.sampleRate * 6
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)
    const data = buf.getChannelData(0)
    let last = 0
    for (let i = 0; i < len; i++) {
      last = (last + 0.05 * (Math.random() * 2 - 1)) / 1.05
      data[i] = last * 3.2
    }
    const wash = ctx.createBufferSource()
    wash.buffer = buf
    wash.loop = true
    const washLp = ctx.createBiquadFilter()
    washLp.type = 'lowpass'
    washLp.frequency.value = 380
    const washG = ctx.createGain()
    washG.gain.value = 0
    wash.connect(washLp).connect(washG).connect(this.master)
    wash.start()

    const white = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate)
    const wd = white.getChannelData(0)
    let pink = 0
    for (let i = 0; i < wd.length; i++) {
      pink = pink * 0.6 + (Math.random() * 2 - 1) * 0.4
      wd[i] = pink * 1.6
    }
    const hiss = ctx.createBufferSource()
    hiss.buffer = white
    hiss.loop = true
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 900
    lp.Q.value = 0.3
    const g = ctx.createGain()
    g.gain.value = 0
    hiss.connect(lp).connect(g).connect(this.master)
    hiss.start()
    this.surfWash = washG
    this.surfBreak = g
    this.surfFilter = lp
  }

  /**
   * `level` 0..1 — how much open shore is near; `phase` 0..1 — the breaker
   * cycle there (rises 0.5→0.68, crest/crash ≈ 0.68, backwash → 1).
   */
  setSurf(level: number, phase: number): void {
    if (!this.ctx) return
    if (!this.surfWash) this.startSurf()
    const t = this.ctx.currentTime
    const L = Math.min(1, Math.max(0, level))
    this.surfWash!.gain.setTargetAtTime(L * 0.16, t, 0.5)
    // Crash: peaks just after the crest, drains over the backwash.
    const ss = (e0: number, e1: number, x: number) => {
      const k = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
      return k * k * (3 - 2 * k)
    }
    const crash = ss(0.56, 0.7, phase) * (1 - ss(0.7, 1.0, phase))
    this.surfBreak!.gain.setTargetAtTime(L * (0.03 + crash * 0.26), t, 0.12)
    this.surfFilter!.frequency.setTargetAtTime(500 + crash * 2600, t, 0.15)
  }

  private rustleGain: GainNode | null = null

  private startRustle(): void {
    if (!this.ctx || !this.master || this.rustleGain) return
    const ctx = this.ctx
    const len = ctx.sampleRate * 2
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)
    const data = buf.getChannelData(0)
    // Pinkish (integrated) noise — soft swish, not harsh white static.
    let last = 0
    for (let i = 0; i < len; i++) {
      last = (last + 0.06 * (Math.random() * 2 - 1)) / 1.06
      data[i] = last * 3.0
    }
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.loop = true
    const filter = ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.value = 850
    filter.Q.value = 0.5
    const g = ctx.createGain()
    g.gain.value = 0
    // Slow amplitude wander so it breathes like real grass.
    const wobble = ctx.createOscillator()
    wobble.frequency.value = 0.9
    const wobbleGain = ctx.createGain()
    wobbleGain.gain.value = 0.02
    wobble.connect(wobbleGain).connect(g.gain)
    wobble.start()
    src.connect(filter).connect(g).connect(this.master)
    src.start()
    this.rustleGain = g
  }

  /** 0 = still, 1 = full-speed grass swish. Call per frame while moving. */
  setRustle(level: number): void {
    if (!this.ctx || !this.rustleGain) return
    const target = Math.min(1, Math.max(0, level)) * 0.05
    this.rustleGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.08)
  }

  private rainGain: GainNode | null = null

  /** Brighter, denser noise loop than rustle — a proper hiss, not a swish. */
  private startRain(): void {
    if (!this.ctx || !this.master || this.rainGain) return
    const ctx = this.ctx
    const len = ctx.sampleRate * 2
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.loop = true
    const filter = ctx.createBiquadFilter()
    filter.type = 'highpass'
    filter.frequency.value = 1400
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 6500
    const g = ctx.createGain()
    g.gain.value = 0
    src.connect(filter).connect(lp).connect(g).connect(this.master)
    src.start()
    this.rainGain = g
  }

  /** 0..1 — weather intensity drives this directly. */
  setRain(intensity: number): void {
    if (!this.ctx || !this.rainGain) return
    const target = Math.min(1, Math.max(0, intensity)) * 0.3
    this.rainGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.6)
  }

  /** Night crickets: band-limited chirp trains, only while `night` is true. */
  setNight(night: boolean): void {
    if (!this.ctx || !this.master) return
    if (night && this.cricketTimer === null) {
      const chirp = () => {
        if (!this.ctx || !this.enabled) return
        const t0 = this.ctx.currentTime
        for (let pulse = 0; pulse < 4; pulse++) {
          const osc = this.ctx.createOscillator()
          osc.type = 'sine'
          osc.frequency.value = 4200 + Math.random() * 600
          const g = this.ctx.createGain()
          const start = t0 + pulse * 0.045
          g.gain.setValueAtTime(0, start)
          g.gain.linearRampToValueAtTime(0.035, start + 0.008)
          g.gain.exponentialRampToValueAtTime(0.001, start + 0.03)
          osc.connect(g).connect(this.master!)
          osc.start(start)
          osc.stop(start + 0.04)
        }
      }
      chirp()
      this.cricketTimer = window.setInterval(chirp, 700 + Math.random() * 300)
    } else if (!night && this.cricketTimer !== null) {
      window.clearInterval(this.cricketTimer)
      this.cricketTimer = null
    }
  }
}
