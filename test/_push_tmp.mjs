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

const scan = () => page.evaluate(() => {
  const { THREE, collisionMeshes, getState } = globalThis.gta4map;
  const meshes = collisionMeshes();
  const p = getState().player.position;
  const origin = new THREE.Vector3(p[0], p[1] + 1.15, p[2]);
  const ray = new THREE.Raycaster();
  ray.near = 0; ray.far = 40;
  let best = { yaw: 0, distance: Infinity };
  for (let i = 0; i < 16; i++) {
    const yaw = i * Math.PI / 8;
    ray.set(origin, new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)));
    const hit = ray.intersectObjects(meshes, false)[0];
    if (hit && hit.distance < best.distance) best = { yaw, distance: hit.distance, name: hit.object.name, visible: hit.object.visible };
  }
  return best;
});

const wall = await scan();
console.log('nearest wall', JSON.stringify(wall));
await page.evaluate(a => globalThis.gta4map.look(a + Math.PI, -0.1), wall.yaw);
await page.keyboard.down('w');
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(500);
  const s = await page.evaluate(() => globalThis.gta4map.getState().player);
  const now = await scan();
  console.log(`t+${((i + 1) * 0.5).toFixed(1)}s pushes=${s.pushes} commanded=${s.commanded.toFixed(1)} travelled=${s.travelled.toFixed(1)} nearest=${now.distance === Infinity ? 'none' : now.distance.toFixed(2)} nearMeshes=${s.nearMeshes}`);
}
await page.keyboard.up('w');
await browser.close();
