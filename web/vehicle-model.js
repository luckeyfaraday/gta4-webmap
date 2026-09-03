import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DDSLoader } from 'three/addons/loaders/DDSLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

// Loads one exported vehicle and resolves its DDS textures the same way
// player-model.js does — the extractor references them from each material's
// extras rather than embedding them, so the whole fleet shares one cache.
//
// Two things are vehicle-specific. The bodywork colour is not in the texture:
// gta_vehicle_paint* materials sample a spec map and take their colour per
// instance from the model's carcols sets, so those materials are cloned per
// vehicle and tinted. And the wheel and door bones are the articulation, so
// they are handed back by name for the viewer to drive.

const ddsLoader = new DDSLoader();
const textureLoader = new THREE.TextureLoader();
const textureCache = new Map();
const gltfCache = new Map();

function loadTexture(href, renderer) {
  if (!textureCache.has(href)) {
    const loader = href.toLowerCase().endsWith('.dds') ? ddsLoader : textureLoader;
    textureCache.set(href, loader.loadAsync(href).then(texture => {
      texture.flipY = false;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      return texture;
    }));
  }
  return textureCache.get(href);
}

// One fetch and parse per model, however many cars of it end up on the street.
function loadGltf(url) {
  if (!gltfCache.has(url)) {
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    gltfCache.set(url, loader.loadAsync(url));
  }
  return gltfCache.get(url);
}

export async function loadVehicle(url, renderer, options = {}) {
  const gltf = await loadGltf(url);
  // SkeletonUtils.clone, not Object3D.clone: a vehicle body is a skinned mesh,
  // and a plain clone keeps pointing at the ORIGINAL skeleton, so every car of
  // a model would deform with the first one's bones — open one car's door and
  // the whole fleet opens theirs. SkeletonUtils rebinds each clone to its own
  // copy of the bone hierarchy.
  const root = options.clone ? cloneSkinned(gltf.scene) : gltf.scene;
  const base = new URL(url, location.href);

  let vertices = 0;
  let untextured = 0;
  const paintMaterials = [];
  const materials = new Set();

  // Cloning the scene shares its materials, and paint is per instance: without
  // this, respraying one car repaints every car of that model on the street.
  // Textures stay shared — only the material objects are copied.
  const materialCopies = new Map();
  const instanceMaterial = material => {
    if (!options.clone) return material;
    let copy = materialCopies.get(material);
    if (!copy) materialCopies.set(material, copy = material.clone());
    return copy;
  };

  root.traverse(object => {
    if (!object.isMesh && !object.isSkinnedMesh) return;
    vertices += object.geometry.attributes.position?.count ?? 0;
    // A car is small, usually on screen, and its bounding sphere is the bind
    // pose rather than the articulated one.
    object.frustumCulled = false;
    object.material = Array.isArray(object.material)
      ? object.material.map(instanceMaterial)
      : instanceMaterial(object.material);
    for (const material of [object.material].flat()) materials.add(material);
  });

  await Promise.all([...materials].map(async material => {
    material.metalness = 0;
    material.roughness = material.userData?.shader?.includes('paint') ? 0.35 : 0.78;
    if (material.userData?.paint) paintMaterials.push(material);
    const source = material.userData?.texture;
    if (!source) { untextured++; return; }
    try {
      material.map = await loadTexture(new URL(source, base).href, renderer);
      material.color.set(0xffffff);
      material.needsUpdate = true;
    } catch (error) {
      untextured++;
      console.warn('Vehicle texture failed', source, error);
    }
  }));

  const wheels = [];
  const doors = [];
  root.traverse(object => {
    if (/^wheel_(lf|rf|lr|rr|lm|rm)$/i.test(object.name)) wheels.push(object);
    else if (/^door_/i.test(object.name)) doors.push(object);
  });

  let bones = 0;
  root.traverse(object => { if (object.isSkinnedMesh) bones = Math.max(bones, object.skeleton.bones.length); });

  const model = {
    root,
    meta: gltf.userData ?? {},
    bones,
    vertices,
    untextured,
    wheels,
    doors,
    paintMaterials,

    // Colour a spawned car. carcols gives indices into the shared palette; the
    // first index is the body colour, which is the one the paint materials take.
    paint(rgb) {
      const colour = new THREE.Color().setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
      for (const material of paintMaterials) {
        material.color.copy(colour);
        material.needsUpdate = true;
      }
    },

    // Wheels are joints of the body skin, so spinning them is a bone rotation.
    spin(radians) {
      for (const wheel of wheels) wheel.rotation.x = radians;
    },

    // The exact lowest point the vehicle actually reaches. Neither obvious
    // instrument works on its own here:
    //
    //  - Box3 transforms each geometry's AABB, and a wheel node is rotated (by
    //    the spin, and on a bike by the fork rake as well), so its box inflates
    //    below the tyre. A 0.33 m disc turned 45 degrees claims to reach 0.14 m
    //    under the road while every vertex of it is above the road.
    //  - Reading geometry.position and applying matrixWorld is exact for the
    //    rigid wheel meshes but wrong for the body, which is skinned: that
    //    attribute holds bind-pose vertices and the bones are what place them.
    //
    // So: park the wheels, push skinned vertices through their bones with
    // applyBoneTransform, and take the true minimum.
    lowestVertexY() {
      const spun = wheels.map(wheel => wheel.rotation.x);
      for (const wheel of wheels) wheel.rotation.x = 0;
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

      wheels.forEach((wheel, index) => { wheel.rotation.x = spun[index]; });
      root.updateWorldMatrix(true, true);
      return lowest;
    },

    openDoor(name, radians) {
      const door = doors.find(item => item.name.toLowerCase() === name.toLowerCase());
      if (door) door.rotation.y = radians;
      return !!door;
    },
  };
  return model;
}

// The catalogue the extractor writes beside the models.
export async function loadCatalogue(url = './assets/vehicles/vehicles.json') {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`vehicles.json: ${response.status}`);
  return response.json();
}
