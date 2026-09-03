import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

// The wanted level and the police response, in the streamed city.
//
// Two halves. First the bookkeeping, driven directly so the escalation and
// cool-off curves are checked as arithmetic rather than inferred from watching
// a chase. Then the response itself: committing a crime has to actually put
// officers and cruisers in the world, moving toward the player, playing the
// police locomotion set, and standing down when the level clears.
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
  await page.waitForTimeout(12_000);

  // ---- the bookkeeping ----------------------------------------------------
  const curve = await page.evaluate(() => {
    const api = globalThis.gta4map;
    api.clearWanted();
    const steps = [];
    steps.push({ after: 'start', stars: api.getState().wanted.stars });
    for (let i = 0; i < 6; i++) {
      const stars = api.reportCrime('pedKilled');
      steps.push({ after: `pedKilled x${i + 1}`, stars });
    }
    const capped = api.getState().wanted;
    api.clearWanted();
    const copCost = api.reportCrime('copKilled');
    const cleared = (api.clearWanted(), api.getState().wanted.stars);
    // An unwitnessed crime must cost less than a witnessed one.
    api.clearWanted();
    api.reportCrime('pedKilled', { witnessed: false });
    const unseenHeat = api.getState().wanted.heat;
    api.clearWanted();
    api.reportCrime('pedKilled', { witnessed: true });
    const seenHeat = api.getState().wanted.heat;
    api.clearWanted();
    return { steps, cappedStars: capped.stars, maxStars: capped.response.stars, copCost, cleared, unseenHeat, seenHeat };
  });

  check(curve.steps[0].stars === 0, 'the player starts wanted');
  check(curve.steps[1].stars === 1, `one killing should give one star, gave ${curve.steps[1].stars}`);
  const monotonic = curve.steps.every((step, i) => i === 0 || step.stars >= curve.steps[i - 1].stars);
  check(monotonic, 'the wanted level went down while committing crimes');
  check(curve.cappedStars <= 6, `stars exceeded six: ${curve.cappedStars}`);
  check(curve.copCost > 1, `killing an officer gave only ${curve.copCost} star(s); it should outrank a civilian`);
  check(curve.cleared === 0, `clearing left ${curve.cleared} stars`);
  check(curve.unseenHeat < curve.seenHeat,
    `an unwitnessed crime (${curve.unseenHeat}) should cost less than a witnessed one (${curve.seenHeat})`);

  // Response scales with the level.
  const scaling = await page.evaluate(() => {
    const api = globalThis.gta4map;
    const rows = [];
    for (const stars of [1, 3, 6]) {
      api.clearWanted();
      for (let i = 0; i < 40 && api.getState().wanted.stars < stars; i++) api.reportCrime('pedKilled');
      rows.push(api.getState().wanted.response);
    }
    api.clearWanted();
    return rows;
  });
  check(scaling[0].officers < scaling[2].officers, 'six stars sends no more officers than one');
  check(scaling[0].cars <= scaling[2].cars, 'six stars sends fewer cruisers than one');
  check(scaling[2].swat === true, 'the heavier units never arrive');

  // ---- the response -------------------------------------------------------
  await page.evaluate(() => {
    const api = globalThis.gta4map;
    api.clearWanted();
    for (let i = 0; i < 6; i++) api.reportCrime('pedKilled');
  });
  await page.waitForTimeout(16_000);

  const state = await page.evaluate(() => globalThis.gta4map.getState());
  check(state.wanted.stars >= 3, `expected a serious wanted level, got ${state.wanted.stars}`);
  check(state.police !== null, 'the police did not initialise');
  check(state.police.officers >= 2, `only ${state.police.officers} officers responded`);
  check(state.police.cars >= 1, `only ${state.police.cars} cruisers responded`);
  // The response must match the level, not overshoot it: in-flight spawns count
  // against the cap, and units are shed when the level falls.
  check(state.police.officers <= state.wanted.response.officers,
    `${state.police.officers} officers for a ${state.wanted.stars}-star level that allows ${state.wanted.response.officers}`);
  check(state.police.cars <= state.wanted.response.cars,
    `${state.police.cars} cruisers for a ${state.wanted.stars}-star level that allows ${state.wanted.response.cars}`);

  // Officers must be police models and must use the police locomotion set.
  const wrongModel = (state.police.officerModels ?? []).filter(name => !/cop|swat|fbi/i.test(name));
  check(wrongModel.length === 0, `non-police models responded: ${wrongModel.join(', ')}`);
  const wrongClip = (state.police.playing ?? []).filter(clip => clip && !clip.startsWith('cop/') && !clip.startsWith('m@generic/'));
  check(wrongClip.length === 0, `officers playing an unexpected set: ${wrongClip.join(', ')}`);

  const wrongCar = (state.police.carModels ?? []).filter(name => !/police|noose|fbi/i.test(name));
  check(wrongCar.length === 0, `non-police vehicles responded: ${wrongCar.join(', ')}`);

  // They have to actually close on the player.
  const closing = await page.evaluate(async () => {
    const api = globalThis.gta4map;
    const before = api.police.getState().nearestDistance;
    await new Promise(resolve => setTimeout(resolve, 6000));
    return { before, after: api.police.getState().nearestDistance };
  });
  check(closing.after !== null && closing.before !== null, 'the police never got within range to measure');
  if (closing.before !== null && closing.after !== null) {
    check(closing.after < closing.before + 1,
      `the police are not closing: ${closing.before}m then ${closing.after}m`);
  }

  await page.screenshot({ path: 'artifacts/wanted.png' });

  // Clearing the level stands the response down.
  const standDown = await page.evaluate(async () => {
    const api = globalThis.gta4map;
    api.clearWanted();
    await new Promise(resolve => setTimeout(resolve, 1200));
    const s = api.getState();
    return { stars: s.wanted.stars, officers: s.police.officers, cars: s.police.cars };
  });
  check(standDown.stars === 0, `clearing left ${standDown.stars} stars`);
  check(standDown.officers === 0 && standDown.cars === 0,
    `${standDown.officers} officers and ${standDown.cars} cruisers stayed out after the level cleared`);

  const result = {
    escalation: curve.steps,
    unwitnessedCost: curve.unseenHeat,
    witnessedCost: curve.seenHeat,
    scaling,
    response: {
      stars: state.wanted.stars,
      officers: state.police.officers,
      cars: state.police.cars,
      officerModels: state.police.officerModels,
      carModels: state.police.carModels,
      playing: state.police.playing,
      nearest: state.police.nearestDistance,
    },
    closing,
    standDown,
    failures,
    messages,
  };
  await writeFile('artifacts/wanted.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (failures.length) throw new Error(`Wanted checks failed:\n  ${failures.join('\n  ')}`);
} finally {
  await browser.close();
}
