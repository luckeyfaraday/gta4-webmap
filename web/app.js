import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DDSLoader } from 'three/addons/loaders/DDSLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { buildSector } from './sector-builder.js';
import { Timecycle, LightingRig } from './lighting.js';
import { GradePipeline } from './grade.js';
import { loadPlayer } from './player-model.js';

const ui = {
  loading: document.querySelector('#loading'), status: document.querySelector('#status'), bar: document.querySelector('#bar'),
  mode: document.querySelector('#mode'), sectors: document.querySelector('#sectors'), placements: document.querySelector('#placements'),
  models: document.querySelector('#models'), textures: document.querySelector('#textures'), sectorSelect: document.querySelector('#sector-select'),
  clip: document.querySelector('#clip'),
  buttons: [...document.querySelectorAll('[data-mode]')], crosshair: document.querySelector('#crosshair'),
  hour: document.querySelector('#hour'), hourLabel: document.querySelector('#hour-label'),
  weather: document.querySelector('#weather'), baked: document.querySelector('#baked'),
  grade: document.querySelector('#grade'),
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
// Tone mapping is deliberately left off the renderer: three.js only applies it
// when a material draws straight to the canvas, and everything here goes
// through the grade pipeline's render targets instead. web/grade.js does the
// ACES pass, with the exposure from timecyc.dat's own Exposure column.
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();

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

const timecycle = new Timecycle(await fetch('./data/timecyc.json').then(response => {
  if (!response.ok) throw new Error('Timecycle data is not built yet. Run npm run extract:timecyc.');
  return response.json();
}));
const lighting = new LightingRig(scene, renderer, camera, timecycle, { weather: 'EXTRASUNNY', hour: 12 });
const grading = new GradePipeline(renderer, scene, camera);

// renderer.info.render.calls is reset by every renderer.render(), and the
// composer issues one per pass, so reading it after the frame reports the final
// full-screen blit rather than the city. Latch it when the scene itself is done.
let sceneDrawCalls = 0;
scene.onAfterRender = () => { sceneDrawCalls = renderer.info.render.calls; };

// GTA IV bakes prelighting into COLOR_0 and the extractor writes it into every
// GLB. GLTFLoader already switches vertexColors on by itself whenever a
// primitive carries COLOR_0, so this was live before the toggle existed; what
// the toggle adds is the ability to render without it for comparison, plus the
// terrain exclusion below.
//
// Measured over 520k sampled vertices in the Manhattan sectors, the luminance
// is spread broadly across 0..1 (mean 0.49) with spikes at both ends rather
// than sitting near white with darkening only in crevices. That is more than
// plain ambient occlusion, and how each shader family is meant to scale it is
// still open - see test/baked-ab.mjs.
let bakedLighting = true;

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

// Walk mode drives Niko and follows him; the camera is no longer the player.
// Speeds are tuning constants rather than extracted data: GTA IV's locomotion
// clips run in place and the travel speeds that go with them live in
// move-blend data the archives do not carry.
const GAITS = [
  { clip: 'idle', speed: 0 },
  { clip: 'walk', speed: 1.55 },
  { clip: 'run', speed: 4.2 },
  { clip: 'sprint', speed: 6.4 },
];
const EYE_HEIGHT = 1.62;
const CAMERA_DISTANCE = 3.9;
// Which way the bind pose faces. The export cancels each clip's own opening
// yaw, so this single constant aligns the model with the direction the
// controller thinks it is walking. Calibrated against the eye joints, which
// getState reports as `facing` so a regression shows up as a failing test
// rather than a character who runs sideways.
const MODEL_YAW_OFFSET = Math.PI / 2;

const player = {
  position: new THREE.Vector3(),
  yaw: 0,
  speed: 0,
  grounded: false,
  thirdPerson: true,
};
// Camera orbit around the player, driven by the mouse while pointer-locked.
const view = { yaw: 0, pitch: -0.12 };
const focus = new THREE.Vector3();
const cameraOffset = new THREE.Vector3();
let landTimer = 0;
let animState = 'idle';

for (const sector of world.sectors) {
  const option = document.createElement('option');
  option.value = sector.id;
  option.textContent = `${sector.region.toUpperCase()} · ${sector.id}`;
  ui.sectorSelect.append(option);
}

// Run `npm run extract:player` to produce this. Without it the viewer still
// works, it just walks the city as a disembodied camera.
const character = await loadPlayer('./assets/player/player.gltf', renderer).catch(error => {
  console.warn('Player model unavailable; walk mode stays first-person.', error);
  return null;
});
if (!character) player.thirdPerson = false;

// The character keeps its own node so the map's mirrored world stays a detail
// of the model rather than something every transform has to undo: app-side
// position and facing go on the carrier, the mirror stays inside.
const carrier = new THREE.Group();
if (character) {
  // Program.cs exports the world through (-x, z, -y), a reflection. The
  // character is exported with the proper conversion, so mirror it to match.
  character.root.scale.x = -1;
  carrier.add(character.root);
  carrier.visible = false;
  scene.add(carrier);
}

// Where the character is actually looking, measured from the skeleton rather
// than assumed: the eyes sit ahead of the head joint, and their midpoint
// survives the mirror that left and right individually do not.
const headBone = character?.root.getObjectByName('Char_Head');
const eyeBones = ['l_EyeJnt', 'r_EyeJnt'].map(name => character?.root.getObjectByName(name)).filter(Boolean);

function facingVector() {
  if (!headBone || eyeBones.length !== 2) return null;
  const eyes = new THREE.Vector3();
  for (const bone of eyeBones) eyes.add(bone.getWorldPosition(new THREE.Vector3()));
  eyes.multiplyScalar(0.5).sub(headBone.getWorldPosition(new THREE.Vector3()));
  eyes.y = 0;
  return eyes.lengthSq() ? eyes.normalize() : null;
}

const mixer = character ? new THREE.AnimationMixer(character.root) : null;
const actions = new Map(character?.clips.map(clip => [clip.name, mixer.clipAction(clip)]) ?? []);
let currentAction = null;

// Crossfades rather than cuts: every clip now starts from the same facing, so
// blending two of them no longer swings the body through the difference.
function setClip(name, { fade = 0.18, loop = true, timeScale = 1 } = {}) {
  const next = actions.get(name);
  if (!next) return;
  next.timeScale = timeScale;
  if (next === currentAction) return;
  next.reset();
  next.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
  next.clampWhenFinished = !loop;
  next.play();
  if (currentAction) currentAction.crossFadeTo(next, fade, false);
  currentAction = next;
  animState = name;
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

// Batching moved the baked-lighting decision into sector-builder.js, which
// sorts geometry into baked and non-baked batches at build time (the
// gta_terrain_va_* family reuses COLOR_0 as blend weights, so it is kept out).
// All that is left here is flipping the toggle on the batches that carry it.
function refreshBakedLighting() {
  for (const record of loaded.values()) record.built?.setBaked(bakedLighting);
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
    // A sector that streams in after the toggle was flipped would otherwise
    // arrive baked while the rest of the city is not.
    built.setBaked(bakedLighting);
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
  // In walk mode the camera trails the character, so stream around the
  // character rather than around the lens.
  const reference = mode === 'overview' ? orbit.target : mode === 'walk' ? player.position : camera.position;
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
  ui.textures.textContent = `${textureLayers.toLocaleString()} arrays · ${sceneDrawCalls} calls`;
}

function setMode(next) {
  mode = next;
  orbit.enabled = next === 'overview';
  // PointerLockControls steers the camera itself, which is right for fly but
  // fights the follow camera in walk mode, where the mouse orbits the player.
  pointer.enabled = next === 'fly';
  ui.mode.textContent = next[0].toUpperCase() + next.slice(1);
  ui.crosshair.classList.toggle('visible', next !== 'overview');
  carrier.visible = next === 'walk' && player.thirdPerson;
  for (const button of ui.buttons) button.classList.toggle('active', button.dataset.mode === next);
  if (next === 'walk') {
    // Entering from another mode, the player starts wherever the camera was.
    player.position.copy(camera.position);
    player.position.y -= EYE_HEIGHT;
    const heading = new THREE.Vector3();
    camera.getWorldDirection(heading);
    view.yaw = Math.atan2(-heading.x, -heading.z);
    player.yaw = view.yaw;
    verticalVelocity = 0;
    fallTimer = 0;
    landTimer = 0;
    snapToGround();
    updateFollowCamera();
  }
  if (next === 'overview') pointer.unlock();
  else pointer.lock();
}

// Casts from above the tallest loaded sector rather than from the character, so
// it still recovers when they have already fallen below the map.
function snapToGround() {
  if (!colliders.length) return false;
  let top = player.position.y;
  for (const { sector } of loaded.values()) top = Math.max(top, sector.bounds.max[1]);
  raycaster.set(new THREE.Vector3(player.position.x, top + 100, player.position.z), down);
  raycaster.near = 0;
  raycaster.far = (top + 100) - player.position.y + 2500;
  const hit = raycaster.intersectObjects(colliders, false)[0];
  if (!hit) return false;
  player.position.y = hit.point.y;
  verticalVelocity = 0;
  fallTimer = 0;
  player.grounded = true;
  return true;
}

// Third person orbits the character; first person drops the lens to eye level
// and hides him. Both share one yaw/pitch so switching does not jump the view.
function updateFollowCamera() {
  focus.copy(player.position);
  focus.y += EYE_HEIGHT;
  if (!player.thirdPerson) {
    camera.position.copy(focus);
    camera.lookAt(
      focus.x - Math.sin(view.yaw) * Math.cos(view.pitch),
      focus.y + Math.sin(view.pitch),
      focus.z - Math.cos(view.yaw) * Math.cos(view.pitch));
    return;
  }
  cameraOffset.set(
    Math.sin(view.yaw) * Math.cos(view.pitch),
    Math.sin(view.pitch),
    Math.cos(view.yaw) * Math.cos(view.pitch));
  let distance = CAMERA_DISTANCE;
  if (colliders.length) {
    // Pull in rather than let the camera sink through whatever is behind him.
    raycaster.set(focus, cameraOffset);
    raycaster.near = 0;
    raycaster.far = CAMERA_DISTANCE + 0.4;
    const hit = raycaster.intersectObjects(colliders, false)[0];
    if (hit) distance = Math.max(0.65, hit.distance - 0.35);
  }
  camera.position.copy(focus).addScaledVector(cameraOffset, distance);
  camera.lookAt(focus);
}

function teleport(sector) {
  const center = centerOf(sector);
  camera.position.copy(center).add(new THREE.Vector3(0, 230, 260));
  orbit.target.copy(center);
  orbit.update();
  player.position.copy(center);
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
  if (mode === 'fly') { moveFly(dt); return; }
  moveWalk(dt);
}

function moveFly(dt) {
  const speed = keys.has('ShiftLeft') ? 260 : 85;
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();
  const movement = new THREE.Vector3();
  if (keys.has('KeyW')) movement.add(forward);
  if (keys.has('KeyS')) movement.sub(forward);
  if (keys.has('KeyD')) movement.add(right);
  if (keys.has('KeyA')) movement.sub(right);
  if (movement.lengthSq()) camera.position.addScaledVector(movement.normalize(), speed * dt);
  if (keys.has('Space') || keys.has('KeyE')) camera.position.y += speed * dt;
  if (keys.has('ControlLeft') || keys.has('KeyQ') || keys.has('KeyC')) camera.position.y -= speed * dt;
}

function moveWalk(dt) {
  // Input is read in the camera's frame: W is always "away from the lens".
  const forward = new THREE.Vector3(-Math.sin(view.yaw), 0, -Math.cos(view.yaw));
  const right = new THREE.Vector3().crossVectors(forward, camera.up).normalize();
  const movement = new THREE.Vector3();
  if (keys.has('KeyW')) movement.add(forward);
  if (keys.has('KeyS')) movement.sub(forward);
  if (keys.has('KeyD')) movement.add(right);
  if (keys.has('KeyA')) movement.sub(right);

  const gait = keys.has('ShiftLeft') ? 3 : keys.has('AltLeft') ? 1 : 2;
  const wanted = movement.lengthSq() ? GAITS[gait].speed : 0;
  player.speed = wanted;
  if (wanted > 0) {
    movement.normalize();
    player.position.addScaledVector(movement, wanted * dt);
    // He turns to face where he is going, the way GTA IV does on foot, so the
    // forward locomotion clips carry every direction and no strafe set is
    // needed. Turning is rate-limited so a reversal reads as a turn.
    const target = Math.atan2(movement.x, movement.z);
    let delta = ((target - player.yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    player.yaw += Math.max(-9 * dt, Math.min(9 * dt, delta));
  }

  verticalVelocity -= 22 * dt;
  player.position.y += verticalVelocity * dt;
  groundTimer -= dt;
  if (groundTimer <= 0) {
    groundTimer = 0.08;
    raycaster.set(new THREE.Vector3(player.position.x, player.position.y + 3, player.position.z), down);
    raycaster.near = 0;
    raycaster.far = Math.max(12, Math.abs(verticalVelocity) * 0.25 + 8);
    const hit = raycaster.intersectObjects(colliders, false)[0];
    if (hit && player.position.y <= hit.point.y && verticalVelocity <= 0) {
      if (!player.grounded) landTimer = 0.32;
      player.position.y = hit.point.y;
      verticalVelocity = keys.has('Space') ? 6.4 : 0;
      player.grounded = verticalVelocity === 0;
      fallTimer = 0;
    } else if (verticalVelocity < 0) {
      // No ground within the short probe. Streaming gaps and teleports can drop
      // the player out of the world entirely, so recover after a brief fall.
      player.grounded = false;
      fallTimer += 0.08;
      if (fallTimer > 1.2) snapToGround();
    }
  }

  carrier.position.copy(player.position);
  carrier.rotation.y = player.yaw + MODEL_YAW_OFFSET;
  updateFollowCamera();
  updateAnimation(dt);
}

// Picks a clip from what the character is actually doing. Playback rate is
// scaled by how far his real speed is from the gait the clip was authored for,
// which is what keeps his feet off the ice.
function updateAnimation(dt) {
  if (!mixer) return;
  landTimer = Math.max(0, landTimer - dt);

  if (!player.grounded && verticalVelocity > 0.5) setClip('jump_takeoff_r', { fade: 0.08, loop: false });
  else if (!player.grounded) setClip('jump_inair_r', { fade: 0.12 });
  else if (landTimer > 0) setClip('jump_land_r', { fade: 0.08, loop: false });
  else if (player.speed < 0.1) setClip('idle', { fade: 0.22 });
  else {
    let gait = GAITS[1];
    for (const candidate of GAITS) if (candidate.speed > 0 && player.speed >= candidate.speed - 0.01) gait = candidate;
    setClip(gait.clip, { fade: 0.18, timeScale: THREE.MathUtils.clamp(player.speed / gait.speed, 0.6, 1.6) });
  }
  ui.clip.textContent = animState;
  mixer.update(dt);
}

for (const name of timecycle.weathers) {
  const option = document.createElement('option');
  option.value = option.textContent = name;
  ui.weather.append(option);
}
ui.weather.value = lighting.weather;
ui.hour.value = lighting.hour;

function formatHour(hour) {
  const minutes = Math.round(hour * 60) % 1440;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function refreshLightingLabel() {
  const { from, to, blend } = lighting.frame;
  ui.hourLabel.textContent = `${formatHour(lighting.hour)} · ${blend < 0.5 ? from : to}`;
}

ui.hour.addEventListener('input', () => { lighting.setHour(Number(ui.hour.value)); refreshLightingLabel(); });
ui.weather.addEventListener('change', () => { lighting.setWeather(ui.weather.value); refreshLightingLabel(); });
ui.baked.addEventListener('change', () => { bakedLighting = ui.baked.checked; refreshBakedLighting(); });
ui.grade.addEventListener('change', () => { grading.enabled = ui.grade.checked; });
refreshLightingLabel();

ui.buttons.forEach(button => button.addEventListener('click', () => setMode(button.dataset.mode)));
renderer.domElement.addEventListener('click', () => { if (mode !== 'overview' && !pointer.isLocked) pointer.lock(); });
ui.sectorSelect.addEventListener('change', () => teleport(world.sectors.find(sector => sector.id === ui.sectorSelect.value)));

// Walk mode orbits the character instead of turning the camera in place, so it
// takes the mouse itself rather than leaving it to PointerLockControls.
addEventListener('mousemove', event => {
  if (mode !== 'walk' || !pointer.isLocked) return;
  view.yaw -= event.movementX * 0.0022;
  view.pitch = THREE.MathUtils.clamp(view.pitch - event.movementY * 0.0018, -0.95, 0.75);
});

addEventListener('keydown', event => {
  keys.add(event.code);
  if (event.code === 'KeyF') setMode(mode === 'fly' ? 'walk' : 'fly');
  if (event.code === 'KeyV' && mode === 'walk' && character) {
    player.thirdPerson = !player.thirdPerson;
    carrier.visible = player.thirdPerson;
  }
});
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
  scene, camera, renderer, world, setMode, tuning, lighting, timecycle, character,
  setHour: hour => { lighting.setHour(hour); ui.hour.value = hour; refreshLightingLabel(); },
  setWeather: name => { lighting.setWeather(name); ui.weather.value = name; refreshLightingLabel(); },
  setBakedLighting: enabled => { bakedLighting = ui.baked.checked = enabled; refreshBakedLighting(); },
  setGrade: enabled => { grading.enabled = ui.grade.checked = enabled; },
  grading,
  getState: () => ({
    ready: initialized,
    mode,
    lighting: {
      hour: lighting.hour,
      weather: lighting.weather,
      baked: bakedLighting,
      exposure: lighting.exposure,
      sun: lighting.sunDir.toArray(),
      sunIntensity: lighting.sun.intensity,
      ambientIntensity: lighting.ambient.intensity,
      fogDensity: lighting.scene.fog.density,
      grade: grading.enabled,
      bloom: [grading.bloom.threshold, grading.bloom.strength],
      colourCorrect: lighting.frame.colourCorrect,
      desaturation: [lighting.frame.desaturation, lighting.frame.desaturationFar],
      depthFx: [lighting.frame.depthFxNear, lighting.frame.depthFxFar],
    },
    loadedSectors: [...loaded.keys()],
    // Sectors whose GLB has arrived but whose batches are still being built.
    pendingSectors: [...loaded.values()].filter(record => !record.ready).map(record => record.sector.id),
    sectors: world.sectors.length,
    textures: textureLayers,
    drawCalls: sceneDrawCalls,
    batches: [...loaded.values()].filter(r => r.ready).reduce((a, r) => a + r.built.stats.batches, 0),
    textureBytes: [...loaded.values()].filter(r => r.ready).reduce((a, r) => a + r.built.stats.bytes, 0),
    camera: camera.position.toArray(),
    player: character ? {
      position: player.position.toArray(),
      yaw: player.yaw,
      speed: player.speed,
      grounded: player.grounded,
      visible: carrier.visible,
      thirdPerson: player.thirdPerson,
      clip: animState,
      clips: character.clips.length,
      bones: character.bones,
      facing: facingVector()?.toArray() ?? null,
    } : null,
  }),
};

function frame() {
  requestAnimationFrame(frame);
  timer.update();
  const dt = Math.min(timer.getDelta(), 0.05);
  movePlayer(dt);
  lighting.follow();
  streamTimer -= dt;
  if (streamTimer <= 0) { streamTimer = 1.2; streamSectors(); }
  // A handful of uniform writes, so it is cheaper than tracking when the
  // keyframe or the toggle last changed.
  grading.update(lighting.frame, lighting.exposure);
  grading.render();
}
frame();
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  grading.setSize(innerWidth, innerHeight);
});
