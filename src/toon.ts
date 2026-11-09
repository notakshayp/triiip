import * as THREE from 'three'

// Shared 3-step toon gradient (used by the character, terrain, and every
// scattered prop) so the whole world cel-shades consistently — this is what
// actually reads as "painterly" rather than a photo-textured PBR scene.

let _gradientMap: THREE.Texture | null = null
export function toonGradient(): THREE.Texture {
  if (_gradientMap) return _gradientMap
  // Smooth ramp (linear-filtered) with a soft shoulder — light rolls across
  // surfaces like a painted wash instead of snapping between 3 hard bands.
  const data = new Uint8Array([112, 150, 196, 232, 255])
  const tex = new THREE.DataTexture(data, 5, 1, THREE.RedFormat)
  tex.magFilter = THREE.LinearFilter
  tex.minFilter = THREE.LinearFilter
  tex.needsUpdate = true
  _gradientMap = tex
  return tex
}

/**
 * Cel-shaded material with a fresnel rim light baked into onBeforeCompile —
 * the glowing edge-light silhouette is a load-bearing part of the "anime
 * game" look (every surface gets a soft sky-coloured kiss of light at
 * grazing angles, same trick stylised renderers use for readability + shine).
 */
// ---------------------------------------------------------------------------
// Bendable small props (flowers, bushes) — same "world reacts to you" trick
// as FluffyGrass: push vertices away from the player horizontally, weighted
// by height-above-base so the top sways and the root stays planted. Shares
// one uPlayerPos uniform object across every instance (ChunkManager updates
// it once per frame) instead of per-material uniforms.
// ---------------------------------------------------------------------------
const _bendyPlayerPos = new THREE.Vector3(1e4, 0, 1e4)
const _bendyUniform = { value: _bendyPlayerPos }
/** Shared live player position uniform — foliage + far-LOD shaders reference the same object. */
export const playerPosUniform = _bendyUniform

// ---------------------------------------------------------------------------
// Contact trail — physical plant interaction. Slot 0 is where you stand now;
// slots 1.. are footprints stamped every ~0.6 m along your path, each aging.
// Shaders bend plants only within body radius of these points, flattening
// immediately and springing back over ~1.5 s with a slight overshoot — a
// path through the grass, not a force field around you.
// ---------------------------------------------------------------------------
export const TRAIL_N = 12
const _trail = Array.from({ length: TRAIL_N }, () => new THREE.Vector4(1e5, 1e5, 99, 0))
export const trailUniform = { value: _trail }
let _trailHead = 0
const _lastStamp = new THREE.Vector2(1e9, 1e9)

/** Once per frame. `airborne` lifts the live contact (jumping clears the grass). */
export function updateTrail(pos: THREE.Vector3, dt: number, airborne: boolean): void {
  for (let i = 1; i < TRAIL_N; i++) _trail[i].z += dt
  _trail[0].set(pos.x, pos.z, airborne ? 99 : 0, 0)
  if (!airborne && Math.hypot(pos.x - _lastStamp.x, pos.z - _lastStamp.y) > 0.6) {
    _trail[1 + (_trailHead++ % (TRAIL_N - 1))].set(pos.x, pos.z, 0, 0)
    _lastStamp.set(pos.x, pos.z)
  }
}

/**
 * GLSL: `vec2 trailPush(vec2 worldXZ, float radius)` — signed lean vector
 * (length ≤ 1) for a point near the player's recent path.
 */
export const TRAIL_GLSL = /* glsl */ `
#define TRAIL_N ${TRAIL_N}
uniform vec4 uTrail[TRAIL_N];
vec2 trailPush(vec2 p, float r) {
  vec2 acc = vec2(0.0);
  if (distance(p, uTrail[0].xy) > 9.0) return acc; // whole trail lives near you
  for (int i = 0; i < TRAIL_N; i++) {
    vec4 t = uTrail[i];
    if (t.z > 2.5) continue;
    vec2 d = p - t.xy;
    float dist = length(d);
    float contact = 1.0 - smoothstep(r * 0.35, r, dist);
    float spring = exp(-t.z * 2.2) * cos(t.z * 2.8); // flatten, recover, slight overshoot
    acc += (d / max(dist, 0.001)) * contact * spring;
  }
  float L = length(acc);
  return L > 1.0 ? acc / L : acc;
}
`
export function setBendyPlayer(pos: THREE.Vector3): void {
  _bendyPlayerPos.copy(pos)
}

const _bendyMatCache = new Map<string, THREE.MeshLambertMaterial>()

/**
 * vertexColors Lambert material for instanced plants (flowers) that lean
 * over where the player's body actually passes (contact trail), then spring
 * back. `contactR` = body contact radius, `maxLean` = max lean in radians.
 */
export function bendyMat(modelHeight: number, contactR = 0.6, maxLean = 1.0, map?: THREE.Texture): THREE.MeshLambertMaterial {
  const key = `${Math.round(modelHeight * 1000)}|${contactR}|${maxLean}|${map?.uuid ?? ''}`
  const cached = _bendyMatCache.get(key)
  if (cached) return cached
  // With a map: alpha-cut painted cards (petals/leaves), lit from both sides.
  const mat = map
    ? new THREE.MeshLambertMaterial({ vertexColors: true, map, alphaTest: 0.45, side: THREE.DoubleSide })
    : new THREE.MeshLambertMaterial({ vertexColors: true })
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTrail = trailUniform
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${TRAIL_GLSL}`)
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        #ifdef USE_INSTANCING
        {
          // Lean the whole stem about its base (rotate, don't stretch).
          vec4 wp = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
          vec4 base = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          vec2 push = trailPush(base.xz, ${contactR.toFixed(2)});
          float L = length(push);
          if (L > 0.001) {
            float ang = L * ${maxLean.toFixed(2)};
            float hb = max(wp.y - base.y, 0.0);
            vec2 dir = push / L;
            vec3 offW = vec3(dir.x * sin(ang) * hb, -(1.0 - cos(ang)) * hb, dir.y * sin(ang) * hb);
            transformed += inverse(mat3(modelMatrix) * mat3(instanceMatrix)) * offW;
          }
        }
        #endif`,
      )
  }
  _bendyMatCache.set(key, mat)
  return mat
}

// ---------------------------------------------------------------------------
// Painted surfaces. Vertex colours on a 2 m grid give smooth CG gradients;
// a painted background has washes and dabs. `paint` > 0 layers world-space
// variation over the base colour: broad washes (tens of metres), crisp-edged
// dabs, and streaky brush direction — lighter dabs drift warm, darker ones
// cool. Projected on the dominant axis so cliffs and trunks get strokes too.
// `grassMatch` also pulls green ground toward the same golden/olive patches
// the grass blades use, so blades and the ground under them are one field.
// ---------------------------------------------------------------------------
let _paintTex: THREE.Texture | null = null
function paintTex(): THREE.Texture {
  if (_paintTex) return _paintTex
  _paintTex = new THREE.TextureLoader().load(`${import.meta.env.BASE_URL}perlinnoise.webp`)
  _paintTex.wrapS = _paintTex.wrapT = THREE.RepeatWrapping
  return _paintTex
}

export function toonMat(
  opts: THREE.MeshToonMaterialParameters = {},
  rimColor = 0xcfe8ff,
  rimStrength = 0.2,
  paint = 0,
  grassMatch = false,
): THREE.MeshToonMaterial {
  const mat = new THREE.MeshToonMaterial({ gradientMap: toonGradient(), ...opts })
  const rim = { color: { value: new THREE.Color(rimColor) }, strength: { value: rimStrength } }
  if (paint > 0) mat.customProgramCacheKey = () => `paint${paint}${grassMatch}`
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uRimColor = rim.color
    shader.uniforms.uRimStrength = rim.strength
    if (paint > 0) {
      shader.uniforms.tPaint = { value: paintTex() }
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vPaintP;\nvarying vec3 vPaintN;')
        .replace(
          '#include <worldpos_vertex>',
          `#include <worldpos_vertex>
          {
            vec4 pw = vec4(transformed, 1.0);
            #ifdef USE_INSTANCING
              pw = instanceMatrix * pw;
            #endif
            vPaintP = (modelMatrix * pw).xyz;
            vPaintN = normalize(mat3(modelMatrix) * objectNormal);
          }`,
        )
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D tPaint;\nvarying vec3 vPaintP;\nvarying vec3 vPaintN;')
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          {
            vec3 an = abs(vPaintN);
            vec2 pp = an.y > 0.65 ? vPaintP.xz : (an.x > an.z ? vPaintP.zy : vPaintP.xy);
            float wash = smoothstep(0.3, 0.7, texture2D(tPaint, pp * 0.021).r);
            float dab = smoothstep(0.47, 0.53, texture2D(tPaint, pp * 0.075 + 0.37).g);
            float stroke = smoothstep(0.3, 0.7, texture2D(tPaint, vec2(pp.x * 0.3 + pp.y * 0.11, pp.y * 0.07 - pp.x * 0.04)).b);
            float v = ((wash - 0.5) * 0.36 + (dab - 0.5) * 0.14 + (stroke - 0.5) * 0.16) * ${paint.toFixed(2)};
            float lum = dot(diffuseColor.rgb, vec3(0.333));
            diffuseColor.rgb *= 1.0 + v;
            diffuseColor.rgb += vec3(0.05, 0.02, -0.05) * v * lum;
            ${
              grassMatch
                ? `// Green ground follows the grass blades' dry/olive patches.
            float green = smoothstep(0.02, 0.1, diffuseColor.g - max(diffuseColor.r, diffuseColor.b));
            float patchA = texture2D(tPaint, vPaintP.xz * 0.0035).g;
            float patchB = texture2D(tPaint, vPaintP.xz * 0.009 + 0.37).b;
            vec3 dry = diffuseColor.rgb * vec3(1.55, 1.08, 0.75);
            vec3 olive = diffuseColor.rgb * vec3(1.2, 1.0, 0.85);
            diffuseColor.rgb = mix(diffuseColor.rgb, dry, smoothstep(0.55, 0.8, patchA) * green * 0.8);
            diffuseColor.rgb = mix(diffuseColor.rgb, olive, smoothstep(0.6, 0.85, patchB) * green * 0.5);`
                : ''
            }
          }`,
        )
    }
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uRimColor;\nuniform float uRimStrength;')
      .replace(
        '#include <opaque_fragment>',
        `${
          paint > 0
            ? `{
          // Painted shade: the side away from the sun (and cast shadow) goes
          // cool blue-violet, the way background painters mix shadows.
          float lit = dot(reflectedLight.directDiffuse, vec3(1.0)) / max(dot(diffuseColor.rgb, vec3(1.0)), 1e-3);
          float shade = 1.0 - smoothstep(0.15, 1.1, lit);
          outgoingLight *= mix(vec3(1.0), vec3(0.86, 0.92, 1.2), shade);
        }`
            : ''
        }
        {
          vec3 rimViewDir = normalize(vViewPosition);
          float rimFresnel = pow(1.0 - clamp(dot(normalize(normal), rimViewDir), 0.0, 1.0), 2.6);
          outgoingLight += uRimColor * rimFresnel * uRimStrength;
        }
        #include <opaque_fragment>`,
      )
  }
  return mat
}
