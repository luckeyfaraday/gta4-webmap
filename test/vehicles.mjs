import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

// Checks the exported fleet in a real browser: every model loads, the body is
// articulated on its wheel and door bones, the paint materials take a carcols
// colour, the car sits on the ground and every material resolved its texture.
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
const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: 1 });
const messages = [];
page.on('console', message => messages.push(`[console:${message.type()}] ${message.text()}`));
page.on('pageerror', error => messages.push(`[pageerror] ${error.stack ?? error.message}`));
page.on('requestfailed', request => messages.push(`[requestfailed] ${request.url()} ${request.failure()?.errorText ?? ''}`));

const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
}

// A spread across the shapes the exporter has to get right: a saloon, a
// supercar, the police car with its seven sirens, a two-wheeler, a six-wheeled
// truck and a boat with no wheels at all.
const sample = ['admiral', 'infernus', 'police', 'nrg900', 'trash', 'squalo'];

try {
  await page.goto(`${base}/vehicles.html`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(() => globalThis.gta4vehicles, null, { timeout: 60_000 });
  await page.waitForTimeout(400);

  const first = await page.evaluate(() => globalThis.gta4vehicles.getState());
  check(first.catalogueCount === 127, `expected 127 vehicles in the catalogue, got ${first.catalogueCount}`);

  const report = [];
  for (const model of sample) {
    const found = await page.evaluate(async name => {
      if (!globalThis.gta4vehicles.catalogue.vehicles.some(v => v.model === name)) return null;
      await globalThis.gta4vehicles.show(name);
      return true;
    }, model);
    if (!found) { failures.push(`'${model}' is not in the catalogue`); continue; }
    await page.waitForTimeout(350);

    const state = await page.evaluate(() => globalThis.gta4vehicles.getState());
    check(state.vertices > 5_000, `${model}: only ${state.vertices} vertices`);
    check(state.bones > 8, `${model}: only ${state.bones} bones`);

    // A material may legitimately have no texture when the game itself names
    // one that exists in no dictionary — squalo asks for 'givemechecker', which
    // is GTA IV's own missing-texture placeholder. The exporter records those
    // per model, so the bar is "nothing unexplained", not "nothing at all".
    const allowed = await page.evaluate(name =>
      (globalThis.gta4vehicles.catalogue.vehicles.find(v => v.model === name)?.missingTextures ?? []).length, model);
    check(state.untexturedMaterials <= allowed,
      `${model}: ${state.untexturedMaterials} untextured materials, only ${allowed} explained by missing source textures`);
    check(state.paintMaterials > 0, `${model}: no paintable bodywork`);
    check(state.colourSets > 0, `${model}: no carcols colour sets`);

    // The exporter lifts each vehicle by its true contact point, so a correctly
    // built model rests on y=0 rather than floating or sinking. Measured over
    // real vertices: a bounding box is not usable here, because a wheel node is
    // rotated (by the spin, and on a bike by the fork rake too) and its box
    // dips below the road while every vertex of it is above the road.
    check(Math.abs(state.lowestVertexY) < 0.02,
      `${model}: lowest vertex sits ${state.lowestVertexY.toFixed(4)}m off the ground`);

    const height = state.bounds.max[1] - state.bounds.min[1];
    check(height > 0.5 && height < 5, `${model}: ${height.toFixed(2)}m tall is not a road vehicle`);

    // Wheel bones are joints of the body skin. The preview spins them every
    // frame, so their orientation has to change — which is what proves the rig
    // survived the meshopt pass. Orientation, not position: rotating a node
    // about its own origin leaves that origin where it was.
    let wheelTurn = null;
    if (state.wheels.length) {
      const before = state.wheelQuaternion;
      await page.waitForTimeout(300);
      const after = (await page.evaluate(() => globalThis.gta4vehicles.getState())).wheelQuaternion;
      const dot = Math.abs(before.reduce((sum, value, index) => sum + value * after[index], 0));
      wheelTurn = Number((2 * Math.acos(Math.min(1, dot))).toFixed(4));
      check(wheelTurn > 0.01, `${model}: wheel joint did not turn while spinning (${wheelTurn} rad)`);
    }

    report.push({
      model,
      bones: state.bones,
      vertices: state.vertices,
      wheels: state.wheels.length,
      doors: state.doors.length,
      paintMaterials: state.paintMaterials,
      colourSets: state.colourSets,
      groundY: Number(state.lowestVertexY.toFixed(4)),
      height: Number(height.toFixed(3)),
      wheelTurn,
    });
    await page.screenshot({ path: `artifacts/vehicle-${model}.png` });
  }

  const result = { catalogue: first.catalogueCount, sampled: report, failures, messages };
  await writeFile('artifacts/vehicles.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (failures.length) throw new Error(`Vehicle checks failed:\n  ${failures.join('\n  ')}`);
} finally {
  await browser.close();
}
