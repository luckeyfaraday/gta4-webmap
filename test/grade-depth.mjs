// Checks that the grade's near/far split is actually driven by scene depth.
//
// timecyc.dat grades near and far geometry differently (CLOUDY midday is
// Desaturation 0.25 near, 1.00 far, blended between 16m and 128m), which only
// works if the depth texture reaches the pass. EffectComposer ping-pongs
// between two render targets and clone() gives the second its own depth
// attachment, so this regressed silently once already.
//
// Method: force a strongly contrasting near/far grade, then push the blend
// range far past the scene and far below it. If depth is being read the two
// frames differ; if tDepth is dead they are byte-identical.
// Run by hand: node test/grade-depth.mjs
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const candidates = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);
const executablePath = candidates.find(existsSync);
if (!executablePath) throw new Error('Chrome or Edge was not found.');

await mkdir('artifacts/grade', { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });

// Mean saturation of the frame, as a single number to compare.
const saturation = shot => page.evaluate(async url => {
  const image = await createImageBitmap(await (await fetch(url)).blob());
  const canvas = new OffscreenCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, image.width, image.height);
  let total = 0, n = 0;
  // Skip the right-hand HUD panel, which never changes.
  for (let i = 0; i < data.length; i += 4 * 7) {
    const x = (i / 4) % image.width;
    if (x > image.width * 0.72) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    total += max === 0 ? 0 : (max - min) / max;
    n++;
  }
  return total / n;
}, 'data:image/png;base64,' + shot.toString('base64'));

try {
  await page.goto(process.env.MAP_URL ?? 'http://127.0.0.1:4174', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(() => globalThis.gta4map?.getState().ready, null, { timeout: 300_000 });
  await page.waitForFunction(() => globalThis.gta4map.getState().pendingSectors.length === 0, null, { timeout: 300_000 });
  await page.evaluate(() => {
    const map = globalThis.gta4map;
    const { min, max } = map.world.sectors.find(sector => sector.id === 'manhat01').bounds;
    const centre = [0, 1, 2].map(axis => (min[axis] + max[axis]) / 2);
    map.setMode('fly');
    map.setWeather('CLOUDY');
    map.setHour(12);
    map.camera.position.set(centre[0] - 260, centre[1] + 150, centre[2] + 380);
    map.camera.lookAt(centre[0], centre[1] + 40, centre[2]);
  });
  await page.waitForFunction(() => globalThis.gta4map.getState().pendingSectors.length === 0, null, { timeout: 300_000 });
  await page.waitForTimeout(800);

  const results = {};
  for (const [name, range] of [['all-near', [4000, 5000]], ['all-far', [0.5, 1]]]) {
    await page.evaluate(bounds => {
      const u = globalThis.gta4map.grading.grade.uniforms;
      // Grey when near, fully saturated when far, so the split is unmistakable.
      u.uNear.value.set(0, 1, 1);
      u.uFar.value.set(1.6, 1, 1);
      u.uDepthRange.value.set(bounds[0], bounds[1]);
      globalThis.gta4map.grading.update = () => {};   // stop the per-frame overwrite
    }, range);
    await page.waitForTimeout(300);
    const shot = await page.screenshot({ path: `artifacts/grade/depth-${name}.png` });
    results[name] = await saturation(shot);
  }

  const delta = results['all-far'] - results['all-near'];
  console.log(JSON.stringify({ ...results, delta }, null, 2));
  if (!(delta > 0.05)) {
    throw new Error(`Depth is not reaching the grade pass: saturation barely moved (delta ${delta.toFixed(4)}).`);
  }
  console.log('OK: the near/far split follows scene depth.');
} finally {
  await browser.close();
}
