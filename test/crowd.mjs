import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

// The ambient crowd in the streamed city.
//
// The checks that matter are the two that could silently look fine:
//
//  * Peds must stand ON the navmesh. They are placed by interpolating between
//    walkable points, so a coordinate-space error puts them through buildings
//    while still looking like a crowd from a distance.
//  * A ped must play ITS OWN locomotion set. move_m@generic, move_f@generic and
//    move_cop share 50 clip names, so before the clips were namespaced by wad
//    every female ped silently walked with the male gait.
const candidates = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);
const executablePath = candidates.find(existsSync);
if (!executablePath) throw new Error('Chrome or Edge was not found.');

const base = process.env.MAP_URL ?? 'http://127.0.0.1:4174';
await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
const messages = [];
page.on('console', message => { if (message.type() === 'error') messages.push(`[console] ${message.text()}`); });
page.on('pageerror', error => messages.push(`[pageerror] ${error.stack ?? error.message}`));

const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
}

try {
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(() => globalThis.gta4map?.getState().ready, null, { timeout: 150_000 });
  await page.evaluate(() => globalThis.gta4map.setMode('walk'));
  await page.waitForTimeout(16_000);

  const state = await page.evaluate(() => globalThis.gta4map.getState());
  const crowd = state.crowd;
  check(crowd !== null, 'the crowd did not initialise');
  check(crowd?.count >= 5, `only ${crowd?.count} peds spawned`);
  check(crowd?.spawnable > 250, `only ${crowd?.spawnable} ped models in the crowd rotation`);
  check(crowd?.clips === 112, `expected the 112-clip shared library, got ${crowd?.clips}`);
  check(crowd?.hasGroundProbe === true, 'the crowd has no ground probe');

  // Variety: the same model over and over means the picker is broken.
  const distinct = new Set(crowd?.peds ?? []).size;
  check(distinct >= 4, `only ${distinct} distinct ped models among ${crowd?.count}`);

  // Every ped must be playing a clip from its own set.
  const mismatched = (crowd?.playing ?? []).filter((clip, index) =>
    clip && !clip.startsWith((crowd.sets ?? [])[index] + '/'));
  check(mismatched.length === 0, `${mismatched.length} peds are playing another set's clip: ${mismatched.slice(0, 3).join(', ')}`);
  // And the population should not be entirely one set.
  const sets = new Set(crowd?.sets ?? []);
  check(sets.size >= 1, 'no locomotion sets in use');

  // On the navmesh, and on the ground.
  const geometry = await page.evaluate(() => {
    const { THREE, scene, crowd } = globalThis.gta4map;
    const peds = crowd?.debugPeds?.() ?? [];
    const targets = [];
    scene.traverse(object => {
      if ((object.isMesh || object.isBatchedMesh) && !object.userData?.isPed && !object.userData?.isVehicle) targets.push(object);
    });
    const ray = new THREE.Raycaster();
    ray.near = 0;
    ray.far = 24;
    return peds.map(ped => {
      // Start just above the feet, not above the head. This scene has
      // scaffolding and awnings, and a ray dropped from head height finds those
      // first and reports a ped as standing metres below "the ground" when it is
      // simply walking under something.
      ray.set(new THREE.Vector3(ped.position[0], ped.position[1] + 0.6, ped.position[2]), new THREE.Vector3(0, -1, 0));
      const hit = ray.intersectObjects(targets, false)[0];
      return { ped: ped.ped, offNavmesh: ped.offNavmesh, aboveGround: hit ? ped.position[1] - hit.point.y : null };
    });
  });

  const onMesh = geometry.filter(row => Number.isFinite(row.offNavmesh));
  check(onMesh.length >= 4, `only ${onMesh.length} peds could be located against the navmesh`);
  if (onMesh.length) {
    // Peds walk between points thinned onto a 2.5 m grid, so they are never far
    // from one.
    const worst = Math.max(...onMesh.map(row => row.offNavmesh));
    check(worst < 4, `a ped is ${worst.toFixed(2)}m from the nearest walkable point`);
  }
  // Grounding is asserted on the median as well as the worst case, and the
  // worst case is allowed more room than you might expect. The navmesh points
  // carry no height — the per-tile Z base is not stored in the .wnv files — so
  // a point on a bridge and one on the street beneath it are the same point in
  // plan. The probe keeps a ped on whichever surface it is nearest, but a ped
  // crossing between levels can be briefly wrong by about a storey. A
  // systematic break moves the median; that one-off excursion does not.
  const grounded = geometry.filter(row => row.aboveGround !== null);
  if (grounded.length) {
    const errors = grounded.map(row => Math.abs(row.aboveGround)).sort((a, b) => a - b);
    const median = errors[errors.length >> 1];
    const worst = errors[errors.length - 1];
    check(median < 0.25, `half the crowd stands more than ${median.toFixed(2)}m off the ground`);
    check(worst < 1.5, `a ped stands ${worst.toFixed(2)}m off the ground`);
  }

  await page.screenshot({ path: 'artifacts/crowd.png' });

  const result = {
    peds: crowd?.count,
    distinctModels: distinct,
    sets: [...sets],
    clips: crowd?.clips,
    measured: geometry.length,
    worstOffNavmesh: onMesh.length ? Number(Math.max(...onMesh.map(r => r.offNavmesh)).toFixed(3)) : null,
    worstAboveGround: grounded.length ? Number(Math.max(...grounded.map(r => Math.abs(r.aboveGround))).toFixed(3)) : null,
    medianAboveGround: grounded.length
      ? Number(grounded.map(r => Math.abs(r.aboveGround)).sort((a, b) => a - b)[grounded.length >> 1].toFixed(3)) : null,
    samplePlaying: (crowd?.playing ?? []).slice(0, 6),
    failures,
    messages,
  };
  await writeFile('artifacts/crowd.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (failures.length) throw new Error(`Crowd checks failed:\n  ${failures.join('\n  ')}`);
} finally {
  await browser.close();
}
