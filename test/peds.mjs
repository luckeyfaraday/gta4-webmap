import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

// Checks the exported population in a real browser: peds load, they are
// assembled from their components, every material resolved its texture, they
// stand on the ground, and — the point of the whole design — the ONE shared clip
// library drives each of them, whatever ped it was authored against.
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
const page = await browser.newPage({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 1 });
const messages = [];
page.on('console', message => messages.push(`[console:${message.type()}] ${message.text()}`));
page.on('pageerror', error => messages.push(`[pageerror] ${error.stack ?? error.message}`));
page.on('requestfailed', request => messages.push(`[requestfailed] ${request.url()} ${request.failure()?.errorText ?? ''}`));

const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
}

// A male, a female and a cop: the three locomotion sets, and the peds most
// likely to be spawned by a wanted system.
const sample = ['m_y_business_01', 'f_y_hooker_01', 'm_y_cop', 'm_y_swat'];

try {
  await page.goto(`${base}/peds.html`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(() => globalThis.gta4peds, null, { timeout: 90_000 });
  await page.waitForTimeout(400);

  const first = await page.evaluate(() => globalThis.gta4peds.getState());
  check(first.population > 300, `expected the full population, got ${first.population}`);
  check(first.clips > 90, `expected the shared clip library, got ${first.clips} clips`);

  // The clips exist once and drive everyone, and they are namespaced by their
  // source wad: move_m@generic, move_f@generic and move_cop share 50 names, so
  // a bare "walk" would resolve to whichever wad happened to load first and
  // every female ped would silently inherit the male gait.
  const clipNames = await page.evaluate(() => globalThis.gta4peds.clips.map(c => c.name));
  for (const wanted of ['m@generic/walk', 'f@generic/walk', 'cop/walk',
                        'm@generic/run', 'f@generic/run', 'm@generic/sprint']) {
    check(clipNames.includes(wanted), `shared library is missing the '${wanted}' clip`);
  }
  check(new Set(clipNames).size === clipNames.length,
    `${clipNames.length - new Set(clipNames).size} clip names collide in the shared library`);

  const report = [];
  for (const ped of sample) {
    const found = await page.evaluate(async name => {
      if (!globalThis.gta4peds.catalogue.peds.some(p => p.ped === name)) return null;
      await globalThis.gta4peds.show(name);
      // Ask for walk in this ped's own set, by name, so the check below is
      // measuring the clip we intend and not whatever the dropdown defaults to.
      const set = globalThis.gta4peds.getState().set;
      // Idle first: ground contact is measured in a resting pose, because
      // mid-stride the planted foot is not flat and the lowest vertex sits a
      // few centimetres high through no fault of the export.
      globalThis.gta4peds.play(`${set}/idle`);
      return true;
    }, ped);
    if (!found) { failures.push(`'${ped}' is not in the catalogue`); continue; }
    await page.waitForTimeout(250);

    const state = await page.evaluate(() => globalThis.gta4peds.getState());
    check(state.bones === 80, `${ped}: expected the 80-bone standard skeleton, got ${state.bones}`);
    check(state.vertices > 1_000, `${ped}: only ${state.vertices} vertices`);
    check(state.untexturedMaterials === 0, `${ped}: ${state.untexturedMaterials} materials have no texture`);

    // Every ped needs a head and something on each half of the body; the
    // classifier used to mislabel a component and drop the head entirely.
    const slots = state.components.map(name => name.split('_')[0]);
    for (const slot of ['head', 'uppr', 'lowr']) {
      check(slots.includes(slot), `${ped}: no '${slot}' component (has ${slots.join(', ')})`);
    }

    const height = state.bounds.max[1] - state.bounds.min[1];
    check(height > 1.4 && height < 2.2, `${ped}: ${height.toFixed(2)}m is not human-sized`);
    // Measured over skinned vertices, not from a bounding box — see
    // ped-model.js for why Box3 reads a bound skeleton one foot-offset high.
    check(Math.abs(state.lowestVertexY) < 0.08,
      `${ped}: feet are ${state.lowestVertexY.toFixed(3)}m off the ground`);

    // Each ped must be playing a clip from its OWN locomotion set.
    check(state.playing?.startsWith(state.set + '/'),
      `${ped}: is playing '${state.playing}' but belongs to the '${state.set}' set`);

    // Now walk, and confirm the shared clip actually drives this ped's own
    // skeleton. The library binds by node name, so a canonical-BoneID slip
    // would leave the joint sitting still.
    await page.evaluate(set => globalThis.gta4peds.play(`${set}/walk`), state.set);
    await page.waitForTimeout(300);
    const before = (await page.evaluate(() => globalThis.gta4peds.getState())).probePosition;
    await page.waitForTimeout(420);
    const after = (await page.evaluate(() => globalThis.gta4peds.getState())).probePosition;
    const travel = Math.hypot(...before.map((value, index) => value - after[index]));
    check(travel > 0.02, `${ped}: shared 'walk' clip did not move the probe joint (${travel.toFixed(4)}m)`);

    report.push({
      ped,
      bones: state.bones,
      vertices: state.vertices,
      components: state.components,
      height: Number(height.toFixed(3)),
      feetY: Number(state.lowestVertexY.toFixed(4)),
      jointTravel: Number(travel.toFixed(4)),
    });
    await page.screenshot({ path: `artifacts/ped-${ped}.png` });
  }

  const result = { population: first.population, clips: first.clips, sampled: report, failures, messages };
  await writeFile('artifacts/peds.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (failures.length) throw new Error(`Ped checks failed:\n  ${failures.join('\n  ')}`);
} finally {
  await browser.close();
}
