import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

// Checks the road network and the traffic driving on it, without the streamed
// city: traffic.html draws the graph as lines instead, so a failure here is the
// path data or the driving, never sector streaming.
//
// The check that matters is the last one. A car is placed by interpolating
// along the segment it claims to be on, so if the graph, the lane offset or the
// stepping between nodes is wrong, the car drifts away from its own road. That
// is measured directly rather than eyeballed.
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
const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: 1 });
const messages = [];
page.on('console', message => { if (message.type() === 'error') messages.push(`[console] ${message.text()}`); });
page.on('pageerror', error => messages.push(`[pageerror] ${error.stack ?? error.message}`));
page.on('requestfailed', request => messages.push(`[requestfailed] ${request.url()} ${request.failure()?.errorText ?? ''}`));

const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
}

try {
  await page.goto(`${base}/traffic.html`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(() => globalThis.gta4traffic, null, { timeout: 90_000 });
  // Long enough for the spawn loop to fill up: one car is loaded per frame.
  await page.waitForTimeout(9_000);

  const state = await page.evaluate(() => globalThis.gta4traffic.getState());

  // The graph itself.
  check(state.graph.nodes === 24_602, `expected 24,602 road nodes, got ${state.graph.nodes}`);
  check(state.graph.dropped === 0, `${state.graph.dropped} links pointed outside their file's node range`);
  check(state.graph.isolated === 0, `${state.graph.isolated} road nodes have no links`);
  check(state.graph.junctions > 1_000, `only ${state.graph.junctions} junctions — the network looks disconnected`);
  check(state.graph.medianSegment > 3 && state.graph.medianSegment < 40,
    `median segment ${state.graph.medianSegment}m is not a plausible road spacing`);

  // Traffic filled the ring.
  check(state.traffic.count >= 8, `only ${state.traffic.count} cars spawned`);
  check(state.traffic.spawnable > 40, `only ${state.traffic.spawnable} models in the traffic rotation`);

  // Variety: ambient traffic picking one model repeatedly means the frequency
  // weighting is broken.
  const distinct = new Set(state.traffic.models).size;
  check(distinct >= 5, `only ${distinct} distinct models across ${state.traffic.count} cars`);

  // Speeds should be a spread of plausible city figures, not one value.
  const speeds = state.traffic.speeds;
  check(speeds.every(kmh => kmh > 10 && kmh < 130), `implausible speeds: ${speeds.join(', ')}`);

  // The load-bearing check: how far each car sits from the segment it is on.
  // Lanes straddle the chain, so the largest legitimate offset is half the
  // carriageway: 3.2 m x 1.5 for the widest (4-lane) roads.
  const measured = await page.evaluate(() =>
    (globalThis.gta4traffic.traffic.debugCars?.() ?? []).map(car => car.distanceToSegment));

  if (measured.length) {
    const worst = Math.max(...measured);
    check(worst < 5.5, `a car sits ${worst.toFixed(2)}m from its own road segment`);
  } else {
    failures.push('traffic exposed no per-car segment distances to check');
  }

  await page.screenshot({ path: 'artifacts/traffic.png' });

  const result = {
    graph: state.graph,
    traffic: { count: state.traffic.count, spawnable: state.traffic.spawnable, distinctModels: distinct },
    speeds,
    worstSegmentDrift: measured.length ? Number(Math.max(...measured).toFixed(3)) : null,
    failures,
    messages,
  };
  await writeFile('artifacts/traffic.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (failures.length) throw new Error(`Traffic checks failed:\n  ${failures.join('\n  ')}`);
} finally {
  await browser.close();
}
