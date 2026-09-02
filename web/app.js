import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DDSLoader } from 'three/addons/loaders/DDSLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { loadPlayer } from './player-model.js';

const ui = {
  loading: document.querySelector('#loading'), status: document.querySelector('#status'), bar: document.querySelector('#bar'),
  mode: document.querySelector('#mode'), sectors: document.querySelector('#sectors'), placements: document.querySelector('#placements'),
  models: document.querySelector('#models'), textures: document.querySelector('#textures'), sectorSelect: document.querySelector('#sector-select'),
  clip: document.querySelector('#clip'),
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
let fallTimer = 0;
let streamTimer = 0;
let initialized = false;

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
// Roughly shoulder width. Collision probes sit above STEP_HEIGHT so kerbs and
// steps are walked up rather than bumped into.
const PLAYER_RADIUS = 0.34;
const STEP_HEIGHT = 0.45;
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
  // Distance the controller asked for versus distance actually covered. They
  // part company exactly when something is in the way, which makes "is he
  // blocked?" answerable without reference to frame rate or wall-clock time.
  commanded: 0,
  travelled: 0,
  pushes: 0,
};
// Camera orbit around the player, driven by the mouse while pointer-locked.
const view = { yaw: 0, pitch: -0.12 };
const focus = new THREE.Vector3();
const cameraOffset = new THREE.Vector3();
const probeOrigin = new THREE.Vector3();
const pushNormal = new THREE.Vector3();
let landTimer = 0;
let unstickTimer = 0;
let animState = 'idle';

// Colliding against every mesh in five loaded sectors, several times a frame,
// is far more than the character needs. Keep a short list of what is actually
// within reach and rebuild it only when he leaves the area it was built for or
// the streamed sectors change.
const NEAR_RADIUS = 14;
let nearMeshes = [];
let sectorEpoch = 0;
let nearEpoch = -1;
const nearOrigin = new THREE.Vector3(Infinity, Infinity, Infinity);

// Sector geometry never moves, so each mesh's world bounding sphere is worth
// computing once and keeping.
function worldSphere(mesh) {
  if (!mesh.userData.worldSphere) {
    if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
    mesh.updateWorldMatrix(true, false);
    mesh.userData.worldSphere = mesh.geometry.boundingSphere.clone().applyMatrix4(mesh.matrixWorld);
  }
  return mesh.userData.worldSphere;
}

function refreshNearMeshes() {
  if (nearEpoch === sectorEpoch && nearOrigin.distanceToSquared(player.position) < 16) return;
  nearEpoch = sectorEpoch;
  nearOrigin.copy(player.position);
  nearMeshes = [];
  for (const record of loaded.values()) {
    if (!record.ready) continue;
    for (const mesh of record.meshes) {
      const sphere = worldSphere(mesh);
      const reach = sphere.radius + NEAR_RADIUS;
      if (sphere.center.distanceToSquared(player.position) < reach * reach) nearMeshes.push(mesh);
    }
  }
}

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
    sectorEpoch++;
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
  // The near list may hold meshes that were just disposed.
  sectorEpoch++;
  updateStats();
}

async function streamSectors(force = false) {
  // In walk mode the camera trails the character, so stream around the
  // character rather than around the lens.
  const reference = mode === 'overview' ? orbit.target : mode === 'walk' ? player.position : camera.position;
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
  const meshes = [...loaded.values()].flatMap(record => record.meshes);
  if (!meshes.length) return false;
  let top = player.position.y;
  for (const { sector } of loaded.values()) top = Math.max(top, sector.bounds.max[1]);
  raycaster.set(new THREE.Vector3(player.position.x, top + 100, player.position.z), down);
  raycaster.near = 0;
  raycaster.far = (top + 100) - player.position.y + 2500;
  const hit = raycaster.intersectObjects(meshes, false)[0];
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
  if (nearMeshes.length) {
    // Pull in rather than let the camera sink through whatever is behind him.
    raycaster.set(focus, cameraOffset);
    raycaster.near = 0;
    raycaster.far = CAMERA_DISTANCE + 0.4;
    const hit = raycaster.intersectObjects(nearMeshes, false)[0];
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
  if (hit && verticalVelocity <= 0 && player.position.y <= hit.point.y) {
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

// Looks for ground from STEP_HEIGHT above his feet, so a kerb or a step within
// that height reads as ground to walk up onto rather than a wall to stop at.
function groundProbe(dt) {
  if (!nearMeshes.length) return null;
  probeOrigin.set(player.position.x, player.position.y + STEP_HEIGHT, player.position.z);
  raycaster.set(probeOrigin, down);
  raycaster.near = 0;
  raycaster.far = STEP_HEIGHT + Math.max(1, Math.abs(verticalVelocity) * dt * 2 + 0.5);
  return raycaster.intersectObjects(nearMeshes, false)[0] ?? null;
}

// Pushes him back out of whatever he has walked into. Sector meshes carry no
// acceleration structure, so a ray that clips a building's bounding sphere
// scans its whole triangle list: probes are the expensive part of the frame and
// are spent only where he is actually heading. Pushing along the surface normal
// rather than back down the probe leaves the movement parallel to the wall
// intact, which is what makes him slide along it instead of sticking.
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
  else if (player.speed < 0.1) setClip('idle', { fade: 0.22 });
  else {
    let gait = GAITS[1];
    for (const candidate of GAITS) if (candidate.speed > 0 && player.speed >= candidate.speed - 0.01) gait = candidate;
    setClip(gait.clip, { fade: 0.18, timeScale: THREE.MathUtils.clamp(player.speed / gait.speed, 0.6, 1.6) });
  }
  ui.clip.textContent = animState;
  mixer.update(dt);
}

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
  THREE, scene, camera, renderer, world, setMode, character,
  // What the character is currently colliding against, for debugging from the
  // console or a test.
  collisionMeshes: () => nearMeshes,
  // Aims the walk-mode camera without a mouse, for scripted playback and tests.
  look: (yaw, pitch = view.pitch) => { view.yaw = yaw; view.pitch = pitch; },
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
      nearMeshes: nearMeshes.length,
      commanded: player.commanded,
      travelled: player.travelled,
      pushes: player.pushes,
    } : null,
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
