import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DDSLoader } from 'three/addons/loaders/DDSLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

// Loads the ambient peds. The one structural thing to know: all 345 share the
// standard 80-bone skeleton, and the exporter names every ped's bone nodes
// canonically by BoneID, so the clip library is fetched ONCE and played on any
// of them. Do not load clips per ped — 112 clips is about 2 MB, and multiplying
// that by the population is the whole budget.

const ddsLoader = new DDSLoader();
const textureCache = new Map();
const gltfCache = new Map();
let clipLibrary = null;

function loader() {
  return new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
}

function loadTexture(href, renderer) {
  if (!textureCache.has(href)) {
    textureCache.set(href, ddsLoader.loadAsync(href).then(texture => {
      texture.flipY = false;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      return texture;
    }));
  }
  return textureCache.get(href);
}

export async function loadCatalogue(url = './assets/peds/peds.json') {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`peds.json: ${response.status}`);
  return response.json();
}

// The shared clip library, fetched once for the whole population.
export async function loadClips(url = './assets/peds/animations.glb') {
  if (!clipLibrary) clipLibrary = loader().loadAsync(url).then(gltf => gltf.animations);
  return clipLibrary;
}

export async function loadPed(url, renderer, options = {}) {
  if (!gltfCache.has(url)) gltfCache.set(url, loader().loadAsync(url));
  const gltf = await gltfCache.get(url);
  // SkeletonUtils.clone, not Object3D.clone — a plain clone of a skinned mesh
  // keeps the original skeleton, so every ped of a model would share one pose.
  const root = options.clone ? cloneSkinned(gltf.scene) : gltf.scene;
  const base = new URL(url, location.href);

  let vertices = 0;
  let untextured = 0;
  const materials = new Set();
  root.traverse(object => {
    if (!object.isMesh && !object.isSkinnedMesh) return;
    vertices += object.geometry.attributes.position?.count ?? 0;
    // A ped is small and usually on screen, and its bounding sphere is the bind
    // pose rather than the animated one.
    object.frustumCulled = false;
    for (const material of [object.material].flat()) materials.add(material);
  });

  await Promise.all([...materials].map(async material => {
    material.metalness = 0;
    material.roughness = 0.85;
    const source = material.userData?.texture;
    if (!source) { untextured++; return; }
    try {
      material.map = await loadTexture(new URL(source, base).href, renderer);
      material.color.set(0xffffff);
      material.needsUpdate = true;
    } catch (error) {
      untextured++;
      console.warn('Ped texture failed', source, error);
    }
  }));

  let bones = 0;
  root.traverse(object => { if (object.isSkinnedMesh) bones = Math.max(bones, object.skeleton.bones.length); });

  return {
    root,
    meta: gltf.userData ?? {},
    bones,
    vertices,
    untextured,
    probeBone: root.getObjectByName('Char_R_Hand') ?? root.getObjectByName('Char_R_Foot'),

    // The exact lowest point the ped reaches, for checking it stands on the
    // ground rather than floating or sinking.
    //
    // Box3 is not usable for this. A ped is entirely skinned, and once the
    // skeleton is properly bound (SkeletonUtils.clone) three.js accounts for
    // bone transforms when computing a SkinnedMesh's bounding box AND applies
    // the mesh's world matrix on top — so the exporter's root lift is counted
    // twice and every ped reads exactly one foot-offset too high. Pushing
    // vertices through applyBoneTransform is the honest measurement.
    lowestVertexY() {
      root.updateWorldMatrix(true, true);
      const point = new THREE.Vector3();
      let lowest = Infinity;
      root.traverse(object => {
        if (!object.isMesh && !object.isSkinnedMesh) return;
        const position = object.geometry.attributes.position;
        for (let i = 0; i < position.count; i++) {
          point.fromBufferAttribute(position, i);
          if (object.isSkinnedMesh) object.applyBoneTransform(i, point);
          point.applyMatrix4(object.matrixWorld);
          if (point.y < lowest) lowest = point.y;
        }
      });
      return lowest;
    },
  };
}
