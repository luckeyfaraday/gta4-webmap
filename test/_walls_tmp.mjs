import { chromium } from 'playwright-core';

const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto(process.env.MAP_URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => globalThis.gta4map, null, { timeout: 120000 });
await page.waitForFunction(() => globalThis.gta4map.getState().ready, null, { timeout: 180000 });
await page.waitForFunction(() => globalThis.gta4map.getState().pendingSectors.length === 0, null, { timeout: 300000 });
await page.evaluate(() => globalThis.gta4map.setMode('walk'));
await page.waitForTimeout(1200);

const report = await page.evaluate(() => {
  const { THREE, collisionMeshes, getState } = globalThis.gta4map;
  const meshes = collisionMeshes();
  const p = getState().player.position;
  const origin = new THREE.Vector3(p[0], p[1] + 1.15, p[2]);
  const ray = new THREE.Raycaster();
  ray.near = 0;
  ray.far = 30;
  const rows = [];
  for (let i = 0; i < 8; i++) {
    const yaw = i * Math.PI / 4;
    const dir = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    ray.set(origin, dir);
    const hit = ray.intersectObjects(meshes, false)[0];
    rows.push({ yaw: Number(yaw.toFixed(2)), distance: hit ? Number(hit.distance.toFixed(2)) : null });
  }
  return { nearMeshes: meshes.length, position: p, rows };
});
console.log(JSON.stringify(report, null, 2));
await browser.close();
