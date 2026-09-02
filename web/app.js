import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DDSLoader } from 'three/addons/loaders/DDSLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const ui = {
  loading: document.querySelector('#loading'), status: document.querySelector('#status'), bar: document.querySelector('#bar'),
  mode: document.querySelector('#mode'), sectors: document.querySelector('#sectors'), placements: document.querySelector('#placements'),
  models: document.querySelector('#models'), textures: document.querySelector('#textures'), sectorSelect: document.querySelector('#sector-select'),
  buttons: [...document.querySelectorAll('[data-mode]')], crosshair: document.querySelector('#crosshair'),
};

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8497a3);
scene.fog = new THREE.FogExp2(0x8497a3, 0.00042);
scene.add(new THREE.HemisphereLight(0xcce1eb, 0x283237, 1.7));
const sun = new THREE.DirectionalLight(0xffe0bd, 2.2);
sun.position.set(-450, 700, 260);
scene.add(sun);

const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.15, 7000);
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;
orbit.maxDistance = 3800;
const pointer = new PointerLockControls(camera, renderer.domElement);

const gltfLoader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const ddsLoader = new DDSLoader();
const textureLoader = new THREE.TextureLoader();
const world = await fetch('./assets/world.json').then(response => {
  if (!response.ok) throw new Error('Full world data is not built yet. Run npm run extract:world.');
  return response.json();
});

const loaded = new Map();
const loading = new Map();
const textureCache = new Map();
const keys = new Set();
const timer = new THREE.Timer();
const down = new THREE.Vector3(0, -1, 0);
const raycaster = new THREE.Raycaster();
let mode = 'overview';
let verticalVelocity = 0;
let groundTimer = 0;
let fallTimer = 0;
let streamTimer = 0;
let initialized = false;

for (const sector of world.sectors) {
  const option = document.createElement('option');
  option.value = sector.id;
  option.textContent = `${sector.region.toUpperCase()} · ${sector.id}`;
  ui.sectorSelect.append(option);
}

function centerOf(sector) {
  const { min, max } = sector.bounds;
  return new THREE.Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
}

function distanceToSector(position, sector) {
  const { min, max } = sector.bounds;
  const dx = Math.max(min[0] - position.x, 0, position.x - max[0]);
  const dz = Math.max(min[2] - position.z, 0, position.z - max[2]);
  return Math.hypot(dx, dz);
}

async function loadTexture(url) {
  if (!textureCache.has(url)) {
    const sourceLoader = url.toLowerCase().endsWith('.dds') ? ddsLoader : textureLoader;
    textureCache.set(url, sourceLoader.loadAsync(url).then(texture => {
      texture.flipY = false;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      return texture;
    }));
  }
  return textureCache.get(url);
}

async function applyTextures(root, sectorUrl, sectorId) {
  const materials = new Map();
  root.traverse(object => {
    if (!object.isMesh) return;
    const list = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of list) materials.set(material.uuid, material);
  });
  const queue = [...materials.values()].filter(material => material.userData?.texture);
  let complete = 0;
  async function worker() {
    while (queue.length) {
      // Streaming can unload this sector while its textures are still being
      // fetched. Stop rather than downloading into disposed materials.
      if (sectorId !== undefined && !loaded.has(sectorId)) return;
      const material = queue.shift();
      const url = new URL(material.userData.texture, new URL(sectorUrl, location.href)).href;
      try {
        material.map = await loadTexture(url);
        material.color.set(0xffffff);
        material.roughness = 0.88;
        material.metalness = 0;
        if (/decal|cutout|trees/i.test(material.userData.shader ?? '')) {
          material.transparent = true;
          material.alphaTest = 0.08;
          material.depthWrite = false;
        }
        material.needsUpdate = true;
      } catch (error) { console.warn('Texture failed', url, error); }
      complete++;
      if (!initialized) {
        ui.bar.style.width = `${55 + Math.round(complete / Math.max(1, materials.size) * 45)}%`;
        ui.status.textContent = `Applying GTA textures · ${complete.toLocaleString()} / ${materials.size.toLocaleString()}`;
      }
    }
  }
  await Promise.all(Array.from({ length: 20 }, worker));
}

async function loadSector(sector) {
  if (loaded.has(sector.id)) return loaded.get(sector.id);
  if (loading.has(sector.id)) return loading.get(sector.id);
  const task = (async () => {
    if (!initialized) ui.status.textContent = `Loading ${sector.id} geometry…`;
    const gltf = await gltfLoader.loadAsync(sector.url, event => {
      if (!initialized && event.total) ui.bar.style.width = `${Math.round(event.loaded / event.total * 55)}%`;
    });
    gltf.scene.name = `sector:${sector.id}`;
    // Textures are applied asynchronously after the GLB arrives. Until that
    // finishes every material is still its untextured white base colour, so
    // keep the sector hidden rather than flashing white geometry over the map.
    gltf.scene.visible = false;
    scene.add(gltf.scene);
    const record = { sector, root: gltf.scene, meshes: [], ready: false };
    gltf.scene.traverse(object => { if (object.isMesh) record.meshes.push(object); });
    loaded.set(sector.id, record);
    updateStats();
    await applyTextures(gltf.scene, sector.url, sector.id);
    record.ready = true;
    gltf.scene.visible = true;
    updateStats();
    return record;
  })().finally(() => loading.delete(sector.id));
  loading.set(sector.id, task);
  return task;
}

function unloadSector(id) {
  const record = loaded.get(id);
  if (!record) return;
  scene.remove(record.root);
  record.root.traverse(object => {
    if (object.geometry) object.geometry.dispose();
    if (object.material) {
      const list = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of list) material.dispose();
    }
  });
  loaded.delete(id);
  updateStats();
}

async function streamSectors(force = false) {
  const reference = mode === 'overview' ? orbit.target : camera.position;
  const ranked = [...world.sectors].sort((a, b) => distanceToSector(reference, a) - distanceToSector(reference, b));
  const wanted = new Set(ranked.slice(0, 4).map(sector => sector.id));
  if (force && ui.sectorSelect.value) wanted.add(ui.sectorSelect.value);
  await Promise.all(ranked.filter(sector => wanted.has(sector.id)).map(loadSector));
  for (const [id, record] of loaded) {
    if (!record.ready) continue;
    if (!wanted.has(id) && distanceToSector(reference, record.sector) > 1400) unloadSector(id);
  }
}

function updateStats() {
  let placements = 0, models = 0;
  for (const record of loaded.values()) {
    if (!record.ready) continue;
    placements += record.sector.placements;
    models += record.sector.models;
  }
  ui.sectors.textContent = `${loaded.size} / ${world.sectors.length}`;
  ui.placements.textContent = placements.toLocaleString();
  ui.models.textContent = models.toLocaleString();
  ui.textures.textContent = textureCache.size.toLocaleString();
}

function setMode(next) {
  mode = next;
  orbit.enabled = next === 'overview';
  ui.mode.textContent = next[0].toUpperCase() + next.slice(1);
  ui.crosshair.classList.toggle('visible', next !== 'overview');
  for (const button of ui.buttons) button.classList.toggle('active', button.dataset.mode === next);
  if (next === 'walk') { verticalVelocity = 0; fallTimer = 0; snapToGround(); }
  if (next === 'overview') pointer.unlock();
  else pointer.lock();
}

// Casts from above the tallest loaded sector rather than from the camera, so it
// still recovers when the player has already fallen below the map.
function snapToGround() {
  const meshes = [...loaded.values()].flatMap(record => record.meshes);
  if (!meshes.length) return false;
  let top = camera.position.y;
  for (const { sector } of loaded.values()) top = Math.max(top, sector.bounds.max[1]);
  raycaster.set(new THREE.Vector3(camera.position.x, top + 100, camera.position.z), down);
  raycaster.near = 0;
  raycaster.far = (top + 100) - camera.position.y + 2500;
  const hit = raycaster.intersectObjects(meshes, false)[0];
  if (!hit) return false;
  camera.position.y = hit.point.y + 1.75;
  verticalVelocity = 0;
  fallTimer = 0;
  return true;
}

function teleport(sector) {
  const center = centerOf(sector);
  camera.position.copy(center).add(new THREE.Vector3(0, 230, 260));
  orbit.target.copy(center);
  orbit.update();
  verticalVelocity = 0;
  fallTimer = 0;
  loadSector(sector).then(() => {
    // The destination geometry only exists now, so a walking player has been
    // falling through empty space since the teleport. Put them back on it.
    if (mode === 'walk') snapToGround();
    return streamSectors(true);
  });
}

function movePlayer(dt) {
  if (mode === 'overview') { orbit.update(); return; }
  const speed = mode === 'fly' ? (keys.has('ShiftLeft') ? 260 : 85) : (keys.has('ShiftLeft') ? 13 : 6.5);
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  if (mode === 'walk') { forward.y = 0; forward.normalize(); }
  const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();
  const movement = new THREE.Vector3();
  if (keys.has('KeyW')) movement.add(forward);
  if (keys.has('KeyS')) movement.sub(forward);
  if (keys.has('KeyD')) movement.add(right);
  if (keys.has('KeyA')) movement.sub(right);
  if (movement.lengthSq()) camera.position.addScaledVector(movement.normalize(), speed * dt);

  if (mode === 'fly') {
    if (keys.has('Space') || keys.has('KeyE')) camera.position.y += speed * dt;
    if (keys.has('ControlLeft') || keys.has('KeyQ') || keys.has('KeyC')) camera.position.y -= speed * dt;
    return;
  }

  verticalVelocity -= 22 * dt;
  camera.position.y += verticalVelocity * dt;
  groundTimer -= dt;
  if (groundTimer <= 0) {
    groundTimer = 0.08;
    raycaster.set(new THREE.Vector3(camera.position.x, camera.position.y + 3, camera.position.z), down);
    raycaster.near = 0;
    raycaster.far = Math.max(12, Math.abs(verticalVelocity) * 0.25 + 8);
    const meshes = [...loaded.values()].flatMap(record => record.meshes);
    const hit = raycaster.intersectObjects(meshes, false)[0];
    if (hit && camera.position.y <= hit.point.y + 1.75 && verticalVelocity <= 0) {
      camera.position.y = hit.point.y + 1.75;
      verticalVelocity = keys.has('Space') ? 8 : 0;
      fallTimer = 0;
    } else if (verticalVelocity < 0) {
      // No ground within the short probe. Streaming gaps and teleports can drop
      // the player out of the world entirely, so recover after a brief fall.
      fallTimer += 0.08;
      if (fallTimer > 1.2) snapToGround();
    }
  }
}

ui.buttons.forEach(button => button.addEventListener('click', () => setMode(button.dataset.mode)));
renderer.domElement.addEventListener('click', () => { if (mode !== 'overview' && !pointer.isLocked) pointer.lock(); });
ui.sectorSelect.addEventListener('change', () => teleport(world.sectors.find(sector => sector.id === ui.sectorSelect.value)));
addEventListener('keydown', event => { keys.add(event.code); if (event.code === 'KeyF') setMode(mode === 'fly' ? 'walk' : 'fly'); });
addEventListener('keyup', event => keys.delete(event.code));
addEventListener('blur', () => keys.clear());

const start = world.sectors.find(sector => sector.id === 'manhat01') ?? world.sectors[0];
ui.sectorSelect.value = start.id;
teleport(start);
await loadSector(start);
initialized = true;
ui.bar.style.width = '100%';
ui.status.textContent = 'Ready';
setTimeout(() => { ui.loading.classList.add('done'); setTimeout(() => ui.loading.remove(), 450); }, 250);
streamSectors(true);

globalThis.gta4map = {
  scene, camera, renderer, world, setMode,
  getState: () => ({
    ready: initialized,
    mode,
    loadedSectors: [...loaded.keys()],
    // Sectors whose geometry is in the scene but whose textures are still being
    // applied; they are hidden until this drains.
    pendingSectors: [...loaded.values()].filter(record => !record.ready).map(record => record.sector.id),
    sectors: world.sectors.length,
    textures: textureCache.size,
    camera: camera.position.toArray(),
  }),
};

function frame() {
  requestAnimationFrame(frame);
  timer.update();
  const dt = Math.min(timer.getDelta(), 0.05);
  movePlayer(dt);
  streamTimer -= dt;
  if (streamTimer <= 0) { streamTimer = 1.2; streamSectors(); }
  renderer.render(scene, camera);
}
frame();
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
