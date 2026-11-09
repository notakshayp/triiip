import * as THREE from 'three'

// ---------------------------------------------------------------------------
// Shell fur. A furry mesh is drawn once as its normal opaque self, then again
// as an InstancedMesh of N shells, each pushed a little further out along the
// normals (instance i = shell i, one draw call per part). The fragment shader
// carves strands out of every shell from 3D cell noise — strands thin toward
// their tips and die at a per-strand length, grouped into soft clumps — so
// the shells read as a soft, fluffy coat with a fuzzy silhouette.
//   • wavy  — the strand lookup drifts with height, so strands curl
//   • droop — tips sag with gravity
//   • alive — tips sway with a breeze and stream back against the motion
// Lambert lighting (soft, no cel bands) with root occlusion and a light
// sheen at grazing angles.
// ---------------------------------------------------------------------------

export const SHELLS = 18

const uniforms = {
  uFurTime: { value: 0 },
  uFurVel: { value: new THREE.Vector3() },
}

const cache = new Map<string, THREE.MeshLambertMaterial>()

/**
 * Fur material: shared by the base mesh (layer 0, solid) and its shells.
 * `len` is fur length in the mesh's local units, `density` strands per unit.
 */
export function furMat(color: number, len: number, density = 260): THREE.MeshLambertMaterial {
  const key = `${color}|${len}|${density}`
  const hit = cache.get(key)
  if (hit) return hit
  const m = new THREE.MeshLambertMaterial({ color })
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, { uLen: { value: len }, uDensity: { value: density } })
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uFurTime;
        uniform vec3 uFurVel;
        uniform float uLen;
        varying vec3 vFurP;
        varying float vLayer;
        vec3 furWP;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vFurP = position;
        vLayer = 0.0;
        #ifdef USE_INSTANCING
          vLayer = float(gl_InstanceID + 1) / ${SHELLS}.0;
          transformed += normal * uLen * vLayer;
          // Tip motion in world space: gravity droop, breeze, motion drag.
          vec4 wp = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
          float l2 = vLayer * vLayer;
          float worldLen = uLen * length(modelMatrix[0].xyz);
          vec3 breeze = vec3(sin(uFurTime * 2.3 + wp.x * 9.0 + wp.y * 7.0), 0.0, cos(uFurTime * 1.9 + wp.z * 8.0)) * 0.25;
          wp.xyz += (vec3(0.0, -0.55, 0.0) + breeze - uFurVel * 0.09) * worldLen * l2;
          furWP = wp.xyz; // projected directly (no per-vertex matrix inverse)
        #endif`,
      )
      .replace(
        '#include <project_vertex>',
        `#ifdef USE_INSTANCING
          vec4 mvPosition = viewMatrix * vec4(furWP, 1.0);
          gl_Position = projectionMatrix * mvPosition;
        #else
          #include <project_vertex>
        #endif`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        #if defined( USE_INSTANCING ) && ( defined( USE_SHADOWMAP ) || NUM_SPOT_LIGHT_COORDS > 0 )
          worldPosition = vec4(furWP, 1.0);
        #endif`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uDensity;
        varying vec3 vFurP;
        varying float vLayer;
        float furHash(vec3 p) {
          p = fract(p * 0.3183099 + 0.1);
          p *= 17.0;
          return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
        }
        float furNoise(vec3 p) {
          vec3 i = floor(p);
          vec3 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(mix(furHash(i), furHash(i + vec3(1, 0, 0)), f.x), mix(furHash(i + vec3(0, 1, 0)), furHash(i + vec3(1, 1, 0)), f.x), f.y),
                     mix(mix(furHash(i + vec3(0, 0, 1)), furHash(i + vec3(1, 0, 1)), f.x), mix(furHash(i + vec3(0, 1, 1)), furHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
        }`,
      )
      .replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `vec4 diffuseColor = vec4( diffuse, opacity );
        float furAO = 1.0;
        if (vLayer > 0.0) {
          // Clumps: soft tufts of similar length that curl together.
          float clump = furNoise(vFurP * uDensity * 0.12);
          vec3 q = vFurP * uDensity;
          q += vec3(sin(vLayer * 4.0 + clump * 6.28), cos(vLayer * 3.0 + clump * 6.28), sin(vLayer * 3.5)) * vLayer * 0.9; // wavy
          vec3 cell = floor(q);
          float h = furHash(cell);
          float strandLen = mix(0.6, 1.0, h) * mix(0.6, 1.0, clump);
          float t = vLayer / strandLen;
          float d = length(fract(q) - 0.5);
          if (t > 1.0 || d > 0.7 * (1.0 - t * 0.8)) discard;
        }
        furAO = mix(0.8, 1.06, vLayer);
        diffuseColor.rgb *= furAO;`,
      )
      .replace(
        '#include <opaque_fragment>',
        `{
          // Soft sheen where fur turns away from the view (fluffy halo).
          float graze = 1.0 - abs(dot(normalize(normal), normalize(vViewPosition)));
          outgoingLight += diffuseColor.rgb * pow(graze, 3.0) * 0.35;
          // Light scattering through the coat: fur never goes cold-grey in shade.
          outgoingLight += diffuseColor.rgb * vec3(0.2, 0.15, 0.1);
        }
        #include <opaque_fragment>`,
      )
  }
  cache.set(key, m)
  return m
}

/** Give a mesh (using a furMat) its fur shells. */
export function addShells(mesh: THREE.Mesh, shells = SHELLS): THREE.InstancedMesh {
  const inst = new THREE.InstancedMesh(mesh.geometry, mesh.material, shells)
  // Identity instance matrices: the shell offset is done in the shader.
  inst.castShadow = false
  inst.receiveShadow = true
  inst.frustumCulled = false
  inst.renderOrder = 1
  mesh.add(inst)
  return inst
}

export function updateFur(time: number, vel: THREE.Vector3): void {
  uniforms.uFurTime.value = time
  uniforms.uFurVel.value.lerp(vel, 0.2)
}
