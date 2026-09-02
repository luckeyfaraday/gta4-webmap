import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DDSLoader } from 'three/addons/loaders/DDSLoader.js';

// Loads the exported character and resolves its DDS textures, which the
// extractor references from each material's extras rather than embedding.
// Shared by the standalone preview (player.html) and the map viewer (app.js).
export async function loadPlayer(url, renderer) {
  const gltf = await new GLTFLoader().loadAsync(url);
  const root = gltf.scene;
  const ddsLoader = new DDSLoader();
  const textureLoader = new THREE.TextureLoader();
  const cache = new Map();
  const base = new URL(url, location.href);

  let vertices = 0;
  let untextured = 0;
  const materials = new Set();
  root.traverse(object => {
    if (!object.isMesh && !object.isSkinnedMesh) return;
    vertices += object.geometry.attributes.position?.count ?? 0;
    // The character is one small object that is almost always on screen, and
    // its bounding sphere is the bind pose rather than the animated one.
    object.frustumCulled = false;
    for (const material of [object.material].flat()) materials.add(material);
  });

  await Promise.all([...materials].map(async material => {
    const source = material.userData?.texture;
    material.metalness = 0;
    material.roughness = 0.78;
    if (!source) { untextured++; return; }
    const href = new URL(source, base).href;
    if (!cache.has(href)) {
      const loader = href.toLowerCase().endsWith('.dds') ? ddsLoader : textureLoader;
      cache.set(href, loader.loadAsync(href).then(texture => {
        texture.flipY = false;
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
        return texture;
      }));
    }
    try {
      material.map = await cache.get(href);
      material.color.set(0xffffff);
      material.needsUpdate = true;
    } catch (error) {
      untextured++;
      console.warn('Player texture failed', href, error);
    }
  }));

  let bones = 0;
  root.traverse(object => { if (object.isSkinnedMesh) bones = Math.max(bones, object.skeleton.bones.length); });

  return {
    root,
    clips: gltf.animations,
    meta: gltf.userData ?? {},
    bones,
    vertices,
    untextured,
    probeBone: root.getObjectByName('Char_R_Hand'),
  };
}
