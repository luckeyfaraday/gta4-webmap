// Diagnostic: raycasts a grid over the rendered view and reports which material
// is under each sample, flagging any that still has no texture bound. Use it to
// tell "the texture is missing from the archives" apart from "the texture has
// not been applied yet". Run against a live `npm run serve`.
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const candidates = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);
const executablePath = candidates.find(existsSync);
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const messages = [];
page.on('console', m => messages.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => messages.push(`[pageerror] ${e.message}`));

await page.goto('http://127.0.0.1:4174', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => globalThis.gta4map?.getState().ready, null, { timeout: 180_000 });
await page.locator('#sector-select').selectOption('nj_05', { force: true });
await page.waitForFunction(() => globalThis.gta4map.getState().loadedSectors.includes('nj_05'), null, { timeout: 180_000 });
await page.waitForFunction(() => globalThis.gta4map.getState().pendingSectors.length === 0, null, { timeout: 300_000 });
await page.waitForTimeout(750);

const report = await page.evaluate(async () => {
  const THREE = await import('three');
  const { scene, camera } = globalThis.gta4map;
  const meshes = [];
  scene.traverse(o => { if (o.isMesh) meshes.push(o); });
  const ray = new THREE.Raycaster();
  const tally = new Map();
  let hits = 0, noMap = 0;
  for (let px = 0; px < 96; px++) {
    for (let py = 0; py < 60; py++) {
      const ndc = new THREE.Vector2((px / 95) * 2 - 1, -((py / 59) * 2 - 1));
      ray.setFromCamera(ndc, camera);
      const hit = ray.intersectObjects(meshes, false)[0];
      if (!hit) continue;
      hits++;
      const m = hit.object.material;
      const key = `${m.userData?.shader ?? '?'} | tex=${m.userData?.texture ?? 'NONE'} | map=${m.map ? 'yes' : 'NULL'} | color=#${m.color.getHexString()}`;
      tally.set(key, (tally.get(key) ?? 0) + 1);
      if (!m.map) noMap++;
    }
  }
  return {
    hits, noMap,
    top: [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18),
  };
});
console.log(JSON.stringify(report, null, 2));
console.log('console messages:', messages.length, messages.slice(0, 10));
await browser.close();
