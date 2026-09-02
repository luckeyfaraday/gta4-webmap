import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

// Checks the exported character in a real browser: the skeleton arrives, the
// skin is driven by the clips, the feet land on the ground and every material
// resolved its texture.
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

try {
  await page.goto(`${base}/player.html`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(() => globalThis.gta4player, null, { timeout: 60_000 });
  await page.waitForTimeout(400);

  const state = await page.evaluate(() => globalThis.gta4player.getState());
  check(state.bones === 90, `expected 90 bones, got ${state.bones}`);
  check(state.vertices > 10_000, `expected >10k vertices, got ${state.vertices}`);
  check(state.untexturedMaterials === 0, `${state.untexturedMaterials} materials have no texture`);

  for (const clip of ['idle', 'walk', 'run', 'sprint', 'jump_takeoff_r', 'jump_inair_r', 'jump_land_r']) {
    check(state.clips.includes(clip), `missing clip '${clip}'`);
  }

  const height = state.bounds.max[1] - state.bounds.min[1];
  check(height > 1.6 && height < 2.05, `character height ${height.toFixed(2)}m is not human-sized`);
  check(Math.abs(state.bounds.min[1]) < 0.06, `feet are ${state.bounds.min[1].toFixed(3)}m off the ground`);

  // Sample one hand joint across a walk cycle. If skinning is wired up the
  // joint moves; a scrambled or static bind would leave it put.
  await page.evaluate(() => globalThis.gta4player.play('walk'));
  await page.waitForTimeout(120);
  const first = await page.evaluate(() => globalThis.gta4player.getState().handPosition);
  await page.waitForTimeout(420);
  const second = await page.evaluate(() => globalThis.gta4player.getState().handPosition);
  const travel = Math.hypot(...first.map((value, index) => value - second[index]));
  check(travel > 0.05, `hand joint moved only ${travel.toFixed(4)}m during 'walk'`);

  await page.waitForTimeout(400);
  await page.screenshot({ path: 'artifacts/player-walk.png' });
  await page.evaluate(() => globalThis.gta4player.play('idle'));
  await page.waitForTimeout(700);
  await page.screenshot({ path: 'artifacts/player-idle.png' });
  await page.evaluate(() => globalThis.gta4player.play('jump_inair_r'));
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'artifacts/player-jump.png' });

  const result = {
    bones: state.bones,
    vertices: state.vertices,
    clips: state.clips.length,
    height: Number(height.toFixed(3)),
    feetY: Number(state.bounds.min[1].toFixed(4)),
    handTravel: Number(travel.toFixed(4)),
    untexturedMaterials: state.untexturedMaterials,
    failures,
    messages,
  };
  await writeFile('artifacts/player.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (failures.length) throw new Error(`Player checks failed:\n  ${failures.join('\n  ')}`);
} finally {
  await browser.close();
}
