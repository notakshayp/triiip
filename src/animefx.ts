import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { WaterPass, type GhibliWater } from './water'

// ---------------------------------------------------------------------------
// Anime post-processing — the "walking inside an anime" grade:
//   • ink outlines from depth discontinuities (Ghibli line-art feel)
//   • gentle colour posterisation + warm lift (anime palette)
//   • height-fog volumetric haze hugging the ground (Ghibli mist)
//   • sun-ray haze in the sky band + subtle vignette
// One full-screen pass on top of the normal render (depth reuses the main
// depth buffer), strength cycles: 1 subtle → 2 washed → 0 raw.
// ---------------------------------------------------------------------------

const AnimeShader = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    resolution: { value: new THREE.Vector2(1, 1) },
    uNear: { value: 0.1 },
    uFar: { value: 500 },
    uInvProj: { value: new THREE.Matrix4() },
    uCamWorld: { value: new THREE.Matrix4() },
    uCamPos: { value: new THREE.Vector3() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(0xfff4d6) },
    uFogColor: { value: new THREE.Color(0xbfe3ff) },
    uFogDensity: { value: 0.006 },
    uHorizon: { value: 1.1 },
    uStrength: { value: 1 }, // 0 off, 1 subtle, 2 strong
    uTime: { value: 0 },
    tNoise: { value: null as THREE.Texture | null },
    uCloudCover: { value: 0.5 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform vec2 resolution;
    uniform float uNear;
    uniform float uFar;
    uniform mat4 uInvProj;
    uniform mat4 uCamWorld;
    uniform vec3 uCamPos;
    uniform vec3 uSunDir;
    uniform vec3 uSunColor;
    uniform vec3 uFogColor;
    uniform float uFogDensity;
    uniform float uHorizon;
    uniform float uStrength;
    uniform float uTime;
    uniform sampler2D tNoise;
    uniform float uCloudCover;
    varying vec2 vUv;

    #define saturate(x) clamp(x, 0.0, 1.0)

    /** Non-linear depth → metres from the camera (perspective). */
    float linearDepth(vec2 uv) {
      float d = texture2D(tDepth, uv).x;
      return (2.0 * uNear * uFar) / (uFar + uNear - (d * 2.0 - 1.0) * (uFar - uNear));
    }

    /** Screen uv + depth → world position. */
    vec3 worldPos(vec2 uv, float depth) {
      vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
      vec4 view = uInvProj * clip;
      view /= view.w;
      return (uCamWorld * vec4(view.xyz, 1.0)).xyz;
    }

    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      if (any(isnan(src)) || any(isinf(src))) src = vec4(0.0, 0.0, 0.0, 1.0); // contain bad pixels
      vec3 col = src.rgb;
      float s = uStrength;

      if (s > 0.0) {
        float d = linearDepth(vUv);

        // -- Ink outline: depth discontinuity → darkened silhouette edges.
        float px = 1.0 / resolution.x;
        float py = 1.0 / resolution.y;
        float dR = linearDepth(vUv + vec2(px * 1.5, 0.0));
        float dU = linearDepth(vUv + vec2(0.0, py * 1.5));
        float edge = 0.0;
        if (d < uFar * 0.98) {
          float df = max(abs(d - dR) / max(d, 1.0), abs(d - dU) / max(d, 1.0));
          edge = smoothstep(0.03, 0.12, df) * min(1.0, 120.0 / (d + 40.0));
        }
        // Soft line work: a faint, cool-tinted edge on silhouettes — not black
        // ink (that read as harsh, comic-book contrast).
        col = mix(col, col * vec3(0.74, 0.78, 0.88), edge * 0.3);

        // -- Dreamy grade. No posterising (that was the colour banding):
        // pastel saturation, lifted lilac-blue shadows, warm highlights.
        float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
        col = mix(vec3(lum), col, 1.1);
        col = col * 0.95 + vec3(0.016, 0.02, 0.034);
        col *= mix(vec3(1.02, 1.03, 0.98), vec3(1.06, 1.02, 0.94), smoothstep(0.3, 1.2, lum));
      }

      // -- Volumetric ground haze (world-space height fog).
      if (s > 0.0) {
        float wDepth = texture2D(tDepth, vUv).x;
        if (wDepth < 1.0) {
          vec3 wp = worldPos(vUv, wDepth);
          float dist = length(wp - uCamPos);
          // -- Cloud shadows: follow the sun ray up to the cloud deck and
          // sample a drifting noise field there. Big soft shadows roll over
          // the land, so midday has light/shade rhythm instead of flat green.
          vec3 L = normalize(uSunDir);
          if (L.y > 0.05) {
            vec2 cp = wp.xz + L.xz / L.y * (220.0 - wp.y);
            vec2 wind = vec2(uTime * 2.2, uTime * 0.9);
            float n = texture2D(tNoise, (cp + wind) * 0.0024).r * 0.65 + texture2D(tNoise, (cp + wind * 1.4) * 0.0065 + 0.5).g * 0.35;
            float cover = mix(0.62, 0.42, uCloudCover);
            float shade = smoothstep(cover, cover + 0.16, n) * smoothstep(0.05, 0.3, L.y) * (1.0 - smoothstep(350.0, 700.0, dist));
            col *= mix(vec3(1.04, 1.02, 0.98), vec3(0.7, 0.76, 0.9), shade * 0.75);
          }
          float heightF = exp(-max(wp.y - uHorizon, 0.0) * 0.55); // hugs the ground
          // Starts beyond the near field and stays light: a mist lying in
          // distant valleys, never a veil over where you're walking.
          float row = (1.0 - exp(-max(dist - 70.0, 0.0) * uFogDensity * heightF)) * 0.55;
          // Sky-melting horizon blend so terrain fades into the sky colour.
          vec3 haze = mix(uFogColor, uSunColor * 0.85, 0.18);
          col = mix(col, haze, saturate(row * s * 0.9));
        }

        // -- Sun-ray haze: cheap directional bloom toward the sun.
        vec3 rayDir = normalize(worldPos(vUv, 0.999) - uCamPos);
        float sun = saturate(dot(rayDir, normalize(uSunDir)));
        // flicker-free: slight scatter wobble
        float wobble = 1.0 + 0.03 * sin(uTime * 0.7 + vUv.y * 37.0);
        col += uSunColor * pow(sun, 18.0) * 0.16 * s * wobble;
        col += uSunColor * pow(sun, 90.0) * 0.5 * s * wobble;
      }

      // -- Vignette (soft, never crushing).
      vec2 g = vUv - 0.5;
      float vig = 1.0 - dot(g, g) * 0.32;
      col *= vig;

      gl_FragColor = vec4(col, src.a);
    }
  `,
}

export class AnimeFx {
  readonly composer: EffectComposer
  private pass: ShaderPass
  private bloom: UnrealBloomPass
  private scene: THREE.Scene
  private rt: THREE.WebGLRenderTarget
  private camera: THREE.PerspectiveCamera
  /** 0 = off, 1 = subtle, 2 = strong. */
  strength = 1

  constructor(
    private renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    overlay: THREE.Scene,
    water: GhibliWater,
  ) {
    this.scene = scene
    this.camera = camera

    const rt = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthTexture: new THREE.DepthTexture(1, 1),
      depthBuffer: true,
    })
    rt.texture.minFilter = THREE.LinearFilter
    rt.texture.magFilter = THREE.LinearFilter
    this.rt = rt
    this.composer = new EffectComposer(renderer, rt)
    // Sizes passed to setSize() already include the device pixel ratio.
    this.composer.setPixelRatio(1)
    // renderTarget2 is a clone of rt and would share its depth texture's GPU
    // source — a feedback loop when the grade reads depth while writing rt2.
    // Only full-screen passes ever draw into rt2, so it needs no depth texture.
    this.composer.renderTarget2.depthTexture = null
    this.composer.addPass(new RenderPass(scene, camera))
    this.composer.addPass(new WaterPass(overlay, camera, water))
    // Soft, wide, low-threshold bloom on the raw HDR render: the bright half
    // of the scene (sky, sunlit leaves, water) gets a gentle halation glow —
    // the "dreamy" softness — rather than only the sun disc blooming.
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.38, 0.85, 0.78)
    // One NaN/Inf pixel anywhere (a degenerate normal, a 0/0 in some
    // shader) would otherwise be blurred by bloom across the whole frame —
    // a black screen. Zero them at the bloom's input.
    this.bloom.materialHighPassFilter.fragmentShader = this.bloom.materialHighPassFilter.fragmentShader.replace(
      'vec4 texel = texture2D( tDiffuse, vUv );',
      'vec4 texel = texture2D( tDiffuse, vUv );\n\t\t\tif (any(isnan(texel)) || any(isinf(texel))) texel = vec4(0.0);',
    )
    this.composer.addPass(this.bloom)
    this.pass = new ShaderPass(AnimeShader)
    const noise = new THREE.TextureLoader().load(`${import.meta.env.BASE_URL}perlinnoise.webp`)
    noise.wrapS = noise.wrapT = THREE.RepeatWrapping
    ;(this.pass.uniforms as Record<string, { value: unknown }>).tNoise.value = noise
    this.pass.renderToScreen = false // OutputPass finalises tone-mapping
    this.composer.addPass(this.pass)
    // Depth for outlines / ground haze / cloud shadows: the main render's depth.
    ;(this.pass.uniforms as Record<string, { value: unknown }>).tDepth.value = rt.depthTexture
    this.composer.addPass(new OutputPass())
    this.setSize(1, 1, 1)
  }

  setSize(w: number, h: number, pixelRatio: number): void {
    const pw = Math.max(2, Math.floor(w * pixelRatio))
    const ph = Math.max(2, Math.floor(h * pixelRatio))
    this.composer.setSize(pw, ph)
    // Bloom's blur chain doesn't need full-res input — half-res halves its
    // fill-rate cost with no visible difference (it's a soft glow anyway).
    this.bloom.setSize(Math.max(2, pw >> 1), Math.max(2, ph >> 1))
    const u = this.pass.uniforms as typeof AnimeShader.uniforms & Record<string, { value: unknown }>
    u.resolution.value.set(pw, ph)
  }

  /** 0..1 cloud cover from the weather (more cover → more shadowed ground). */
  setCloudCover(c: number): void {
    ;(this.pass.uniforms as Record<string, { value: unknown }>).uCloudCover.value = c
  }

  render(dt: number, sunDir: THREE.Vector3, sunColor: THREE.Color, fogColor: THREE.Color): void {
    const u = this.pass.uniforms as typeof AnimeShader.uniforms & Record<string, { value: unknown }>
    ;(u.uStrength.value as number) = this.strength
    u.uTime.value += dt
    ;(u.uSunDir.value as THREE.Vector3).copy(sunDir)
    ;(u.uSunColor.value as THREE.Color).copy(sunColor)
    ;(u.uFogColor.value as THREE.Color).copy(fogColor)
    u.uNear.value = this.camera.near
    u.uFar.value = this.camera.far
    ;(u.uInvProj.value as THREE.Matrix4).copy(this.camera.projectionMatrixInverse)
    ;(u.uCamWorld.value as THREE.Matrix4).copy(this.camera.matrixWorld)
    ;(u.uCamPos.value as THREE.Vector3).setFromMatrixPosition(this.camera.matrixWorld)
    // Always through the composer (the water pass lives there); strength 0
    // just turns the grade/haze off in the shader.
    // The scene must render into rt (the target that owns the depth texture
    // the grade samples); re-anchor the ping-pong order every frame.
    if (this.composer.readBuffer !== this.rt) this.composer.swapBuffers()
    this.composer.render()
  }
}
