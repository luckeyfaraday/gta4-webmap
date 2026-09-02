import { readFile, readdir, open, stat } from 'node:fs/promises';
import { basename } from 'node:path';

async function glbJson(path) {
  const b = await readFile(path);
  let off = 12;
  while (off < b.length) { const len = b.readUInt32LE(off), t = b.readUInt32LE(off+4);
    if (t === 0x4E4F534A) return JSON.parse(b.toString('utf8', off+8, off+8+len)); off += 8+len; }
}
const blockBytes = (w,h,fmt) => Math.max(1,Math.ceil(w/4))*Math.max(1,Math.ceil(h/4))*(fmt==='DXT1'?8:16);
function chain(w,h,mips,fmt){ const out=[]; for(let i=0;i<mips;i++){ out.push({w:Math.max(1,w>>i),h:Math.max(1,h>>i)}); } return out; }

const tdir='web/assets/textures';
const meta=new Map(); const buf=Buffer.alloc(128);
for (const f of (await readdir(tdir)).filter(f=>f.toLowerCase().endsWith('.dds'))) {
  const fh=await open(`${tdir}/${f}`,'r'); await fh.read(buf,0,128,0); await fh.close();
  meta.set(f.toLowerCase(),{w:buf.readUInt32LE(16),h:buf.readUInt32LE(12),mips:buf.readUInt32LE(28),fmt:buf.toString('ascii',84,88)});
}
const world=JSON.parse((await readFile('web/assets/world.json','utf8')).replace(/^\uFEFF/,''));
const perSector=new Map();
for (const s of world.sectors){ const j=await glbJson(`web/assets/sectors/${s.id}/map_optimized.glb`);
  const set=new Set(); for(const m of j.materials??[]){ if(m.extras?.texture) set.add(basename(m.extras.texture).toLowerCase()); }
  perSector.set(s.id,set); }

const union=new Set(); let sum=0;
for(const s of perSector.values()){ sum+=s.size; for(const t of s) union.add(t); }
console.log(`sum of per-sector texture lists: ${sum}   union: ${union.size}   duplication factor: ${(sum/union.size).toFixed(2)}x`);

function report(maxEdge){
  // drop leading mips until both dims <= maxEdge
  const classOf=t=>{ const m=meta.get(t); let d=0;
    while((m.w>>d)>maxEdge||(m.h>>d)>maxEdge){ if(d+1>=m.mips) break; d++; }
    return {key:`${Math.max(1,m.w>>d)}x${Math.max(1,m.h>>d)}|${m.fmt}`,w:Math.max(1,m.w>>d),h:Math.max(1,m.h>>d),mips:m.mips-d,fmt:m.fmt}; };
  const bytesOf=t=>{ const c=classOf(t); let b=0; for(const l of chain(c.w,c.h,c.mips,c.fmt)) b+=blockBytes(l.w,l.h,c.fmt); return b; };
  const globalClasses=new Set(); for(const t of union) globalClasses.add(classOf(t).key);
  let worstSector=0, sectorBytes=[], sectorClasses=[];
  for(const [id,set] of perSector){ let b=0; const cs=new Set();
    for(const t of set){ b+=bytesOf(t); cs.add(classOf(t).key); }
    sectorBytes.push(b/1048576); sectorClasses.push(cs.size); }
  const totalUnion=[...union].reduce((a,t)=>a+bytesOf(t),0)/1048576;
  sectorBytes.sort((a,b)=>b-a);
  const top4 = sectorBytes.slice(0,4).reduce((a,b)=>a+b,0);
  console.log(`maxEdge=${String(maxEdge).padStart(4)}  classes(global)=${String(globalClasses.size).padStart(3)}  ` +
    `classes/sector avg=${(sectorClasses.reduce((a,b)=>a+b,0)/sectorClasses.length).toFixed(0)} max=${Math.max(...sectorClasses)}  ` +
    `VRAM: worst sector=${sectorBytes[0].toFixed(0)}MB  worst4=${top4.toFixed(0)}MB  wholeWorldUnion=${totalUnion.toFixed(0)}MB`);
}
for (const e of [1024, 512, 256, 128]) report(e);
