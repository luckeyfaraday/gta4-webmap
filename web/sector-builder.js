import * as THREE from 'three';
import { TextureArraySet, BundledArrays } from './texture-arrays.js';

// Rebuilds a loaded sector as a handful of BatchedMeshes instead of thousands of
// individually-drawn meshes. Everything sharing one texture array becomes one
// draw call, while BatchedMesh keeps per-object frustum culling and raycasting.

const CUTOUT = /decal|cutout|trees|fence|grate|railing/i;

// Sampling a sampler2DArray needs a per-vertex layer index. Wiring it through
// three's built-in map slot keeps lighting, fog and tone mapping intact; the
// 1x1 placeholder in `map` only exists so USE_MAP declares vMapUv for us.
const PLACEHOLDER = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
PLACEHOLDER.needsUpdate = true;

function makeMaterial(arrayTexture, cutout) {
  // Foliage/fences/decals are alpha-*tested*, not alpha-blended: keeping them
  // opaque with depth writes means no per-instance back-to-front sort is needed
  // and they depth-sort correctly against each other.
  const material = new THREE.MeshStandardMaterial({
    map: PLACEHOLDER, roughness: 0.88, metalness: 0,
    transparent: false, alphaTest: cutout ? 0.5 : 0, depthWrite: true,
    side: cutout ? THREE.DoubleSide : THREE.FrontSide,
  });
  material.onBeforeCompile = shader => {
    shader.uniforms.mapArray = { value: arrayTexture };
    shader.vertexShader = `attribute float layer;\nvarying float vLayer;\n${shader.vertexShader}`
      .replace('void main() {', 'void main() {\n\tvLayer = layer;');
    shader.fragmentShader = `precision highp sampler2DArray;\nuniform sampler2DArray mapArray;\nvarying float vLayer;\n${shader.fragmentShader}`
      .replace('#include <map_fragment>', `
        vec4 sampledDiffuseColor = texture( mapArray, vec3( vMapUv, vLayer ) );
        diffuseColor *= sampledDiffuseColor;
      `);
  };
  // Variants must not collide in the program cache with the stock material.
  material.customProgramCacheKey = () => `array:${cutout ? 'cutout' : 'opaque'}`;
  material.needsUpdate = true;
  return material;
}

// BatchedMesh demands one identical attribute layout across a batch.
function normalize(geometry, layer) {
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', geometry.getAttribute('position'));
  out.setAttribute('normal', geometry.getAttribute('normal') ?? computeNormals(geometry));
  const count = geometry.getAttribute('position').count;
  out.setAttribute('uv', geometry.getAttribute('uv') ?? new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  out.setAttribute('layer', new THREE.BufferAttribute(new Float32Array(count).fill(layer), 1));
  out.setIndex(geometry.getIndex() ?? implicitIndex(count));
  return out;
}

function computeNormals(geometry) {
  const clone = geometry.clone();
  clone.computeVertexNormals();
  return clone.getAttribute('normal');
}

function implicitIndex(count) {
  const array = count > 65535 ? new Uint32Array(count) : new Uint16Array(count);
  for (let i = 0; i < count; i++) array[i] = i;
  return new THREE.BufferAttribute(array, 1);
}

function textureId(material, sectorUrl) {
  const ref = material.userData?.texture;
  return ref ? new URL(ref, new URL(sectorUrl, location.href)).href : null;
}

// Collects every drawable as { geometry, layerKey, matrices } before any GPU
// work, so batch sizes are known up front.
function collectDraws(root, sectorUrl) {
  const draws = [];
  root.updateMatrixWorld(true);
  root.traverse(object => {
    if (!object.isMesh || !object.geometry) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    // Multi-material meshes would need per-group splitting; none exist in this
    // export, so route them through the first material rather than dropping them.
    const material = materials[0];
    if (!material) return;
    const matrices = [];
    if (object.isInstancedMesh) {
      const local = new THREE.Matrix4();
      for (let i = 0; i < object.count; i++) {
        object.getMatrixAt(i, local);
        matrices.push(new THREE.Matrix4().multiplyMatrices(object.matrixWorld, local));
      }
    } else {
      matrices.push(object.matrixWorld.clone());
    }
    draws.push({ geometry: object.geometry, material, matrices, url: textureId(material, sectorUrl) });
  });
  return draws;
}

export async function buildSector({ root, sectorUrl, loadDDS, bundle, maxEdge = 256, anisotropy = 8, perObjectCull = false, onProgress }) {
  const draws = collectDraws(root, sectorUrl);
  const urls = [...new Set(draws.map(d => d.url).filter(Boolean))];

  // 1. Get this sector's textures as GPU arrays. A prebuilt bundle is one fetch
  // of exactly the mips we upload; the per-file path is the fallback when
  // tools/pack-textures.mjs has not been run.
  let arrays;
  const placement = new Map(); // url -> { key, layer }
  if (bundle) {
    arrays = new BundledArrays(bundle.manifest, bundle.binary, anisotropy);
    for (const url of urls) {
      const spot = arrays.locate(decodeURIComponent(url.split('/').pop()));
      if (spot) placement.set(url, spot);
    }
    onProgress?.(urls.length, urls.length);
  } else {
    arrays = new TextureArraySet(maxEdge);
    let done = 0;
    const queue = urls.slice();
    await Promise.all(Array.from({ length: 16 }, async () => {
      while (queue.length) {
        const url = queue.shift();
        try {
          const texture = await loadDDS(url);
          if (texture?.mipmaps?.length) placement.set(url, arrays.add(url, texture));
        } catch (error) { console.warn('texture failed', url, error); }
        onProgress?.(++done, urls.length);
      }
    }));
    arrays.build(anisotropy);
  }

  // 2. Group draws by the array they landed in, splitting opaque from cutout.
  const groups = new Map();
  for (const draw of draws) {
    const spot = draw.url ? placement.get(draw.url) : null;
    if (!spot) continue; // untextured or failed; nothing sensible to batch it with
    const cutout = CUTOUT.test(draw.material.userData?.shader ?? '');
    const key = `${spot.key}|${cutout ? 'cutout' : 'opaque'}`;
    let group = groups.get(key);
    if (!group) {
      group = { arrayKey: spot.key, cutout, entries: new Map(), instances: 0, vertices: 0, indices: 0 };
      groups.set(key, group);
    }
    // Same geometry + same layer can share one batch geometry and differ only
    // by instance matrix.
    const entryKey = `${draw.geometry.uuid}|${spot.layer}`;
    let entry = group.entries.get(entryKey);
    if (!entry) {
      entry = { geometry: draw.geometry, layer: spot.layer, matrices: [] };
      group.entries.set(entryKey, entry);
      const position = draw.geometry.getAttribute('position');
      group.vertices += position.count;
      group.indices += draw.geometry.getIndex()?.count ?? position.count;
    }
    entry.matrices.push(...draw.matrices);
    group.instances += draw.matrices.length;
  }

  // 3. Build one BatchedMesh per group.
  const container = new THREE.Group();
  container.name = 'batched';
  const materials = [];
  for (const group of groups.values()) {
    const material = makeMaterial(arrays.get(group.arrayKey), group.cutout);
    materials.push(material);
    const batch = new THREE.BatchedMesh(group.instances, group.vertices, group.indices, material);
    // Each batch already covers a single sector, so the Object3D-level frustum
    // check culls whole off-screen sectors. Per-instance culling on top of that
    // measured ~4ms/frame of CPU while removing ~0.03% of triangles, because a
    // texture bucket's geometry is scattered across the whole sector.
    batch.perObjectFrustumCulled = perObjectCull;
    batch.sortObjects = false;
    for (const entry of group.entries.values()) {
      const geometry = normalize(entry.geometry, entry.layer);
      const geometryId = batch.addGeometry(geometry);
      for (const matrix of entry.matrices) batch.setMatrixAt(batch.addInstance(geometryId), matrix);
      geometry.dispose();
    }
    batch.computeBoundingSphere();
    container.add(batch);
  }

  return {
    container,
    arrays,
    stats: { batches: groups.size, instances: draws.reduce((a, d) => a + d.matrices.length, 0), ...arrays.stats() },
    dispose() {
      for (const batch of container.children) batch.dispose();
      for (const material of materials) material.dispose();
      container.clear();
      arrays.dispose();
    },
  };
}
