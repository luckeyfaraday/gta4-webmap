import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

// Drives the character around the streamed world: walk mode follows him in
// third person, the gait matches the speed, jumping leaves the ground and he
// ends up standing on the city rather than inside or under it.
const candidates = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);
const executablePath = candidates.find(existsSync);
if (!executablePath) throw new Error('Chrome or Edge was not found.');

await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
const messages = [];
page.on('console', message => messages.push(`[console:${message.type()}] ${message.text()}`));
page.on('pageerror', error => messages.push(`[pageerror] ${error.stack ?? error.message}`));

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const state = () => page.evaluate(() => globalThis.gta4map.getState());
const planar = (a, b) => Math.hypot(
  a.player.position[0] - b.player.position[0],
  a.player.position[2] - b.player.position[2]);

try {
  await page.goto(process.env.MAP_URL ?? 'http://127.0.0.1:4174', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(() => globalThis.gta4map, null, { timeout: 120_000 });
  await page.waitForFunction(() => globalThis.gta4map.getState().ready, null, { timeout: 180_000 });
  await page.waitForFunction(() => globalThis.gta4map.getState().pendingSectors.length === 0, null, { timeout: 300_000 });
  await page.waitForTimeout(600);

  const loaded = await state();
  check(loaded.player !== null, 'the character did not load');
  check(loaded.player?.bones === 90, `expected 90 bones, got ${loaded.player?.bones}`);
  check(loaded.player?.clips === 62, `expected 62 clips, got ${loaded.player?.clips}`);

  await page.evaluate(() => globalThis.gta4map.setMode('walk'));
  await page.waitForTimeout(900);
  const standing = await state();
  check(standing.player.visible, 'the character is not visible in walk mode');
  check(standing.player.grounded, 'the character did not land on the map when walk mode began');
  check(standing.player.clip === 'idle', `expected 'idle' when standing still, got '${standing.player.clip}'`);

  // The follow camera must sit behind and above him, not on top of him.
  const eye = Math.hypot(
    standing.camera[0] - standing.player.position[0],
    standing.camera[2] - standing.player.position[2]);
  check(eye > 1.2 && eye < 6, `follow camera is ${eye.toFixed(2)}m away from the character`);
  check(standing.camera[1] > standing.player.position[1], 'follow camera is below the character');

  // Jog, then sprint, and confirm the gait, the clip and that he really moves.
  // Distance is only checked loosely: the frame loop clamps dt, so a slow
  // headless frame rate covers less ground per wall-clock second.
  await page.keyboard.down('w');
  await page.waitForTimeout(1200);
  const jogging = await state();
  const jogged = planar(jogging, standing);
  check(jogged > 1, `jogging moved only ${jogged.toFixed(2)}m in 1.2s`);
  check(jogging.player.speed > 3.5 && jogging.player.speed < 5, `jog speed is ${jogging.player.speed}`);
  check(jogging.player.clip === 'run', `expected 'run' while jogging, got '${jogging.player.clip}'`);

  // He has to run the way he is looking. `facing` comes from the eye joints, so
  // this catches a wrong model yaw offset that a moving-and-animating character
  // would otherwise hide.
  const travelX = jogging.player.position[0] - standing.player.position[0];
  const travelZ = jogging.player.position[2] - standing.player.position[2];
  const travelLength = Math.hypot(travelX, travelZ);
  const alignment = jogging.player.facing
    ? (jogging.player.facing[0] * travelX + jogging.player.facing[2] * travelZ) / travelLength
    : 0;
  check(alignment > 0.8, `the character is facing ${(Math.acos(Math.max(-1, Math.min(1, alignment))) * 180 / Math.PI).toFixed(0)}° away from the way he is running`);
  await page.screenshot({ path: 'artifacts/player-third-person.png' });

  await page.keyboard.down('Shift');
  await page.waitForTimeout(900);
  const sprinting = await state();
  check(sprinting.player.clip === 'sprint', `expected 'sprint' with Shift held, got '${sprinting.player.clip}'`);
  check(sprinting.player.speed > jogging.player.speed, 'sprinting is not faster than jogging');
  await page.keyboard.up('Shift');

  await page.keyboard.down('Alt');
  await page.waitForTimeout(700);
  const walking = await state();
  check(walking.player.clip === 'walk', `expected 'walk' with Alt held, got '${walking.player.clip}'`);
  check(walking.player.speed < jogging.player.speed, 'walking is not slower than jogging');
  await page.keyboard.up('Alt');
  await page.keyboard.up('w');

  await page.waitForTimeout(700);
  const stopped = await state();
  check(stopped.player.clip === 'idle', `expected 'idle' after stopping, got '${stopped.player.clip}'`);

  // Jumping has to leave the ground and land again.
  const groundY = stopped.player.position[1];
  await page.keyboard.down('Space');
  await page.waitForTimeout(260);
  const airborne = await state();
  check(!airborne.player.grounded, 'the character never left the ground');
  check(airborne.player.position[1] > groundY + 0.25, `jump only reached ${(airborne.player.position[1] - groundY).toFixed(2)}m`);
  check(airborne.player.clip.startsWith('jump'), `expected a jump clip in the air, got '${airborne.player.clip}'`);
  await page.screenshot({ path: 'artifacts/player-jump-world.png' });
  await page.keyboard.up('Space');
  await page.waitForTimeout(1400);
  const landed = await state();
  check(landed.player.grounded, 'the character never landed');
  check(Math.abs(landed.player.position[1] - groundY) < 1.5, 'the character did not land back near the ground');

  // First person hides him and keeps the camera at eye level.
  await page.keyboard.press('v');
  await page.waitForTimeout(300);
  const firstPerson = await state();
  check(!firstPerson.player.visible, 'the character is still visible in first person');
  check(Math.abs(firstPerson.camera[1] - (firstPerson.player.position[1] + 1.62)) < 0.05, 'first-person camera is not at eye height');
  await page.keyboard.press('v');
  await page.waitForTimeout(300);
  check((await state()).player.visible, 'the character did not come back in third person');

  const result = {
    bones: loaded.player?.bones,
    clips: loaded.player?.clips,
    jogged: Number(jogged.toFixed(2)),
    cameraDistance: Number(eye.toFixed(2)),
    facingAlignment: Number(alignment.toFixed(3)),
    jumpHeight: Number((airborne.player.position[1] - groundY).toFixed(2)),
    failures,
    messages: messages.filter(message => message.startsWith('[pageerror]')),
  };
  await writeFile('artifacts/player-walk.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (failures.length) throw new Error(`Walk checks failed:\n  ${failures.join('\n  ')}`);
} finally {
  await browser.close();
}
