import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadPlayer } from './player-model.js';

// Standalone preview for the exported character. It loads only
// assets/player/player.gltf, so it runs without the streamed world and is the
// quickest way to check the skeleton, the skinning and every clip.
const ui = {
  clip: document.querySelector('#clip'), bones: document.querySelector('#bones'),
  vertices: document.querySelector('#vertices'), clips: document.querySelector('#clips'),
  height: document.querySelector('#height'),
};

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

const character = await loadPlayer('./assets/player/player.gltf', renderer);
scene.add(character.root);

const mixer = new THREE.AnimationMixer(character.root);
const actions = new Map(character.clips.map(clip => [clip.name, mixer.clipAction(clip)]));
let current = null;

for (const name of [...actions.keys()].sort()) {
  const option = document.createElement('option');
  option.value = option.textContent = name;
  ui.clip.append(option);
}

function play(name) {
  const next = actions.get(name);
  if (!next || next === current) return false;
  next.reset().setLoop(THREE.LoopRepeat, Infinity).play();
  if (current) current.crossFadeTo(next, 0.25, false);
  current = next;
  ui.clip.value = name;
  return true;
}

ui.clip.addEventListener('change', () => play(ui.clip.value));
play(actions.has('idle') ? 'idle' : character.clips[0]?.name);

const bounds = new THREE.Box3().setFromObject(character.root);
ui.bones.textContent = character.bones;
ui.vertices.textContent = character.vertices.toLocaleString();
ui.clips.textContent = character.clips.length;
ui.height.textContent = `${(bounds.max.y - bounds.min.y).toFixed(2)} m`;

const timer = new THREE.Timer();
function frame() {
  requestAnimationFrame(frame);
  timer.update();
  mixer.update(Math.min(timer.getDelta(), 0.05));
  orbit.update();
  renderer.render(scene, camera);
}
frame();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

globalThis.gta4player = {
  scene, camera, renderer, character, mixer, play,
  getState: () => {
    const box = new THREE.Box3().setFromObject(character.root);
    return {
      ready: true,
      bones: character.bones,
      vertices: character.vertices,
      clips: character.clips.map(clip => clip.name),
      playing: current?.getClip().name ?? null,
      // Bind-pose feet sit at the origin, so this doubles as a check that the
      // export lands the character on the ground rather than through it.
      bounds: { min: box.min.toArray(), max: box.max.toArray() },
      untexturedMaterials: character.untextured,
      // A joint that has moved away from its bind position proves the skin is
      // actually being driven by the animation.
      handPosition: character.probeBone?.getWorldPosition(new THREE.Vector3()).toArray() ?? null,
    };
  },
};

