// Converts GTA IV's pc/data/timecyc.dat into web/data/timecyc.json.
//
// timecyc.dat is the game's entire lighting mood: 9 weather blocks, each with
// 11 time-of-day keyframes, each keyframe 134 whitespace-separated numbers.
// The header comment names the leading block and the trailing block but leaves
// columns 64-131 (sky/cloud/moon tuning) unnamed, so those are carried through
// verbatim as `extra` rather than guessed at.
//
// Column positions below were verified against the EXTRASUNNY/Midnight row:
// SunCore and SunCorona are 0 0 0 there, DirLightMult 1.0 and SunMult 0.0,
// which only lines up if the offsets are right.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

// The project is checked out both as _webmap and as a worktree several levels
// deeper, so walk up until the installed game is found instead of assuming.
function findGameRoot(start) {
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'pc', 'data', 'timecyc.dat'))) return dir;
    if (dirname(dir) === dir) throw new Error('Could not locate the GTA IV install above ' + start);
  }
}

const HOURS = {
  Midnight: 0, '5AM': 5, '6AM': 6, '7AM': 7, '9AM': 9, Midday: 12,
  '6PM': 18, '7PM': 19, '8PM': 20, '9PM': 21, '10PM': 22,
};

// [name, offset, length]; offsets are 0-based into the 134-number row.
const FIELDS = [
  ['amb0', 0, 3], ['amb1', 3, 3], ['dir', 6, 3],
  ['skyTop', 9, 3], ['skyBottom', 12, 3], ['sunCore', 15, 3], ['sunCorona', 18, 3],
  ['sunSize', 21, 1], ['spriteBrightness', 22, 1], ['farClip', 23, 1], ['fogStart', 24, 1],
  ['lowClouds', 25, 3], ['bottomClouds', 28, 3], ['water', 31, 4],
  ['exposure', 35, 1], ['bloomThreshold', 36, 1], ['midGrey', 37, 1], ['bloomIntensity', 38, 1],
  ['colourCorrect', 39, 3], ['colourAdd', 42, 3],
  ['desaturation', 45, 1], ['contrast', 46, 1], ['gamma', 47, 1],
  ['desaturationFar', 48, 1], ['contrastFar', 49, 1], ['gammaFar', 50, 1],
  ['depthFxNear', 51, 1], ['depthFxFar', 52, 1],
  ['lumMin', 53, 1], ['lumMax', 54, 1], ['lumDelay', 55, 1], ['cloudAlpha', 56, 1],
  ['dirLightMult', 57, 1], ['ambLightMult0', 58, 1], ['ambLightMult1', 59, 1],
  ['skyLightMult', 60, 1], ['sunMult', 61, 1], ['temperature', 62, 1],
  ['farDof', 120, 1], ['nearDof', 121, 1],
  ['nearBlurDof', 122, 1], ['midBlurDof', 123, 1], ['farBlurDof', 124, 1],
  ['waterReflection', 125, 1], ['particleHdr', 126, 1],
  ['spriteSize', 131, 1], ['globalSunMult', 132, 1], ['aoScale', 133, 1],
];

// The seven leading RGB triples and the two colour-grade triples are stored as
// 0-255 bytes; everything else in the row is already a plain float.
const BYTE_FIELDS = new Set([
  'amb0', 'amb1', 'dir', 'skyTop', 'skyBottom', 'sunCore', 'sunCorona',
  'lowClouds', 'bottomClouds', 'water', 'colourCorrect', 'colourAdd',
]);

const gameRoot = findGameRoot(projectRoot);
const text = readFileSync(join(gameRoot, 'pc', 'data', 'timecyc.dat'), 'latin1');

const weathers = {};
let weather = null;
let label = null;

for (const line of text.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  if (trimmed.startsWith('//////////')) {
    weather = trimmed.replace(/\/+/g, '').trim();
    weathers[weather] = [];
    label = null;
    continue;
  }
  if (trimmed.startsWith('//')) {
    const name = trimmed.slice(2).trim();
    label = name in HOURS ? name : null;
    continue;
  }
  if (!weather || !label) continue;

  const values = trimmed.split(/\s+/).map(Number);
  if (values.length !== 134 || values.some(Number.isNaN)) {
    throw new Error(`${weather}/${label}: expected 134 numbers, got ${values.length}`);
  }

  const keyframe = { label, hour: HOURS[label] };
  for (const [name, offset, length] of FIELDS) {
    const slice = values.slice(offset, offset + length);
    const scaled = BYTE_FIELDS.has(name) ? slice.map(value => value / 255) : slice;
    keyframe[name] = length === 1 ? scaled[0] : scaled.map(value => Math.round(value * 1e4) / 1e4);
  }
  keyframe.extra = values.slice(63, 120);
  weathers[weather].push(keyframe);
  label = null;
}

for (const [name, frames] of Object.entries(weathers)) {
  if (frames.length !== 11) throw new Error(`${name}: expected 11 keyframes, got ${frames.length}`);
  frames.sort((a, b) => a.hour - b.hour);
}

const output = join(projectRoot, 'web', 'data', 'timecyc.json');
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify({
  source: 'pc/data/timecyc.dat',
  hours: weathers.EXTRASUNNY.map(frame => frame.hour),
  weathers,
}));

console.log(`timecyc: ${Object.keys(weathers).length} weathers x 11 keyframes -> web/data/timecyc.json`);
