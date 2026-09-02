import { readdir, open } from 'node:fs/promises';
const dir = 'web/assets/textures';
const files = (await readdir(dir)).filter(f => f.toLowerCase().endsWith('.dds'));
const groups = new Map();
const buf = Buffer.alloc(128);
let bad = 0;
for (const f of files) {
  const fh = await open(`${dir}/${f}`, 'r');
  const { bytesRead } = await fh.read(buf, 0, 128, 0);
  await fh.close();
  if (bytesRead < 128 || buf.readUInt32LE(0) !== 0x20534444) { bad++; continue; }
  const h = buf.readUInt32LE(12), w = buf.readUInt32LE(16), mips = buf.readUInt32LE(28);
  const fourCC = buf.toString('ascii', 84, 88);
  const key = `${w}x${h}|${fourCC}`;
  if (!groups.has(key)) groups.set(key, { w, h, fourCC, count: 0, mips: new Set() });
  const g = groups.get(key); g.count++; g.mips.add(mips);
}
const rows = [...groups.values()].sort((a, b) => b.count - a.count);
console.log('files:', files.length, 'unreadable:', bad, 'classes:', rows.length);
let cum = 0;
for (const r of rows) { cum += r.count;
  console.log(`${String(r.count).padStart(5)}  ${String(r.w+'x'+r.h).padStart(11)}  ${r.fourCC}  mips=${[...r.mips].join(',')}  cum=${(cum/files.length*100).toFixed(1)}%`); }
