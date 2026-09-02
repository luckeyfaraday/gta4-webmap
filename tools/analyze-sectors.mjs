import { readFile, readdir, open } from 'node:fs/promises';
import { basename } from 'node:path';

async function glbJson(path) {
  const b = await readFile(path);
  if (b.readUInt32LE(0) !== 0x46546C67) throw new Error('not glb');
  let off = 12;
  while (off < b.length) {
    const len = b.readUInt32LE(off), type = b.readUInt32LE(off + 4);
    if (type === 0x4E4F534A) return JSON.parse(b.toString('utf8', off + 8, off + 8 + len));
    off += 8 + len;
  }
  throw new Error('no json chunk');
}

// texture class index
const tdir = 'web/assets/textures';
const cls = new Map();
const buf = Buffer.alloc(128);
for (const f of (await readdir(tdir)).filter(f => f.toLowerCase().endsWith('.dds'))) {
  const fh = await open(`${tdir}/${f}`, 'r'); await fh.read(buf, 0, 128, 0); await fh.close();
  cls.set(f.toLowerCase(), `${buf.readUInt32LE(16)}x${buf.readUInt32LE(12)}|${buf.toString('ascii',84,88)}`);
}

const world = JSON.parse((await readFile('web/assets/world.json','utf8')).replace(/^\uFEFF/,''));
const rows = [];
for (const s of world.sectors) {
  const j = await glbJson(`web/assets/sectors/${s.id}/map_optimized.glb`);
  const mats = j.materials ?? [];
  const used = new Set(), classes = new Map(), missing = new Set();
  for (const m of mats) {
    const uri = m.extras?.texture; if (!uri) continue;
    const name = basename(uri).toLowerCase();
    used.add(name);
    const c = cls.get(name);
    if (!c) { missing.add(name); continue; }
    classes.set(c, (classes.get(c) ?? 0) + 1);
  }
  rows.push({ id: s.id, materials: mats.length, meshes: (j.meshes??[]).length,
    nodes: (j.nodes??[]).length, textures: used.size, classes: classes.size, missing: missing.size,
    top: [...classes.entries()].sort((a,b)=>b[1]-a[1]).slice(0,4) });
}
console.log('sector       mats  meshes  nodes  texs  classes  missing  top classes');
for (const r of rows) console.log(
  `${r.id.padEnd(12)} ${String(r.materials).padStart(4)} ${String(r.meshes).padStart(7)} ${String(r.nodes).padStart(6)} ${String(r.textures).padStart(5)} ${String(r.classes).padStart(8)} ${String(r.missing).padStart(8)}  ${r.top.map(([k,v])=>`${k}:${v}`).join(' ')}`);
const avg = a => (a.reduce((x,y)=>x+y,0)/a.length).toFixed(1);
console.log('\navg materials', avg(rows.map(r=>r.materials)), 'avg classes', avg(rows.map(r=>r.classes)),
  'max classes', Math.max(...rows.map(r=>r.classes)), 'total missing', rows.reduce((a,r)=>a+r.missing,0));
