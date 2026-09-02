// Captures the same viewpoint across a set of timecyc keyframes so the
// lighting can be compared side by side. Not part of `npm test`; run it by
// hand while tuning: node test/timecyc-shots.mjs
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

const shots = (process.env.SHOTS ?? 'EXTRASUNNY@6,EXTRASUNNY@12,EXTRASUNNY@19.5,EXTRASUNNY@22,CLOUDY@12,RAIN@19')
  .split(',').map(entry => { const [weather, hour] = entry.split('@'); return { weather, hour: Number(hour) }; });

await mkdir('artifacts/timecyc', { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
try {
  await page.goto(process.env.MAP_URL ?? 'http://127.0.0.1:4176', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(() => globalThis.gta4map?.getState().ready, null, { timeout: 300_000 });
  await page.waitForFunction(() => globalThis.gta4map.getState().pendingSectors.length === 0, null, { timeout: 300_000 });

  // Frame Manhattan from just above the rooftops: high enough to catch the sky
  // and the sun, low enough that facades show which way the light is coming
  // from. Derived from the sector bounds so it survives a re-extract.
  await page.evaluate(() => {
    const map = globalThis.gta4map;
    const { min, max } = map.world.sectors.find(sector => sector.id === 'manhat01').bounds;
    const centre = [0, 1, 2].map(axis => (min[axis] + max[axis]) / 2);
    map.setMode('fly');
    map.camera.position.set(centre[0] - 260, centre[1] + 150, centre[2] + 380);
    map.camera.lookAt(centre[0], centre[1] + 40, centre[2]);
  });
  await page.waitForTimeout(1200);

  for (const { weather, hour } of shots) {
    await page.evaluate(([weather, hour]) => {
      globalThis.gta4map.setWeather(weather);
      globalThis.gta4map.setHour(hour);
    }, [weather, hour]);
    await page.waitForTimeout(350);
    const name = `${weather}-${String(hour).replace('.', '_')}`;
    await page.screenshot({ path: `artifacts/timecyc/${name}.png` });
    const state = await page.evaluate(() => globalThis.gta4map.getState().lighting);
    console.log(name.padEnd(22), 'exposure', state.exposure.toFixed(3), 'sun', state.sunIntensity.toFixed(2), 'amb', state.ambientIntensity.toFixed(2), 'sunY', state.sun[1].toFixed(3), 'fog', state.fogDensity.toExponential(2));
  }
} finally {
  await browser.close();
}
