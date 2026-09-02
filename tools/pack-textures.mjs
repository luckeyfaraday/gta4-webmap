// Packs each sector's DDS textures into a small number of GPU texture-array
// bundles, so the viewer issues ~20 requests per sector instead of ~800 and
// downloads only the mip levels it actually uploads.
//
//   node tools/pack-textures.mjs [--max-edge 256] [--sector manhat01] [--force]
//
// Writes web/assets/sectors/<id>/textures.{json,bin} next to each map GLB.

import { readFile, writeFile, open, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const MAX_EDGE = Number(flag('max-edge', 256));
const ONLY = flag('sector', null);
const FORCE = args.includes('--force');

const ROOT = 'web/assets';
const TEXTURE_DIR = join(ROOT, 'textures');

const FOURCC_BLOCK_BYTES = { DXT1: 8, DXT3: 16, DXT5: 16 };

function glbJson(buffer) {
  if (buffer.readUInt32LE(0) !== 0x46546c67) throw new Error('not a GLB');
  let offset = 12;
  while (offset < buffer.length) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    if (type === 0x4e4f534a) return JSON.parse(buffer.toString('utf8', offset + 8, offset + 8 + length));
    offset += 8 + length;
  }
  throw new Error('GLB has no JSON chunk');
}

function blockBytes(width, height, fourCC) {
  return Math.max(1, Math.ceil(width / 4)) * Math.max(1, Math.ceil(height / 4)) * FOURCC_BLOCK_BYTES[fourCC];
}

// Returns the full mip chain as offsets into the file buffer, so trimming is a
// slice rather than a re-encode.
function parseDDS(buffer, name) {
  if (buffer.readUInt32LE(0) !== 0x20534444) throw new Error(`${name}: not a DDS`);
  const height = buffer.readUInt32LE(12);
  const width = buffer.readUInt32LE(16);
  const declaredMips = buffer.readUInt32LE(28) || 1;
  const fourCC = buffer.toString('ascii', 84, 88);
  if (!FOURCC_BLOCK_BYTES[fourCC]) throw new Error(`${name}: unsupported format ${fourCC}`);
  if (buffer.readUInt32LE(80) & 0x4 && fourCC === 'DX10') throw new Error(`${name}: DX10 header`);

  const levels = [];
  let offset = 128;
  for (let i = 0; i < declaredMips; i++) {
    const w = Math.max(1, width >> i);
    const h = Math.max(1, height >> i);
    const size = blockBytes(w, h, fourCC);
    if (offset + size > buffer.length) break; // truncated chain; keep what is real
    levels.push({ width: w, height: h, offset, size });
    offset += size;
  }
  if (!levels.length) throw new Error(`${name}: no mip data`);
  return { width, height, fourCC, levels };
}

function trim(dds, maxEdge) {
  let drop = 0;
  while (drop < dds.levels.length - 1 && (dds.levels[drop].width > maxEdge || dds.levels[drop].height > maxEdge)) drop++;
  return drop;
}

async function packSector(sectorDir, sectorId) {
  const glbPath = join(sectorDir, 'map_optimized.glb');
  const manifestPath = join(sectorDir, 'textures.json');
  const binPath = join(sectorDir, 'textures.bin');

  if (!FORCE) {
    const [glbStat, manifestStat] = await Promise.all([
      stat(glbPath).catch(() => null), stat(manifestPath).catch(() => null),
    ]);
    if (glbStat && manifestStat && manifestStat.mtimeMs > glbStat.mtimeMs) return { sectorId, skipped: true };
  }

  const json = glbJson(await readFile(glbPath));
  const names = new Set();
  for (const material of json.materials ?? []) {
    if (material.extras?.texture) names.add(basename(material.extras.texture));
  }

  // Read every texture this sector references, then bucket by the size/format
  // it lands on after trimming.
  const buckets = new Map();
  const missing = [];
  const list = [...names];
  let index = 0;
  await Promise.all(Array.from({ length: 24 }, async () => {
    while (index < list.length) {
      const name = list[index++];
      let buffer;
      try { buffer = await readFile(join(TEXTURE_DIR, name)); }
      catch { missing.push(name); continue; }
      let dds;
      try { dds = parseDDS(buffer, name); }
      catch (error) { missing.push(`${name} (${error.message})`); continue; }

      const drop = trim(dds, MAX_EDGE);
      const base = dds.levels[drop];
      const key = `${base.width}x${base.height}|${dds.fourCC}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { key, width: base.width, height: base.height, fourCC: dds.fourCC, entries: [] };
        buckets.set(key, bucket);
      }
      bucket.entries.push({ name, buffer, levels: dds.levels.slice(drop) });
    }
  }));

  // Layers of one array must agree on level count.
  const arrays = [];
  const layers = {};
  const chunks = [];
  let cursor = 0;
  for (const bucket of [...buckets.values()].sort((a, b) => b.entries.length - a.entries.length)) {
    const levelCount = Math.min(...bucket.entries.map(entry => entry.levels.length));
    const arrayIndex = arrays.length;
    bucket.entries.sort((a, b) => a.name.localeCompare(b.name));

    const start = cursor;
    // Mip-major: every layer's level 0, then every layer's level 1, ... which is
    // exactly what CompressedArrayTexture uploads per level.
    for (let level = 0; level < levelCount; level++) {
      for (const entry of bucket.entries) {
        const mip = entry.levels[level];
        chunks.push(entry.buffer.subarray(mip.offset, mip.offset + mip.size));
        cursor += mip.size;
      }
    }
    bucket.entries.forEach((entry, layer) => { layers[entry.name] = [arrayIndex, layer]; });
    arrays.push({
      key: bucket.key, width: bucket.width, height: bucket.height, fourCC: bucket.fourCC,
      levels: levelCount, layers: bucket.entries.length, offset: start, byteLength: cursor - start,
    });
  }

  const bin = Buffer.concat(chunks);
  await writeFile(binPath, bin);
  await writeFile(manifestPath, JSON.stringify({ maxEdge: MAX_EDGE, arrays, layers }));
  return { sectorId, textures: names.size, arrays: arrays.length, bytes: bin.length, missing };
}

const world = JSON.parse((await readFile(join(ROOT, 'world.json'), 'utf8')).replace(/^﻿/, ''));
const targets = world.sectors.filter(sector => !ONLY || sector.id === ONLY);
if (!targets.length) throw new Error(`no sector matched --sector ${ONLY}`);

let totalBytes = 0, totalArrays = 0, totalMissing = 0;
for (const sector of targets) {
  const dir = dirname(join('web', sector.url.replace(/^\.\//, 'assets/').replace('assets/assets/', 'assets/')));
  const result = await packSector(join(ROOT, 'sectors', sector.id), sector.id);
  if (result.skipped) { console.log(`${sector.id.padEnd(12)} up to date`); continue; }
  totalBytes += result.bytes; totalArrays += result.arrays; totalMissing += result.missing.length;
  console.log(`${sector.id.padEnd(12)} ${String(result.textures).padStart(5)} textures -> ` +
    `${String(result.arrays).padStart(3)} arrays  ${(result.bytes / 1048576).toFixed(1)} MB` +
    (result.missing.length ? `  MISSING ${result.missing.length}: ${result.missing.slice(0, 3).join(', ')}` : ''));
}
console.log(`\npacked ${targets.length} sectors  ${totalArrays} arrays  ${(totalBytes / 1048576).toFixed(0)} MB total` +
  (totalMissing ? `  (${totalMissing} textures missing)` : ''));
