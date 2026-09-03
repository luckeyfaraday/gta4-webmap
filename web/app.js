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
import { RoadGraph } from './road-graph.js';
import { Traffic } from './traffic.js';
import { NavPoints } from './nav-points.js';
import { Crowd } from './crowd.js';
import { Wanted } from './wanted.js';
import { Police } from './police.js';
import { Driving } from './driving.js';
import { Weapons } from './weapons.js';

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
const tuning = { residentSectors: 6, maxResidentSectors: 7, unloadDistance: 2200, maxTextureEdge: 256, anisotropy: 8, perObjectCull: false, maxVehicles: 24, maxPeds: 18 };

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
const probeOrigin = new THREE.Vector3();
const pushNormal = new THREE.Vector3();
const raycaster = new THREE.Raycaster();
let mode = 'overview';
let verticalVelocity = 0;
let fallTimer = 0;
let unstickTimer = 0;
let streamTimer = 0;
// Freezes simulation while still rendering: the pose, the traffic and the crowd
// all hold where they are and the camera can be moved without the walk
// controller pulling it back. Used for framing shots.
let paused = false;
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
// Probing from above his feet lets a kerb or a step within this height read as
// ground to walk up onto rather than a gap to fall into.
const STEP_HEIGHT = 0.45;
// Roughly shoulder width. The collision probes all sit above STEP_HEIGHT so a
// kerb or a step is walked up rather than bumped into.
const PLAYER_RADIUS = 0.34;
const COLLIDE_HEIGHTS = [0.6, 1.15, 1.55];
const COLLIDE_DIRECTIONS = Array.from({ length: 8 }, (_, index) => {
  const angle = index * Math.PI / 4;
  return new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle));
});
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
  // How far the controller asked him to walk, against how far he actually got.
  // A wall shows up as the two diverging, which is frame-rate independent.
  commanded: 0,
  travelled: 0,
  pushes: 0,
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
// Ambient traffic on the road graph from paths.ipl. Loaded alongside the world
// rather than lazily, because the graph is a single 950 KB fetch and the spawn
// loop needs it from the first frame the player moves.
const roadGraph = await RoadGraph.load().catch(error => {
  console.warn('Road graph unavailable, traffic disabled', error);
  return null;
});
// Path node heights are not the road surface — see the note in traffic.js — so
// traffic is given a probe against the streamed city and rides the real
// geometry instead. Its own raycaster, because the player's is reused mid-frame.
const trafficRay = new THREE.Raycaster();
const probeOrigin2 = new THREE.Vector3();
function probeRoad(x, z, yHint) {
  if (!colliders.length) return null;
  probeOrigin2.set(x, yHint + 6, z);
  trafficRay.set(probeOrigin2, down);
  trafficRay.near = 0;
  trafficRay.far = 60;
  const hits = trafficRay.intersectObjects(colliders, false);
  if (!hits.length) return null;

  // The surface CLOSEST to where the caller already is, not the first one the
  // ray meets. The navmesh points carry no height — the per-tile Z base is not
  // in the .wnv files — so a point on a bridge and a point on the street below
  // it are the same point in plan. Taking the topmost hit drops a ped off the
  // bridge; taking the nearest keeps whoever is up there up there.
  let best = hits[0];
  let bestGap = Math.abs(best.point.y - yHint);
  for (let i = 1; i < hits.length; i++) {
    const gap = Math.abs(hits[i].point.y - yHint);
    if (gap < bestGap) { bestGap = gap; best = hits[i]; }
  }
  return best.point.y;
}

const traffic = roadGraph
  ? await Traffic.create(roadGraph, scene, renderer, {
      maxVehicles: tuning.maxVehicles,
      groundProbe: probeRoad,
    }).catch(error => {
      console.warn('Traffic unavailable', error);
      return null;
    })
  : null;

// The ambient crowd walks GTA IV's own pedestrian navmesh. It carries no
// heights — the per-tile Z base is not stored in the .wnv files — so peds share
// the same ground probe the traffic uses.
const navPoints = await NavPoints.load().catch(error => {
  console.warn('Navmesh unavailable, crowd disabled', error);
  return null;
});
const crowd = navPoints
  ? await Crowd.create(navPoints, scene, renderer, {
      maxPeds: tuning.maxPeds,
      groundProbe: probeRoad,
    }).catch(error => {
      console.warn('Crowd unavailable', error);
      return null;
    })
  : null;

// The wanted level and the police response to it. Wanted is pure bookkeeping and
// works with or without the world; Police needs the navmesh to move officers and
// the road graph to move cruisers.
const wanted = new Wanted();
const police = navPoints
  ? await Police.create(navPoints, roadGraph, scene, renderer, wanted, {
      groundProbe: probeRoad,
    }).catch(error => {
      console.warn('Police unavailable', error);
      return null;
    })
  : null;

const starsHud = document.querySelector('#stars');
function refreshStars() {
  if (!starsHud) return;
  const stars = wanted.stars;
  starsHud.hidden = stars === 0;
  starsHud.textContent = '★'.repeat(stars);
  // Dimmed once nothing has eyes on the player, which is the cue that the
  // level is cooling — the same signal IV gives by flashing the stars.
  starsHud.classList.toggle('cool', !wanted.pursued);
}
wanted.onChange(refreshStars);
refreshStars();

// Attacking the nearest pedestrian. The viewer has no weapons, so this stands
// in for the offence itself: it removes the ped and reports the crime, which is
// what the wanted system and the police response actually key off.
function attackNearestPed() {
  if (!crowd || mode !== 'walk') return null;
  const peds = crowd.debugPeds();
  if (!peds.length) return null;
  let best = null;
  for (const ped of peds) {
    const distance = Math.hypot(ped.position[0] - player.position.x, ped.position[2] - player.position.z);
    if (distance < 6 && (!best || distance < best.distance)) best = { ped, distance };
  }
  if (!best) return null;
  crowd.remove(best.ped.ped, player.position);
  // Witnessed if anything is close enough to see it — other peds count as
  // witnesses, which is why a crime in an empty street costs less.
  const witnesses = peds.filter(other => other !== best.ped &&
    Math.hypot(other.position[0] - player.position.x, other.position[2] - player.position.z) < 45).length;
  wanted.report('pedKilled', { witnessed: witnesses > 0 || police?.getState().seen === true });
  refreshStars();
  return { ped: best.ped.ped, witnesses, stars: wanted.stars };
}

// Driving. The ground probe is the same one traffic and the crowd use; the
// obstacle probe is a short cast along travel that stops the car rather than
// letting it drive through a building.
const drivingRay = new THREE.Raycaster();
function obstacleAhead(position, forward, distance, direction) {
  if (!colliders.length) return false;
  const origin = new THREE.Vector3(position.x, position.y + 0.7, position.z);
  const heading = forward.clone().multiplyScalar(direction >= 0 ? 1 : -1);
  drivingRay.set(origin, heading);
  drivingRay.near = 0;
  drivingRay.far = distance;
  const hit = drivingRay.intersectObjects(colliders, false)[0];
  // Ignore anything low enough to be a kerb or a ramp — those are drivable.
  return !!hit && hit.point.y > position.y + 0.45;
}
const driving = new Driving(scene, { groundProbe: probeRoad, obstacleProbe: obstacleAhead });

// Weapons. The models and every number behind them come from the game's own
// weapons.img and WeaponInfo.xml; the firing animations are Niko's, in a clip
// library exported against his skeleton.
const weapons = await Weapons.create(scene, renderer, {
  crowd, police, wanted, groundProbe: probeRoad,
}).catch(error => {
  console.warn('Weapons unavailable', error);
  return null;
});
const weaponHud = document.querySelector('#weapon');
function refreshWeaponHud() {
  if (!weaponHud) return;
  const held = weapons?.getState().held;
  weaponHud.hidden = !held;
  if (held) weaponHud.textContent = `${held.type}  ${held.ammo} / ${held.reserve}`;
}

// Where a shot starts and which way it goes. In third person the camera is
// behind the shoulder, so firing from the lens would put rounds through the
// character's own back; shots leave from his chest along the camera's aim.
const shotOrigin = new THREE.Vector3();
const shotDirection = new THREE.Vector3();
function aim() {
  camera.getWorldDirection(shotDirection);
  shotOrigin.copy(player.position);
  shotOrigin.y += 1.35;
  return { origin: shotOrigin, direction: shotDirection };
}

function fireWeapon() {
  if (!weapons?.held || mode === 'overview') return null;
  const { origin, direction } = aim();
  const result = weapons.fire(origin, direction);
  refreshWeaponHud();
  refreshStars();
  return result;
}

async function equipWeapon(type) {
  if (!weapons) return null;
  const held = await weapons.equip(type);
  refreshWeaponHud();
  return held ? weapons.getState().held : null;
}


// Getting in and out. Entering takes the nearest traffic car over as-is;
// leaving hands it back so it rejoins the flow instead of standing abandoned.
function enterNearestVehicle() {
  if (mode !== 'walk' || !traffic || driving.active) return null;
  const vehicle = traffic.takeNearest(player.position, 7);
  if (!vehicle) return null;
  driving.enter(vehicle, { yaw: vehicle.yaw });
  setMode('drive');
  return driving.getState();
}

function exitVehicle() {
  if (!driving.active) return null;
  const point = driving.exitPoint(new THREE.Vector3());
  const vehicle = driving.exit();
  if (vehicle && traffic && !traffic.give(vehicle)) {
    // Nowhere near a road — leave it where it is rather than deleting a car the
    // player just parked.
  }
  // Mode first: switching to walk seeds the player from the camera, so the
  // exit point has to be applied after it or it is immediately overwritten.
  setMode('walk');
  if (point) {
    player.position.copy(point);
    verticalVelocity = 0;
    snapToGround();
    updateFollowCamera();
  }
  return true;
}

// Running a pedestrian down. Checked against the car's own speed, because a
// stationary car resting against someone is not the same offence.
function runOverPeds() {
  if (!driving.active || !crowd) return;
  const speed = driving.speedKmh;
  if (speed < 12) return;
  const position = driving.position;
  for (const ped of crowd.debugPeds()) {
    const distance = Math.hypot(ped.position[0] - position.x, ped.position[2] - position.z);
    if (distance > 2.2) continue;
    crowd.remove(ped.ped, position);
    wanted.report('ranOverPed');
    refreshStars();
  }
}

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
// Attached here rather than where the weapons load, because the weapon clips
// play on the character's own mixer and it does not exist until now.
if (weapons && character) weapons.attachTo(carrier, mixer);
const actions = new Map(character?.clips.map(clip => [clip.name, mixer.clipAction(clip)]) ?? []);
// The armed walk cycles live in the weapon clip library rather than in
// player.gltf, so they are registered here alongside his own.
if (weapons && mixer) {
  for (const clip of weapons.locomotionClips()) actions.set(clip.name, mixer.clipAction(clip));
}
let currentAction = null;

// Crossfades rather than cuts: every clip now starts from the same facing, so
// blending two of them no longer swings the body through the difference.
// A rifle or a launcher changes how he walks, and the game ships whole
// locomotion sets for both. The pistol does not — it uses the ordinary walk,
// as it does in GTA IV — so this returns null and the normal clip is used.
function armedClip(gait) {
  const clip = weapons?.baseClip(gait);
  return clip && actions.has(clip.name) ? clip.name : null;
}

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
  sectorEpoch++;
}

// Raycasting the whole city is far more than the character needs: a batch has
// per-instance bounds, but 24 collision probes a frame across every loaded
// sector is not worth paying for when he can only reach one of them. Keep the
// batches of the sectors within reach and rebuild that list only when he leaves
// the area it was built for or the streamed set changes.
const NEAR_RADIUS = 14;
let nearMeshes = [];
let sectorEpoch = 0;
let nearEpoch = -1;
const nearOrigin = new THREE.Vector3(Infinity, Infinity, Infinity);

function refreshNearMeshes() {
  if (nearEpoch === sectorEpoch && nearOrigin.distanceToSquared(player.position) < 16) return;
  nearEpoch = sectorEpoch;
  nearOrigin.copy(player.position);
  nearMeshes = [];
  for (const record of loaded.values()) {
    if (!record.ready) continue;
    if (distanceToSector(player.position, record.sector) > NEAR_RADIUS) continue;
    nearMeshes.push(...record.built.container.children);
  }
  // Outside every sector's footprint - a teleport, or the world still streaming
  // in - fall back to everything rather than leaving him with nothing to stand
  // on or walk into.
  if (!nearMeshes.length) nearMeshes = colliders;
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
  // Niko is hidden while driving: he is in the car, and the seat bones say
  // where, but posing him in it needs a sitting clip the movement wads do not
  // carry — those live in the amb@car_std_* set.
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
  if (mode === 'drive') { moveDrive(dt); return; }
  moveWalk(dt);
}

function moveDrive(dt) {
  if (!driving.active) { setMode('walk'); return; }
  driving.update(dt, {
    forward: keys.has('KeyW'),
    back: keys.has('KeyS'),
    left: keys.has('KeyA'),
    right: keys.has('KeyD'),
    handbrake: keys.has('Space'),
  });
  // The player rides with the car, so sector streaming and the population all
  // follow the vehicle without any of them needing to know about driving.
  player.position.copy(driving.position);
  player.yaw = driving.yaw;
  refreshNearMeshes();
  updateChaseCamera(dt);
}

// Chase camera. It sits behind the car in the car's own frame rather than the
// mouse's, so the view leads through a corner, and pulls back as speed rises.
function updateChaseCamera(dt) {
  const position = driving.position;
  if (!position) return;
  const back = 6.2 + Math.min(4, driving.speedKmh * 0.03);
  const height = 2.5 + Math.min(1.2, driving.speedKmh * 0.008);
  const yaw = driving.yaw + view.yaw * 0.35;
  const wanted = new THREE.Vector3(
    position.x + Math.sin(yaw) * back,
    position.y + height,
    position.z + Math.cos(yaw) * back,
  );
  // Ease rather than snap, so bumps and kerbs do not jolt the lens.
  camera.position.lerp(wanted, Math.min(1, dt * 6));
  focus.set(position.x, position.y + 1.1, position.z);
  camera.lookAt(focus);
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

  refreshNearMeshes();

  const gait = keys.has('ShiftLeft') ? 3 : keys.has('AltLeft') ? 1 : 2;
  const wanted = movement.lengthSq() ? GAITS[gait].speed : 0;
  player.speed = wanted;
  const wasAt = { x: player.position.x, z: player.position.z };
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

  resolveWalls(movement, wanted > 0, dt);

  player.commanded += wanted * dt;
  player.travelled += Math.hypot(player.position.x - wasAt.x, player.position.z - wasAt.z);

  verticalVelocity -= 22 * dt;
  player.position.y += verticalVelocity * dt;

  // Ground contact is resolved every frame. Probing on a timer instead let a
  // frame's worth of gravity accumulate between corrections, which showed up as
  // the character (and the camera following him) vibrating on flat ground.
  const hit = groundProbe(dt);
  // How far below him the ground still counts as underfoot. Already on his feet
  // he steps down onto it, up to the same height he can step up: walking down a
  // slope or a kerb, gravity puts him above the next surface before the probe
  // runs, and testing only for "at or below the ground" read every one of those
  // frames as a fall and a fresh landing. Airborne, only this frame's fall
  // counts, so a jump still arcs and lands where it should.
  const reach = player.grounded ? STEP_HEIGHT : Math.max(0, -verticalVelocity) * dt;
  if (hit && verticalVelocity <= 0 && player.position.y <= hit.point.y + reach) {
    if (!player.grounded) landTimer = 0.32;
    player.position.y = hit.point.y;
    verticalVelocity = keys.has('Space') ? 6.4 : 0;
    player.grounded = verticalVelocity === 0;
    fallTimer = 0;
  } else if (verticalVelocity < 0) {
    // Streaming gaps and teleports can drop the player out of the world
    // entirely, so recover after a brief fall.
    player.grounded = false;
    fallTimer += dt;
    if (fallTimer > 1.2) snapToGround();
  }

  carrier.position.copy(player.position);
  carrier.rotation.y = player.yaw + MODEL_YAW_OFFSET;
  updateFollowCamera();
  updateAnimation(dt);
}

// Looks for ground from STEP_HEIGHT above his feet with a probe just long enough
// to cover this frame's fall, so a running stride stays in contact instead of
// registering as a series of little jumps and landings.
function groundProbe(dt) {
  if (!nearMeshes.length) return null;
  probeOrigin.set(player.position.x, player.position.y + STEP_HEIGHT, player.position.z);
  raycaster.set(probeOrigin, down);
  raycaster.near = 0;
  raycaster.far = STEP_HEIGHT + Math.max(1, Math.abs(verticalVelocity) * dt * 2 + 0.5);
  return raycaster.intersectObjects(nearMeshes, false)[0] ?? null;
}

// Pushes him back out of whatever he has walked into. Pushing along the surface
// normal rather than back down the probe leaves the movement parallel to the
// wall intact, which is what makes him slide along it instead of sticking.
function pushOutOf(direction) {
  let pushed = false;
  for (const height of COLLIDE_HEIGHTS) {
    probeOrigin.set(player.position.x, player.position.y + height, player.position.z);
    raycaster.set(probeOrigin, direction);
    raycaster.near = 0;
    raycaster.far = PLAYER_RADIUS;
    const hit = raycaster.intersectObjects(nearMeshes, false)[0];
    if (!hit) continue;
    player.pushes++;
    if (hit.face) {
      pushNormal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);
      pushNormal.y = 0;
      // Map materials are double-sided, so a face can come back pointing away
      // from us. Keep the side that pushes him out.
      if (pushNormal.lengthSq() < 1e-6 || pushNormal.dot(direction) > 0) pushNormal.copy(direction).negate();
      else pushNormal.normalize();
    } else {
      pushNormal.copy(direction).negate();
    }
    player.position.addScaledVector(pushNormal, PLAYER_RADIUS - hit.distance);
    pushed = true;
  }
  return pushed;
}

function resolveWalls(movement, moving, dt) {
  if (!nearMeshes.length) return;
  if (moving) {
    // Two passes so that sliding into a corner resolves against both faces.
    if (pushOutOf(movement)) pushOutOf(movement);
  }
  // Standing still he cannot walk into anything, but a teleport or a sector
  // streaming in around him can leave him embedded. Sweep every direction
  // occasionally to work back out of that.
  unstickTimer -= dt;
  if (unstickTimer <= 0) {
    unstickTimer = 0.5;
    for (const direction of COLLIDE_DIRECTIONS) pushOutOf(direction);
  }
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
  else if (player.speed < 0.1) setClip(armedClip('idle') ?? 'idle', { fade: 0.22 });
  else {
    let gait = GAITS[1];
    for (const candidate of GAITS) if (candidate.speed > 0 && player.speed >= candidate.speed - 0.01) gait = candidate;
    setClip(armedClip(gait.clip) ?? gait.clip,
      { fade: 0.18, timeScale: THREE.MathUtils.clamp(player.speed / gait.speed, 0.6, 1.6) });
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
  if (event.code === 'Digit1') equipWeapon('PISTOL');
  if (event.code === 'Digit2') equipWeapon('M4');
  if (event.code === 'Digit3') equipWeapon('RLAUNCHER');
  if (event.code === 'Digit0') { weapons?.unequip(); refreshWeaponHud(); }
  if (event.code === 'KeyR') { weapons?.reload(); refreshWeaponHud(); }
  if (event.code === 'KeyG') attackNearestPed();
  if (event.code === 'KeyE') { if (driving.active) exitVehicle(); else enterNearestVehicle(); }
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

addEventListener('mousedown', event => {
  // Left button fires whatever is in hand, while the pointer is captured.
  if (event.button !== 0 || mode === 'overview' || !weapons?.held) return;
  fireWeapon();
});

globalThis.gta4map = {
  THREE, scene, camera, renderer, world, setMode, tuning, lighting, timecycle, character,
  traffic, roadGraph, crowd, navPoints, wanted, police, driving,
  enterNearestVehicle, exitVehicle,
  weapons, equipWeapon, fireWeapon,
  // Places the player on the ground at a point. Used for jumping around the
  // city and by the tests, which need to stand next to a specific car.
  setPlayerPosition: (x, y, z) => {
    player.position.set(x, y, z);
    verticalVelocity = 0;
    snapToGround();
    updateFollowCamera();
    return player.position.toArray();
  },
  setTraffic: enabled => { if (traffic) traffic.enabled = enabled; },
  setCrowd: enabled => { if (crowd) crowd.enabled = enabled; },
  attackNearestPed,
  // Forces a locomotion clip, for tests that need a known stride.
  play: name => { setClip(name, { fade: 0.05 }); return animState; },
  // Freeze or resume the simulation. Rendering continues either way, so a
  // paused world can be looked at from anywhere.
  setPaused: value => { paused = !!value; return paused; },
  isPaused: () => paused,
  // Point the camera at a spot regardless of mode. Only useful while paused,
  // since the walk controller owns the camera otherwise.
  lookAtPoint: (x, y, z, from = [3, 2, 3]) => {
    camera.position.set(x + from[0], y + from[1], z + from[2]);
    camera.lookAt(new THREE.Vector3(x, y, z));
    return camera.position.toArray();
  },
  reportCrime: (crime, options) => { const stars = wanted.report(crime, options); refreshStars(); return stars; },
  clearWanted: () => { wanted.clear(); police?.clear(); refreshStars(); },
  // What the character is currently colliding against, for debugging from the
  // console or a test.
  collisionMeshes: () => nearMeshes,
  // Aims the walk-mode camera without a mouse, for scripted playback and tests.
  look: (yaw, pitch = view.pitch) => { view.yaw = yaw; view.pitch = pitch; },
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
    traffic: traffic ? traffic.getState() : null,
    crowd: crowd ? crowd.getState() : null,
    wanted: wanted.getState(),
    police: police ? police.getState() : null,
    driving: driving.getState(),
    weapons: weapons ? weapons.getState() : null,
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
      commanded: player.commanded,
      travelled: player.travelled,
      pushes: player.pushes,
      nearMeshes: nearMeshes.length,
    } : null,
  }),
};

function frame() {
  requestAnimationFrame(frame);
  timer.update();
  const dt = Math.min(timer.getDelta(), 0.05);
  if (!paused) {
    movePlayer(dt);
    // Traffic populates the area the player occupies in walk mode and the area
    // being looked at otherwise, so it is present in fly-through as well.
    const populationCentre = mode === 'walk' ? player.position : camera.position;
    traffic?.update(dt, populationCentre);
    crowd?.update(dt, populationCentre);
    police?.update(dt, populationCentre);
    if (mode === 'drive') runOverPeds();
    weapons?.update(dt);
    streamTimer -= dt;
    if (streamTimer <= 0) { streamTimer = 1.2; streamSectors(); }
  }
  lighting.follow();
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
