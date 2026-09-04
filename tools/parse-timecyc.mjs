// Converts GTA IV's pc/data/timecyc.dat into web/data/timecyc.json.
//
// timecyc.dat is the game's entire lighting mood: 9 weather blocks, each with
// 11 time-of-day keyframes, each keyframe 134 whitespace-separated numbers.
// The header comment names the leading block and the trailing block but leaves
// columns 63-119 (sky/cloud/moon tuning) unnamed. Those used to be carried
// through verbatim as `extra`; the ones the sky needs are now named, because
// the shader that consumes them ships with the game. common/shaders/dcl/
// gta_atmoscatt_clouds.txt lists every constant the sky shader takes, which
// turns "what is column 64" into "which constant does column 64 behave like" -
// a question the data can answer. See the block above the additions in FIELDS
// for the evidence behind each one. The rest stay in `extra`.
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

  // Columns 63-119 carry no header name, but the sky is drawn by the game's
  // own gta_atmoscatt_clouds shader and common/shaders/dcl names every constant
  // it takes. These are the ones that could be matched to a column with
  // evidence; the rest stay in `extra`.
  //
  //   63      AzimuthStrength how hard the horizon glow is laid over the
  //                           zenith: ~0.85 at night against ~0.47 by day, and
  //                           1.389 under a clear midnight, which is the city
  //                           lighting its own haze. Read as AzimuthHeight
  //                           instead - the other scalar in that pair - it
  //                           never falls off, and the glow covers the whole
  //                           dome at half strength and washes midday white.
  //                           AzimuthHeight is not a column: it wants 1.0, and
  //                           79 and 93 both hold 1.000 in all 99 keyframes.
  //   64-66   SkyColor        zenith. Goes flat grey in RAIN and blue in
  //                           EXTRASUNNY, which the labelled "Sky top" column
  //                           at offset 9 does not - that one is 0 0 0 at 9AM.
  //   67-69   AzimuthColor    horizon, and
  //   70-72   AzimuthColorEast the opposite end of the horizon lerp. They are
  //                           bit-identical at 9AM and 6PM, when the sun is
  //                           neither rising nor setting, and split warm/cool
  //                           at 6AM and 7PM. Nothing but an east/west pair
  //                           behaves that way.
  //   73-75   SunsetColor     (1.000, 0.882, 0.588) in exactly the keyframes
  //                           either side of the sun - 7AM, 6PM, 7PM, 8PM in
  //                           SUNNY - and a muted (0.361, 0.310, 0.310) in
  //                           every other one. Nothing switches on at both
  //                           golden hours and off at noon and midnight but the
  //                           colour the shader names for them. 76 is its .w,
  //                           1.000 throughout, which is why SunsetColor is a
  //                           float4 in the shader and 76 is not AzimuthHeight.
  //   88      CloudInscatteringRange  0.680 in all 99 keyframes, and
  //                           visualSettings.dat's sky.cloudInscatteringRange
  //                           is 0.68.
  //   89-91   CloudEdgeSmooth, DetailScale, Strength. 89 sits at 0.757 against
  //                           visualSettings' sky.cloudEdgeSmooth 0.76.
  //   116-117 SunCentre start/end  0.980 and 1.000 in all 99 keyframes, exactly
  //                           visualSettings' sky.sun.centreStart/centreEnd.
  //
  // Unlike the leading triples these are authored as floats, not 0-255 bytes,
  // so they are not in BYTE_FIELDS.
  ['azimuthStrength', 63, 1],
  ['skyColour', 64, 3], ['azimuthColour', 67, 3], ['azimuthColourEast', 70, 3],
  ['sunsetColour', 73, 3],
  ['cloudInscatteringRange', 88, 1], ['cloudEdgeSmooth', 89, 1],
  ['cloudDetailScale', 90, 1], ['cloudStrength', 91, 1],
  ['sunCentreStart', 116, 1], ['sunCentreEnd', 117, 1],
];

// The seven leading RGB triples and the two colour-grade triples are stored as
// 0-255 bytes; everything else in the row is already a plain float.
const BYTE_FIELDS = new Set([
  'amb0', 'amb1', 'dir', 'skyTop', 'skyBottom', 'sunCore', 'sunCorona',
  'lowClouds', 'bottomClouds', 'water', 'colourCorrect', 'colourAdd',
  // CloudAlpha is a 0-255 byte like the triples, not a fraction: it reads 0
  // under a clear EXTRASUNNY midnight, 77 for ordinary cover and 217 when
  // DRIZZLE is fully overcast.
  'cloudAlpha',
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
