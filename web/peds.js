import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadPed, loadClips, loadCatalogue } from './ped-model.js';

// Standalone preview for the exported population, the crowd counterpart to
// player.html and vehicles.html. It loads only assets/peds/, so it runs without
// the streamed world and is the quickest way to check that a ped is assembled,
// textured and driven by the shared clip library.
const ui = Object.fromEntries(['ped', 'clip', 'title', 'bones', 'vertices', 'components', 'height', 'population']
  .map(id => [id, document.querySelector('#' + id)]));

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8497a3);
scene.add(new THREE.HemisphereLight(0xcce1eb, 0x283237, 1.9));
const sun = new THREE.DirectionalLight(0xffe0bd, 2.1);
sun.position.set(-2.5, 4, 3);
scene.add(sun);
const ground = new THREE.Mesh(new THREE.CircleGeometry(6, 48), new THREE.MeshStandardMaterial({ color: 0x2a3339, roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.05, 200);
camera.position.set(2.1, 1.35, 2.6);
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.target.set(0, 0.95, 0);
orbit.enableDamping = true;
orbit.update();

const catalogue = await loadCatalogue();
const clips = await loadClips(`./assets/peds/${catalogue.animations}`);
const byName = new Map(catalogue.peds.map(entry => [entry.ped, entry]));
for (const entry of catalogue.peds) {
  const option = document.createElement('option');
  option.value = option.textContent = entry.ped;
  ui.ped.append(option);
}
for (const clip of [...clips].sort((a, b) => a.name.localeCompare(b.name))) {
  const option = document.createElement('option');
  option.value = option.textContent = clip.name;
  ui.clip.append(option);
}
ui.population.textContent = catalogue.count;

let current = null;
let currentEntry = null;
let mixer = null;
let action = null;

// Clips are namespaced by their source wad, because move_m@generic,
// move_f@generic and move_cop share 50 names — "walk" and "idle" among them.
// A ped has to be given its own set or it walks with someone else's gait.
function setFor(entry) {
  if (/_cop|_swat|_fbi/i.test(entry.ped)) return 'cop';
  return entry.sex === 'f' ? 'f@generic' : 'm@generic';
}

function play(name) {
  const clip = clips.find(item => item.name === name);
  if (!clip || !mixer) return false;
  const next = mixer.clipAction(clip);
  next.reset().setLoop(THREE.LoopRepeat, Infinity).play();
  if (action && action !== next) action.crossFadeTo(next, 0.25, false);
  action = next;
  ui.clip.value = name;
  return true;
}

async function show(name) {
  const entry = byName.get(name);
  if (!entry) return;
  if (current) scene.remove(current.root);
  const ped = await loadPed(`./assets/peds/${entry.gltf}`, renderer, { clone: true });
  current = ped;
  currentEntry = entry;
  action = null;
  scene.add(ped.root);

  // One mixer per ped, but the clips themselves are the shared library — they
  // bind by node name, and every ped's bones carry the same canonical names.
  mixer = new THREE.AnimationMixer(ped.root);
  const set = setFor(entry);
  // Keep the clip the user picked if this ped's set also has it.
  const chosen = ui.clip.value?.split('/').slice(1).join('/') || 'walk';
  play(clips.find(c => c.name === `${set}/${chosen}`)?.name
    ?? clips.find(c => c.name === `${set}/walk`)?.name
    ?? clips[0]?.name);

  const box = new THREE.Box3().setFromObject(ped.root);
  ui.title.textContent = entry.ped;
  ui.bones.textContent = ped.bones;
  ui.vertices.textContent = ped.vertices.toLocaleString();
  ui.components.textContent = entry.components.length;
  ui.height.textContent = `${(box.max.y - box.min.y).toFixed(2)} m`;
  ui.ped.value = name;
}

ui.ped.addEventListener('change', () => show(ui.ped.value));
ui.clip.addEventListener('change', () => play(ui.clip.value));
addEventListener('keydown', event => {
  if (event.key !== 'n' && event.key !== 'N') return;
  const index = catalogue.peds.findIndex(entry => entry.ped === currentEntry.ped);
  show(catalogue.peds[(index + 1) % catalogue.peds.length].ped);
});

await show(catalogue.peds[0].ped);

const timer = new THREE.Timer();
function frame() {
  requestAnimationFrame(frame);
  timer.update();
  mixer?.update(Math.min(timer.getDelta(), 0.05));
  orbit.update();
  renderer.render(scene, camera);
}
frame();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

globalThis.gta4peds = {
  scene, camera, renderer, catalogue, clips, show, play,
  get current() { return current; },
  getState: () => {
    const box = new THREE.Box3().setFromObject(current.root);
    return {
      ready: true,
      ped: currentEntry.ped,
      bones: current.bones,
      vertices: current.vertices,
      components: currentEntry.components,
      untexturedMaterials: current.untextured,
      clips: clips.length,
      playing: action?.getClip().name ?? null,
      set: setFor(currentEntry),
      population: catalogue.count,
      bounds: { min: box.min.toArray(), max: box.max.toArray() },
      // Ground contact needs the exact lowest vertex; see ped-model.js for why
      // a bounding box reads a skinned ped one foot-offset too high.
      lowestVertexY: current.lowestVertexY(),
      // A joint that has moved away from its bind position proves the shared
      // clips are actually driving this ped's own skeleton.
      probePosition: current.probeBone?.getWorldPosition(new THREE.Vector3()).toArray() ?? null,
    };
  },
};
