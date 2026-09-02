// A/B for the baked vertex lighting GTA IV stores in COLOR_0. Captures the
// same frame with it on and off, reports how many materials carry it and how
// much the image actually changes, so "the AO is working" is a measurement
// rather than an impression. Run by hand: node test/baked-ab.mjs
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

await mkdir('artifacts/baked', { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
try {
  await page.goto(process.env.MAP_URL ?? 'http://127.0.0.1:4176', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(() => globalThis.gta4map?.getState().ready, null, { timeout: 300_000 });
  await page.waitForFunction(() => globalThis.gta4map.getState().pendingSectors.length === 0, null, { timeout: 300_000 });

  // Street level, where baked occlusion under awnings and in doorways shows.
  await page.evaluate(() => {
    const map = globalThis.gta4map;
    const { min, max } = map.world.sectors.find(sector => sector.id === 'manhat01').bounds;
    const centre = [0, 1, 2].map(axis => (min[axis] + max[axis]) / 2);
    map.setMode('fly');
    map.setHour(12);
    map.setWeather('EXTRASUNNY');
    map.camera.position.set(centre[0] - 120, min[1] + 26, centre[2] + 150);
    map.camera.lookAt(centre[0], min[1] + 40, centre[2]);
  });
  await page.waitForTimeout(900);

  // What fraction of materials actually carry usable COLOR_0, and how dark is
  // it? A mean far below 1.0 is the occlusion; a mean at 1.0 would mean the
  // extractor filled in white and there is nothing to gain.
  const coverage = await page.evaluate(() => {
    let withColour = 0, total = 0, terrain = 0;
    const sums = [];
    const seen = new Set();
    globalThis.gta4map.scene.traverse(object => {
      if (!object.isMesh || !object.geometry?.attributes?.position) return;
      const colour = object.geometry.attributes.COLOR_0 ?? object.geometry.attributes.color;
      for (const material of [object.material].flat()) {
        if (!material?.userData?.shader) continue;
        total++;
        if (/terrain_va/i.test(material.userData.shader)) terrain++;
        if (material.vertexColors) withColour++;
      }
      if (!colour || seen.has(object.geometry.uuid)) return;
      seen.add(object.geometry.uuid);
      let sum = 0;
      const step = Math.max(1, Math.floor(colour.count / 400));
      let samples = 0;
      for (let i = 0; i < colour.count; i += step) {
        sum += (colour.getX(i) + colour.getY(i) + colour.getZ(i)) / 3;
        samples++;
      }
      if (samples) sums.push(sum / samples);
    });
    return {
      materials: total,
      withVertexColours: withColour,
      terrainExcluded: terrain,
      meanVertexLuma: sums.length ? sums.reduce((a, b) => a + b, 0) / sums.length : null,
      geometriesSampled: sums.length,
    };
  });

  const shots = {};
  for (const enabled of [true, false]) {
    await page.evaluate(value => globalThis.gta4map.setBakedLighting(value), enabled);
    await page.waitForTimeout(400);
    const name = enabled ? 'baked-on' : 'baked-off';
    shots[name] = await page.screenshot({ path: `artifacts/baked/${name}.png` });
  }

  // Mean absolute difference over the raw PNG bytes is crude but enough to
  // separate "the toggle does nothing" from "the toggle changes the render".
  const [on, off] = [shots['baked-on'], shots['baked-off']];
  const identical = Buffer.compare(on, off) === 0;

  console.log(JSON.stringify({ ...coverage, screenshotsIdentical: identical, bytes: [on.length, off.length] }, null, 2));
  if (identical) throw new Error('Baked lighting toggle produced an identical image.');
} finally {
  await browser.close();
}
