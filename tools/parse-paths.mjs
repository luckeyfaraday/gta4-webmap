// Converts GTA IV's road network into web/data/paths.json — the graph traffic
// drives along.
//
// The network lives in common/data/maps/paths*.ipl, which are text IPLs. The
// classic `path` section in them is empty; the data is in two sections the GTA
// III-era format never had:
//
//   vnod   x, y, z, ..., streetNameHash, ...     (13 fields; a vehicle node)
//   link   nodeA, nodeB, ?, lanes, ?, ?          (6 fields; an undirected edge)
//
// Link indices are per file, so each file is parsed as its own index space and
// the results are concatenated with an offset.
//
// Of the four files: paths.ipl and paths2.ipl are the road network (24,602
// nodes), paths3.ipl is boat lanes (its Max file is literally paths3_boats.max),
// and paths4.ipl (Networkpaths_4.max) carries nodes with no links at all, so it
// is not a graph and is skipped. GTA IV has no pedestrian path section — peds
// navigate a navmesh the archives store separately — so this is vehicles only.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

// The project is checked out both as _webmap and as a worktree several levels
// deeper, so walk up until the installed game is found instead of assuming.
function findGameRoot(start) {
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'common', 'data', 'maps', 'paths.ipl'))) return dir;
    if (dirname(dir) === dir) throw new Error('Could not locate the GTA IV install above ' + start);
  }
}

const gameRoot = findGameRoot(projectRoot);

// RAGE is Z-up. The map exporter in Program.cs writes the world through
// (-x, z, -y) — a reflection — so the graph has to go through the same mapping
// or traffic will drive down a mirrored city's pavements.
const toViewer = (x, y, z) => [-x, z, -y];

function parse(file) {
  const text = readFileSync(join(gameRoot, 'common', 'data', 'maps', file), 'latin1');
  const nodes = [];
  const links = [];
  let section = '';

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (/^[a-z_0-9]+$/.test(line)) { section = line === 'end' ? '' : line; continue; }

    const fields = line.split(',').map(field => field.trim());
    if (section === 'vnod' && fields.length >= 3) {
      const [x, y, z] = fields.slice(0, 3).map(Number);
      if ([x, y, z].some(Number.isNaN)) continue;
      nodes.push({ p: toViewer(x, y, z), street: Number(fields[9]) || 0 });
    } else if (section === 'link' && fields.length >= 2) {
      const a = Number(fields[0]);
      const b = Number(fields[1]);
      if (!Number.isInteger(a) || !Number.isInteger(b)) continue;
      links.push([a, b, Number(fields[3]) || 1]);
    }
  }
  return { nodes, links };
}

const roadFiles = ['paths.ipl', 'paths2.ipl'];
const boatFiles = ['paths3.ipl'];

function build(files) {
  const nodes = [];
  const edges = [];
  let dropped = 0;
  for (const file of files) {
    const offset = nodes.length;
    const parsed = parse(file);
    nodes.push(...parsed.nodes);
    for (const [a, b, lanes] of parsed.links) {
      // A link that points outside its own file's node range is not something
      // to silently reinterpret against the concatenated array — count it.
      if (a < 0 || b < 0 || a >= parsed.nodes.length || b >= parsed.nodes.length) { dropped++; continue; }
      if (a === b) { dropped++; continue; }
      edges.push([offset + a, offset + b, lanes]);
    }
  }
  return { nodes, edges, dropped };
}

const roads = build(roadFiles);
const boats = build(boatFiles);

// Adjacency, so the traffic sim can walk the graph without rebuilding it.
function adjacency(nodeCount, edges) {
  const list = Array.from({ length: nodeCount }, () => []);
  for (const [a, b] of edges) { list[a].push(b); list[b].push(a); }
  return list;
}

const roadAdjacency = adjacency(roads.nodes.length, roads.edges);
const degrees = roadAdjacency.map(list => list.length);
const isolated = degrees.filter(d => d === 0).length;
const junctions = degrees.filter(d => d >= 3).length;

// Segment lengths, as a sanity check that the coordinate mapping is sane: GTA
// IV lays road nodes roughly every 10-25 m.
const lengths = roads.edges.map(([a, b]) => {
  const p = roads.nodes[a].p;
  const q = roads.nodes[b].p;
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}).sort((x, y) => x - y);
const median = lengths[Math.floor(lengths.length / 2)] ?? 0;

const bounds = roads.nodes.reduce((box, node) => {
  for (let i = 0; i < 3; i++) {
    box.min[i] = Math.min(box.min[i], node.p[i]);
    box.max[i] = Math.max(box.max[i], node.p[i]);
  }
  return box;
}, { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });

const output = {
  source: roadFiles.concat(boatFiles).join(', '),
  note: 'Vehicle path graph. GTA IV has no ped path section; peds use a navmesh.',
  roads: {
    // Flat arrays: 24k nodes as objects is 3x the bytes for no benefit.
    positions: roads.nodes.flatMap(node => node.p.map(value => Math.round(value * 100) / 100)),
    streets: roads.nodes.map(node => node.street),
    edges: roads.edges.flatMap(([a, b]) => [a, b]),
    lanes: roads.edges.map(([, , lanes]) => lanes),
  },
  boats: {
    positions: boats.nodes.flatMap(node => node.p.map(value => Math.round(value * 100) / 100)),
    edges: boats.edges.flatMap(([a, b]) => [a, b]),
  },
  stats: {
    roadNodes: roads.nodes.length,
    roadEdges: roads.edges.length,
    droppedRoadLinks: roads.dropped,
    isolatedNodes: isolated,
    junctions,
    medianSegmentLength: Math.round(median * 100) / 100,
    boatNodes: boats.nodes.length,
    boatEdges: boats.edges.length,
    bounds,
  },
};

mkdirSync(join(projectRoot, 'web', 'data'), { recursive: true });
const target = join(projectRoot, 'web', 'data', 'paths.json');
writeFileSync(target, JSON.stringify(output));
console.log(`Wrote ${target}`);
console.log(JSON.stringify(output.stats, null, 2));
