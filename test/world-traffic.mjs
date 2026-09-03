import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

// Traffic in the real streamed city, which test/traffic.mjs deliberately does
// not cover — that one draws the road graph as lines so a failure there is the
// path data, never the world.
//
// The check here is the one that cannot be made without the city: do the cars
// actually sit on the road? Path node heights could have been anything, and
// there is no way to know from the graph alone.
//
// One trap worth keeping in mind, because it produced a confident wrong answer
// once: a downward ray from above a car hits that car's own bodywork first and
// reports the road as ~1.4 m above the wheels. Vehicles are tagged
// userData.isVehicle so the probe can skip them.
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
  await page.waitForFunction(() => globalThis.gta4map?.getState().ready, null, { timeout: 120_000 });
  await page.evaluate(() => globalThis.gta4map.setMode('walk'));
  await page.waitForTimeout(13_000);

  const state = await page.evaluate(() => globalThis.gta4map.getState());
  check(state.traffic !== null, 'traffic did not initialise in the world viewer');
  check(state.traffic?.count >= 8, `only ${state.traffic?.count} cars in the city`);
  check(new Set(state.traffic?.models ?? []).size >= 5,
    `only ${new Set(state.traffic?.models ?? []).size} distinct models on the streets`);
  check(state.traffic?.hasGroundProbe === true, 'traffic has no ground probe against the city');
  check(state.traffic?.probesHit > 0, 'the ground probe never hit the city');

  const heights = await page.evaluate(() => {
    const { THREE, scene, traffic } = globalThis.gta4map;
    const cars = traffic?.debugCars?.() ?? [];
    // Everything drawn EXCEPT the vehicles themselves.
    const targets = [];
    scene.traverse(object => {
      if ((object.isMesh || object.isBatchedMesh) && !object.userData?.isVehicle) targets.push(object);
    });
    const ray = new THREE.Raycaster();
    ray.near = 0;
    ray.far = 24;
    const rows = [];
    for (const car of cars) {
      ray.set(new THREE.Vector3(car.position[0], car.position[1] + 3, car.position[2]), new THREE.Vector3(0, -1, 0));
      const hit = ray.intersectObjects(targets, false)[0];
      if (!hit) continue;
      rows.push({ model: car.model, above: car.position[1] - hit.point.y });
    }
    return rows;
  });

  check(heights.length >= 6, `only ${heights.length} cars had any surface beneath them`);
  if (heights.length) {
    const worst = Math.max(...heights.map(row => Math.abs(row.above)));
    // A car's origin is its contact patch, so it should rest on the road.
    check(worst < 0.5, `a car sits ${worst.toFixed(2)}m off the road surface`);
  }

  await page.screenshot({ path: 'artifacts/world-traffic.png' });

  const result = {
    mode: state.mode,
    loadedSectors: state.loadedSectors.length,
    drawCalls: state.drawCalls,
    traffic: {
      count: state.traffic?.count,
      distinctModels: new Set(state.traffic?.models ?? []).size,
      probesHit: state.traffic?.probesHit,
      maxLift: Math.max(...(state.traffic?.lifts ?? [0]).map(Math.abs)),
    },
    carsMeasured: heights.length,
    worstHeightError: heights.length ? Number(Math.max(...heights.map(r => Math.abs(r.above))).toFixed(3)) : null,
    failures,
    messages,
  };
  await writeFile('artifacts/world-traffic.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (failures.length) throw new Error(`World traffic checks failed:\n  ${failures.join('\n  ')}`);
} finally {
  await browser.close();
}
