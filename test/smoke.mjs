import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const candidates = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);
const executablePath = candidates.find(existsSync);
if (!executablePath) throw new Error('Chrome or Edge was not found.');

// A sector is listed as loaded as soon as its geometry arrives, but its
// textures are applied afterwards and it stays hidden until they land. Wait for
// that to drain before capturing, or screenshots catch a half-dressed world.
async function settle(page) {
  await page.waitForFunction(() => globalThis.gta4map.getState().pendingSectors.length === 0, null, { timeout: 300_000 });
  await page.waitForTimeout(750);
}

await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const messages = [];
page.on('console', message => messages.push(`[console:${message.type()}] ${message.text()}`));
page.on('pageerror', error => messages.push(`[pageerror] ${error.stack ?? error.message}`));
page.on('requestfailed', request => messages.push(`[requestfailed] ${request.url()} ${request.failure()?.errorText ?? ''}`));

try {
  await page.goto(process.env.MAP_URL ?? 'http://127.0.0.1:4174', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(() => globalThis.gta4map, null, { timeout: 120_000 });
  await page.waitForFunction(() => globalThis.gta4map.getState().ready, null, { timeout: 180_000 });
  await settle(page);
  const initialCamera = await page.evaluate(() => globalThis.gta4map.getState().camera);
  await page.mouse.move(720, 450);
  await page.mouse.down();
  await page.mouse.move(850, 390, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(750);
  let state = await page.evaluate(() => globalThis.gta4map.getState());
  if (state.camera.every((value, index) => Math.abs(value - initialCamera[index]) < 0.01)) {
    throw new Error('OrbitControls did not move the camera.');
  }
  await page.screenshot({ path: 'artifacts/map-overview.png', fullPage: true });

  await page.click('[data-mode="fly"]');
  const beforeFly = await page.evaluate(() => globalThis.gta4map.getState().camera);
  await page.keyboard.down('w');
  await page.waitForTimeout(600);
  await page.keyboard.up('w');
  const afterFly = await page.evaluate(() => globalThis.gta4map.getState().camera);
  if (afterFly.every((value, index) => Math.abs(value - beforeFly[index]) < 0.01)) throw new Error('Fly movement did not move the camera.');
  await page.keyboard.press('f');
  await page.waitForFunction(() => globalThis.gta4map.getState().mode === 'walk');
  await page.keyboard.down('w');
  await page.waitForTimeout(300);
  await page.keyboard.up('w');
  await page.keyboard.press('Escape');
  await page.screenshot({ path: 'artifacts/map-walk.png', fullPage: true });

  // Clicking the overview button while pointer lock is active routes the click
  // back to the canvas, so drive the mode change through the viewer API.
  await page.evaluate(() => globalThis.gta4map.setMode('overview'));
  await page.waitForFunction(() => globalThis.gta4map.getState().mode === 'overview');
  await page.locator('#sector-select').selectOption('nj_05', { force: true });
  await page.waitForFunction(() => globalThis.gta4map.getState().loadedSectors.includes('nj_05'), null, { timeout: 180_000 });
  await settle(page);
  await page.screenshot({ path: 'artifacts/map-alderney.png', fullPage: true });
  state = await page.evaluate(() => globalThis.gta4map.getState());

  // The camera must end up looking at Alderney from above it, not below a world
  // it fell through while the sector was still streaming in.
  const alderney = await page.evaluate(() => globalThis.gta4map.world.sectors.find(sector => sector.id === 'nj_05').bounds);
  const aboveGround = state.camera[1] > alderney.min[1];
  if (!aboveGround) throw new Error(`Camera fell below Alderney: y=${state.camera[1]} < ${alderney.min[1]}`);

  // Sector geometry is drawn by BatchedMeshes that sample a texture array, so
  // the old per-material `.map` check no longer sees the city at all - it has to
  // ask whether each batch got a built array. Anything still carrying a plain
  // `userData.texture` (the player model) is checked the original way.
  const untextured = await page.evaluate(() => {
    let total = 0, missing = 0, batches = 0, emptyBatches = 0;
    globalThis.gta4map.scene.traverse(object => {
      if (!object.isMesh) return;
      for (const material of [object.material].flat()) {
        if (material?.userData?.batch) {
          batches++;
          const array = material.userData.batch.array;
          if (!array?.image?.depth) emptyBatches++;
          continue;
        }
        if (!material?.userData?.texture) continue;
        total++;
        if (!material.map) missing++;
      }
    });
    return { total, missing, batches, emptyBatches };
  });
  if (untextured.missing > 0) throw new Error(`${untextured.missing}/${untextured.total} materials are still untextured.`);
  if (untextured.batches === 0) throw new Error('No batched sector geometry is in the scene.');
  if (untextured.emptyBatches > 0) throw new Error(`${untextured.emptyBatches}/${untextured.batches} batches have no texture array.`);

  const result = { state, untextured, interaction: { orbitChangedCamera: true, flyMovedCamera: true, walkModeEntered: true, alderneyLoaded: true, aboveGround: true }, messages };
  await writeFile('artifacts/smoke.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
