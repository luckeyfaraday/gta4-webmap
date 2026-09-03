import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoadGraph } from './road-graph.js';
import { Traffic } from './traffic.js';

// Standalone preview for the road network and the traffic that drives on it.
// The city itself is not loaded — the graph is drawn as lines instead — so this
// isolates the path data and the driving from sector streaming entirely. If
// cars follow the lines here, the only thing left to check in the real world is
// that the lines sit on the roads.
const ui = Object.fromEntries(['max', 'maxValue', 'count', 'spawnable', 'nodes', 'edges', 'junctions']
  .map(id => [id, document.querySelector('#' + id)]));

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d151c);
scene.add(new THREE.HemisphereLight(0xcce1eb, 0x283237, 2.2));
const sun = new THREE.DirectionalLight(0xffe0bd, 2.0);
sun.position.set(-2.5, 4, 3);
scene.add(sun);

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.2, 4000);
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;

const graph = await RoadGraph.load();
ui.nodes.textContent = graph.nodeCount.toLocaleString();
ui.edges.textContent = graph.edgeCount.toLocaleString();
ui.junctions.textContent = graph.stats.junctions.toLocaleString();

// The whole network as one LineSegments — 24k edges is a single draw call.
const linePositions = new Float32Array(graph.edgeCount * 6);
for (let e = 0; e < graph.edgeCount; e++) {
  const a = graph.edges[e * 2];
  const b = graph.edges[e * 2 + 1];
  linePositions[e * 6] = graph.positions[a * 3];
  linePositions[e * 6 + 1] = graph.positions[a * 3 + 1];
  linePositions[e * 6 + 2] = graph.positions[a * 3 + 2];
  linePositions[e * 6 + 3] = graph.positions[b * 3];
  linePositions[e * 6 + 4] = graph.positions[b * 3 + 1];
  linePositions[e * 6 + 5] = graph.positions[b * 3 + 2];
}
const lineGeometry = new THREE.BufferGeometry();
lineGeometry.setAttribute('position', new THREE.BufferAttribute(linePositions, 3));
const roadLines = new THREE.LineSegments(lineGeometry, new THREE.LineBasicMaterial({ color: 0x2f4a5c }));
scene.add(roadLines);

// The spawn focus stands in for the player.
const focus = new THREE.Vector3();
{
  // Start somewhere with plenty of road around it rather than at the origin.
  let best = 0;
  let bestDegree = 0;
  for (let n = 0; n < graph.nodeCount; n += 37) {
    const degree = graph.neighbourStart[n + 1] - graph.neighbourStart[n];
    if (degree > bestDegree) { bestDegree = degree; best = n; }
  }
  graph.node(best, focus);
}

const marker = new THREE.Mesh(
  new THREE.SphereGeometry(2, 16, 12),
  new THREE.MeshBasicMaterial({ color: 0xffcc55, wireframe: true }),
);
scene.add(marker);

const traffic = await Traffic.create(graph, scene, renderer, { maxVehicles: Number(ui.max.value) });
ui.spawnable.textContent = traffic.spawnableCount;
ui.max.addEventListener('input', () => {
  traffic.maxVehicles = Number(ui.max.value);
  ui.maxValue.textContent = ui.max.value;
});
ui.maxValue.textContent = ui.max.value;

const keys = new Set();
addEventListener('keydown', event => keys.add(event.code));
addEventListener('keyup', event => keys.delete(event.code));

function moveFocus(delta) {
  const speed = 40 * delta;
  const forward = new THREE.Vector3();
  camera.getWorldDirection(forward);
  forward.y = 0;
  forward.normalize();
  const right = new THREE.Vector3(-forward.z, 0, forward.x);
  if (keys.has('KeyW')) focus.addScaledVector(forward, speed);
  if (keys.has('KeyS')) focus.addScaledVector(forward, -speed);
  if (keys.has('KeyD')) focus.addScaledVector(right, speed);
  if (keys.has('KeyA')) focus.addScaledVector(right, -speed);
}

function frameCamera() {
  camera.position.set(focus.x + 70, focus.y + 55, focus.z + 70);
  orbit.target.copy(focus);
  orbit.update();
}
frameCamera();

const timer = new THREE.Timer();
function frame() {
  requestAnimationFrame(frame);
  timer.update();
  const delta = Math.min(timer.getDelta(), 0.05);
  moveFocus(delta);
  marker.position.copy(focus);
  orbit.target.copy(focus);
  traffic.update(delta, focus);
  orbit.update();
  renderer.render(scene, camera);
  ui.count.textContent = traffic.count;
}
frame();

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

globalThis.gta4traffic = {
  scene, camera, renderer, graph, traffic, focus,
  setFocus(x, y, z) { focus.set(x, y, z); frameCamera(); },
  getState: () => ({
    ready: true,
    graph: {
      nodes: graph.nodeCount,
      edges: graph.edgeCount,
      junctions: graph.stats.junctions,
      isolated: graph.stats.isolatedNodes,
      dropped: graph.stats.droppedRoadLinks,
      medianSegment: graph.stats.medianSegmentLength,
    },
    traffic: traffic.getState(),
    // Every car's distance from the road it claims to be on, so a driving bug
    // shows up as a number rather than as something to notice by eye.
    focus: focus.toArray(),
  }),
};
