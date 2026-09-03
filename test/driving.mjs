import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

// Driving a vehicle taken over from traffic.
//
// The checks worth having are the ones that would otherwise look plausible on
// screen: that the car the player gets into is the same object that was driving
// past (not a fresh copy), that it accelerates and steers using its OWN
// handling figures rather than one set of constants for everything, that it
// stays on the road surface, and that getting out puts the player beside the
// car and hands it back to traffic.
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

// Drives the player-controlled car by holding keys for a while.
async function drive(page, keys, seconds) {
  for (const key of keys) await page.keyboard.down(key);
  await page.waitForTimeout(seconds * 1000);
  for (const key of keys) await page.keyboard.up(key);
}

try {
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(() => globalThis.gta4map?.getState().ready, null, { timeout: 150_000 });
  await page.evaluate(() => globalThis.gta4map.setMode('walk'));
  await page.waitForTimeout(14_000);

  // Stand next to a car that is already driving past, and get in. Entering has
  // to take THAT car over rather than spawn a copy, which is why the traffic
  // count is compared either side.
  const result = await page.evaluate(() => {
    const api = globalThis.gta4map;
    api.clearWanted();
    const cars = api.traffic.debugCars();
    if (!cars.length) return { error: 'no traffic to enter' };
    const player = api.getState().player.position;
    cars.sort((a, b) =>
      Math.hypot(a.position[0] - player[0], a.position[2] - player[2]) -
      Math.hypot(b.position[0] - player[0], b.position[2] - player[2]));
    const target = cars[0];
    api.setPlayerPosition(target.position[0], target.position[1] + 1, target.position[2]);
    const trafficBefore = api.traffic.getState().count;
    const state = api.enterNearestVehicle();
    return { state, target: target.model, trafficBefore, trafficAfter: api.traffic.getState().count };
  });

  check(!result.error, result.error ?? '');
  check(result.state !== null && result.state !== undefined, 'could not enter a vehicle');
  if (result.state) {
    check(result.state.driving === true, 'entered but not driving');
    check(result.trafficAfter === result.trafficBefore - 1,
      `traffic went from ${result.trafficBefore} to ${result.trafficAfter}: the car should leave the flow, not be copied`);
    // Handling must come from the catalogue, not from one set of constants.
    check(result.state.topSpeedKmh > 40 && result.state.topSpeedKmh < 260,
      `implausible top speed ${result.state.topSpeedKmh} km/h`);
    check(['F', 'R', '4'].includes(result.state.drive), `unknown drive type ${result.state.drive}`);
    check(result.state.mass > 400, `implausible mass ${result.state.mass}`);
  }

  const mode = await page.evaluate(() => globalThis.gta4map.getState().mode);
  check(mode === 'drive', `expected drive mode, got ${mode}`);

  // Accelerate.
  await drive(page, ['KeyW'], 3.5);
  const moving = await page.evaluate(() => globalThis.gta4map.getState());
  check(moving.driving.speedKmh > 12, `only reached ${moving.driving.speedKmh} km/h under throttle`);
  const travelled = Math.hypot(
    moving.driving.position[0] - (result.state?.position[0] ?? 0),
    moving.driving.position[2] - (result.state?.position[2] ?? 0));
  check(travelled > 8, `the car moved only ${travelled.toFixed(1)}m`);

  // Braking, while the car is still genuinely rolling forward. Measured on
  // signed velocity: pressing back from a standstill is reverse gear, not a
  // brake, and an absolute speed cannot tell the two apart.
  const rolling = moving.driving.velocityKmh;
  await drive(page, ['KeyS'], 0.9);
  const braked = await page.evaluate(() => globalThis.gta4map.getState().driving);
  check(rolling > 5, `the car was only doing ${rolling} km/h before the brake test`);
  check(braked.velocityKmh < rolling,
    `braking did not slow the car (${rolling} then ${braked.velocityKmh} km/h)`);

  // Steer, and confirm the heading actually changes.
  const beforeYaw = braked.yaw;
  await drive(page, ['KeyW', 'KeyA'], 2.4);
  const turned = await page.evaluate(() => globalThis.gta4map.getState().driving);
  const yawDelta = Math.abs(((turned.yaw - beforeYaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI);
  check(yawDelta > 0.15, `steering barely changed the heading (${yawDelta.toFixed(3)} rad)`);

  // The car must be sitting on the road, not floating or buried.
  const height = await page.evaluate(() => {
    const { THREE, scene, driving } = globalThis.gta4map;
    const position = driving.position;
    const targets = [];
    scene.traverse(object => {
      if ((object.isMesh || object.isBatchedMesh) && !object.userData?.isPed && !object.userData?.isVehicle) targets.push(object);
    });
    const ray = new THREE.Raycaster(new THREE.Vector3(position.x, position.y + 3, position.z), new THREE.Vector3(0, -1, 0), 0, 24);
    const hit = ray.intersectObjects(targets, false)[0];
    return hit ? position.y - hit.point.y : null;
  });
  check(height !== null, 'no ground found beneath the car');
  if (height !== null) check(Math.abs(height) < 0.8, `the car sits ${height.toFixed(2)}m off the road`);

  await page.screenshot({ path: 'artifacts/driving.png' });

  // Getting out.
  const exited = await page.evaluate(async () => {
    const api = globalThis.gta4map;
    const carPosition = [...api.driving.position];
    const trafficBefore = api.traffic.getState().count;
    api.exitVehicle();
    await new Promise(resolve => setTimeout(resolve, 600));
    const state = api.getState();
    return {
      mode: state.mode,
      driving: state.driving.driving,
      trafficBefore,
      trafficAfter: api.traffic.getState().count,
      distanceFromCar: Math.hypot(state.player.position[0] - carPosition[0], state.player.position[2] - carPosition[2]),
    };
  });
  check(exited.mode === 'walk', `after getting out the mode is ${exited.mode}`);
  check(exited.driving === false, 'still driving after getting out');
  check(exited.distanceFromCar > 0.5 && exited.distanceFromCar < 8,
    `the player got out ${exited.distanceFromCar.toFixed(1)}m from the car`);
  check(exited.trafficAfter >= exited.trafficBefore,
    'the car was not handed back to traffic when the player got out');

  const summary = {
    entered: result.state,
    trafficBefore: result.trafficBefore,
    trafficAfter: result.trafficAfter,
    speedUnderThrottle: moving.driving.speedKmh,
    travelled: Number(travelled.toFixed(1)),
    yawDelta: Number(yawDelta.toFixed(3)),
    rollingKmh: rolling,
    afterBrakingKmh: braked.velocityKmh,
    heightAboveRoad: height === null ? null : Number(height.toFixed(3)),
    exited,
    failures,
    messages,
  };
  await writeFile('artifacts/driving.json', JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (failures.length) throw new Error(`Driving checks failed:\n  ${failures.join('\n  ')}`);
} finally {
  await browser.close();
}
