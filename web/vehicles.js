import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadVehicle, loadCatalogue } from './vehicle-model.js';

// Standalone preview for the exported fleet, the vehicle counterpart to
// player.html. It loads only assets/vehicles/, so it runs without the streamed
// world and is the quickest way to check a model's geometry, its paint sets and
// that its wheels and doors are articulated.
const ui = Object.fromEntries(['model', 'respray', 'title', 'bones', 'vertices', 'parts', 'drive', 'speed', 'colours']
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
const ground = new THREE.Mesh(new THREE.CircleGeometry(12, 64), new THREE.MeshStandardMaterial({ color: 0x2a3339, roughness: 1 }));
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.05, 400);
camera.position.set(4.6, 2.3, 5.4);
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.target.set(0, 0.7, 0);
orbit.enableDamping = true;
orbit.update();

const catalogue = await loadCatalogue();
const byModel = new Map(catalogue.vehicles.map(entry => [entry.model, entry]));
for (const entry of catalogue.vehicles) {
  const option = document.createElement('option');
  option.value = entry.model;
  option.textContent = `${entry.model} — ${entry.name}`;
  ui.model.append(option);
}

let current = null;
let currentEntry = null;

// carcols gives index triples into the shared palette; the first is the body.
function respray() {
  if (!current || !currentEntry?.colourSets?.length) return null;
  const set = currentEntry.colourSets[Math.floor(Math.random() * currentEntry.colourSets.length)];
  const colour = catalogue.palette[set[0]];
  if (!colour) return null;
  current.paint(colour.rgb);
  return colour;
}

async function show(model) {
  const entry = byModel.get(model);
  if (!entry) return;
  if (current) scene.remove(current.root);
  const vehicle = await loadVehicle(`./assets/vehicles/${entry.gltf}`, renderer, { clone: true });
  current = vehicle;
  currentEntry = entry;
  scene.add(vehicle.root);
  respray();

  ui.title.textContent = entry.name || entry.model;
  ui.bones.textContent = vehicle.bones;
  ui.vertices.textContent = vehicle.vertices.toLocaleString();
  ui.parts.textContent = `${entry.wheels.length} / ${entry.seats.length}`;
  ui.drive.textContent = entry.handling ? { R: 'rear', F: 'front', 4: 'all' }[entry.handling.drive] ?? '—' : '—';
  ui.speed.textContent = entry.handling ? `${entry.handling.topSpeed} km/h` : '—';
  ui.colours.textContent = entry.colourSets.length;

  const box = new THREE.Box3().setFromObject(vehicle.root);
  orbit.target.set(0, (box.max.y - box.min.y) / 2, 0);
  orbit.update();
}

ui.model.addEventListener('change', () => show(ui.model.value));
ui.respray.addEventListener('click', respray);
addEventListener('keydown', event => {
  if (event.key === 'r' || event.key === 'R') respray();
  if (event.key === 'd' || event.key === 'D') current?.openDoor('door_dside_f', doorOpen ? 0 : -1.1), (doorOpen = !doorOpen);
});
let doorOpen = false;

await show(catalogue.vehicles[0].model);

const timer = new THREE.Timer();
let spin = 0;
function frame() {
  requestAnimationFrame(frame);
  timer.update();
  // Roll the wheels so the articulation is visible at a glance.
  spin += timer.getDelta() * 3;
  current?.spin(spin);
  orbit.update();
  renderer.render(scene, camera);
}
frame();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

globalThis.gta4vehicles = {
  scene, camera, renderer, catalogue, show, respray,
  get current() { return current; },
  get entry() { return currentEntry; },
  getState: () => {
    const box = new THREE.Box3().setFromObject(current.root);
    return {
      ready: true,
      model: currentEntry.model,
      bones: current.bones,
      vertices: current.vertices,
      untexturedMaterials: current.untextured,
      wheels: current.wheels.map(wheel => wheel.name),
      doors: current.doors.map(door => door.name),
      paintMaterials: current.paintMaterials.length,
      colourSets: currentEntry.colourSets.length,
      // Box3 for the overall size — good enough, and cheap.
      bounds: { min: box.min.toArray(), max: box.max.toArray() },
      // Ground contact needs the exact lowest vertex instead; see
      // vehicle-model.js for why a bounding box cannot answer it.
      lowestVertexY: current.lowestVertexY(),
      // A wheel bone's world orientation proves the joints are really being
      // driven. Its world *position* would not: rotating a node about its own
      // origin leaves that origin exactly where it was.
      wheelQuaternion: current.wheels[0]?.getWorldQuaternion(new THREE.Quaternion()).toArray() ?? null,
      catalogueCount: catalogue.count,
    };
  },
};
