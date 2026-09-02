import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DDSLoader } from 'three/addons/loaders/DDSLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { buildSector } from './sector-builder.js';

const ui = {
  loading: document.querySelector('#loading'), status: document.querySelector('#status'), bar: document.querySelector('#bar'),
  mode: document.querySelector('#mode'), sectors: document.querySelector('#sectors'), placements: document.querySelector('#placements'),
  models: document.querySelector('#models'), textures: document.querySelector('#textures'), sectorSelect: document.querySelector('#sector-select'),
  buttons: [...document.querySelectorAll('[data-mode]')], crosshair: document.querySelector('#crosshair'),
};

// Draw calls now scale with texture-array buckets per sector (~23) instead of
// with material count (~800), so more of the city can stay resident. The limit
// is texture memory, not draw calls: measured on an AMD iGPU, 6 sectors renders
// in 5.7ms at 153MB but 8 sectors falls off a cliff to 20.4ms at 215MB once the
// arrays no longer fit in dedicated VRAM. Raise these on a discrete GPU.
// Note maxTextureEdge only applies to the per-file fallback path; bundles are
// trimmed at pack time (tools/pack-textures.mjs --max-edge).
const tuning = { residentSectors: 6, maxResidentSectors: 7, unloadDistance: 2200, maxTextureEdge: 256, anisotropy: 8, perObjectCull: false };

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
const world = await fetch('./assets/world.json').then(response => {
  if (!response.ok) throw new Error('Full world data is not built yet. Run npm run extract:world.');
  return response.json();
});

const loaded = new Map();
const loading = new Map();
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
let textureLayers = 0;
// Rebuilt only when sectors come and go, instead of on every raycast tick.
let colliders = [];

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

function refreshColliders() {
  colliders = [...loaded.values()].filter(record => record.ready).flatMap(record => record.built.container.children);
}

// Prebuilt texture arrays from tools/pack-textures.mjs. Two requests instead of
// ~800 per sector, carrying only the mip levels the GPU actually receives.
// Missing bundles are not an error: the viewer falls back to per-file DDS.
async function loadBundle(sectorUrl) {
  const base = new URL(sectorUrl, location.href);
  try {
    const manifestResponse = await fetch(new URL('textures.json', base));
    if (!manifestResponse.ok) return null;
    const manifest = await manifestResponse.json();
    const binaryResponse = await fetch(new URL('textures.bin', base));
    if (!binaryResponse.ok) return null;
    return { manifest, binary: await binaryResponse.arrayBuffer() };
  } catch { return null; }
}

// The GLB scene is only staging: once its geometry has been copied into
// BatchedMeshes nothing references it, so release it rather than leaving a
// second copy of every buffer alive.
function releaseSource(root) {
  root.traverse(object => {
    if (object.geometry) object.geometry.dispose();
    for (const material of [object.material].flat()) material?.dispose();
  });
}

async function loadSector(sector) {
  if (loaded.has(sector.id)) return loaded.get(sector.id);
  if (loading.has(sector.id)) return loading.get(sector.id);
  const task = (async () => {
    if (!initialized) ui.status.textContent = `Loading ${sector.id} geometry…`;
    const [gltf, bundle] = await Promise.all([
      gltfLoader.loadAsync(sector.url, event => {
        if (!initialized && event.total) ui.bar.style.width = `${Math.round(event.loaded / event.total * 45)}%`;
      }),
      loadBundle(sector.url),
    ]);
    const record = { sector, built: null, ready: false };
    loaded.set(sector.id, record);
    updateStats();

    const built = await buildSector({
      root: gltf.scene,
      sectorUrl: sector.url,
      loadDDS: url => ddsLoader.loadAsync(url),
      bundle,
      maxEdge: tuning.maxTextureEdge,
      anisotropy: Math.min(tuning.anisotropy, renderer.capabilities.getMaxAnisotropy()),
      perObjectCull: tuning.perObjectCull,
      onProgress: (done, total) => {
        if (initialized) return;
        ui.bar.style.width = `${45 + Math.round(done / Math.max(1, total) * 55)}%`;
        ui.status.textContent = `Packing GTA textures · ${done.toLocaleString()} / ${total.toLocaleString()}`;
      },
    });
    releaseSource(gltf.scene);

    // Streaming can drop this sector while its textures were still downloading.
    if (!loaded.has(sector.id)) { built.dispose(); return record; }

    built.container.name = `sector:${sector.id}`;
    scene.add(built.container);
    record.built = built;
    record.ready = true;
    textureLayers += built.stats.arrays;
    refreshColliders();
    updateStats();
    return record;
  })().finally(() => loading.delete(sector.id));
  loading.set(sector.id, task);
  return task;
}

function unloadSector(id) {
  const record = loaded.get(id);
  if (!record) return;
  loaded.delete(id);
  if (record.built) {
    scene.remove(record.built.container);
    textureLayers -= record.built.stats.arrays;
    // Frees the batch buffers *and* this sector's texture arrays. The old
    // per-URL cache never released textures, so touring the map leaked all
    // 16k of them into VRAM.
    record.built.dispose();
  }
  refreshColliders();
  updateStats();
}

async function streamSectors(force = false) {
  const reference = mode === 'overview' ? orbit.target : camera.position;
  const ranked = [...world.sectors].sort((a, b) => distanceToSector(reference, a) - distanceToSector(reference, b));
  const wanted = new Set(ranked.slice(0, tuning.residentSectors).map(sector => sector.id));
  if (force && ui.sectorSelect.value) wanted.add(ui.sectorSelect.value);
  await Promise.all(ranked.filter(sector => wanted.has(sector.id)).map(loadSector));

  // Distance alone let sectors pile up while driving across the map — each one
  // holds its own texture arrays, so cap the resident set and evict furthest
  // first to keep VRAM bounded.
  const evictable = [...loaded.entries()]
    .filter(([id, record]) => record.ready && !wanted.has(id))
    .map(([id, record]) => ({ id, distance: distanceToSector(reference, record.sector) }))
    .sort((a, b) => b.distance - a.distance);
  for (const { id, distance } of evictable) {
    if (distance > tuning.unloadDistance || loaded.size > tuning.maxResidentSectors) unloadSector(id);
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
  ui.textures.textContent = `${textureLayers.toLocaleString()} arrays · ${renderer.info.render.calls} calls`;
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
  if (!colliders.length) return false;
  let top = camera.position.y;
  for (const { sector } of loaded.values()) top = Math.max(top, sector.bounds.max[1]);
  raycaster.set(new THREE.Vector3(camera.position.x, top + 100, camera.position.z), down);
  raycaster.near = 0;
  raycaster.far = (top + 100) - camera.position.y + 2500;
  const hit = raycaster.intersectObjects(colliders, false)[0];
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
    const hit = raycaster.intersectObjects(colliders, false)[0];
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
  scene, camera, renderer, world, setMode, tuning,
  getState: () => ({
    ready: initialized,
    mode,
    loadedSectors: [...loaded.keys()],
    // Sectors whose GLB has arrived but whose batches are still being built.
    pendingSectors: [...loaded.values()].filter(record => !record.ready).map(record => record.sector.id),
    sectors: world.sectors.length,
    textures: textureLayers,
    drawCalls: renderer.info.render.calls,
    batches: [...loaded.values()].filter(r => r.ready).reduce((a, r) => a + r.built.stats.batches, 0),
    textureBytes: [...loaded.values()].filter(r => r.ready).reduce((a, r) => a + r.built.stats.bytes, 0),
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
