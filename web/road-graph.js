import * as THREE from 'three';

// The road network from web/data/paths.json, with the two lookups traffic
// actually needs: "which segments are near this point" and "where do I go from
// this node". Both are built once — 24,602 nodes and 24,568 edges is too much to
// scan per frame, and re-deriving adjacency per spawn is worse.
export class RoadGraph {
  constructor(data, { cell = 120 } = {}) {
    const roads = data.roads;
    this.positions = Float32Array.from(roads.positions);
    this.edges = Uint32Array.from(roads.edges);
    this.lanes = Uint8Array.from(roads.lanes);
    this.nodeCount = this.positions.length / 3;
    this.edgeCount = this.edges.length / 2;
    this.stats = data.stats;

    // Adjacency as a flat CSR-style pair of arrays rather than an array of
    // arrays: one allocation instead of 24k of them.
    const degree = new Uint32Array(this.nodeCount + 1);
    for (let i = 0; i < this.edges.length; i++) degree[this.edges[i] + 1]++;
    for (let i = 0; i < this.nodeCount; i++) degree[i + 1] += degree[i];
    this.neighbourStart = degree;
    this.neighbours = new Uint32Array(this.edges.length);
    const cursor = Uint32Array.from(degree);
    for (let e = 0; e < this.edgeCount; e++) {
      const a = this.edges[e * 2];
      const b = this.edges[e * 2 + 1];
      this.neighbours[cursor[a]++] = b;
      this.neighbours[cursor[b]++] = a;
    }

    // A uniform grid on the horizontal plane, keyed by cell, holding edge
    // indices. Cells are sized well above the 8 m median segment length so an
    // edge lands in one or two of them.
    this.cell = cell;
    this.grid = new Map();
    for (let e = 0; e < this.edgeCount; e++) {
      const a = this.edges[e * 2];
      const b = this.edges[e * 2 + 1];
      const key = this.#key(
        (this.positions[a * 3] + this.positions[b * 3]) / 2,
        (this.positions[a * 3 + 2] + this.positions[b * 3 + 2]) / 2,
      );
      let bucket = this.grid.get(key);
      if (!bucket) this.grid.set(key, bucket = []);
      bucket.push(e);
    }
  }

  static async load(url = './data/paths.json', options) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`paths.json: ${response.status}`);
    return new RoadGraph(await response.json(), options);
  }

  #key(x, z) {
    return `${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`;
  }

  node(index, target = new THREE.Vector3()) {
    return target.set(this.positions[index * 3], this.positions[index * 3 + 1], this.positions[index * 3 + 2]);
  }

  edgeNodes(edge) {
    return [this.edges[edge * 2], this.edges[edge * 2 + 1]];
  }

  laneCount(edge) {
    return Math.max(1, this.lanes[edge]);
  }

  // Edge indices whose midpoint lies within `radius` of (x, z). Used both to
  // pick spawn points and to seed a vehicle's first heading.
  edgesNear(x, z, radius, out = []) {
    out.length = 0;
    const span = Math.ceil(radius / this.cell);
    const cx = Math.floor(x / this.cell);
    const cz = Math.floor(z / this.cell);
    const limit = radius * radius;
    for (let gz = cz - span; gz <= cz + span; gz++) {
      for (let gx = cx - span; gx <= cx + span; gx++) {
        const bucket = this.grid.get(`${gx},${gz}`);
        if (!bucket) continue;
        for (const edge of bucket) {
          const a = this.edges[edge * 2];
          const b = this.edges[edge * 2 + 1];
          const mx = (this.positions[a * 3] + this.positions[b * 3]) / 2;
          const mz = (this.positions[a * 3 + 2] + this.positions[b * 3 + 2]) / 2;
          const dx = mx - x;
          const dz = mz - z;
          if (dx * dx + dz * dz <= limit) out.push(edge);
        }
      }
    }
    return out;
  }

  // Where to go on leaving `to`, having arrived from `from`. Straight on is
  // preferred so traffic follows a road through a junction instead of picking
  // uniformly and jittering back and forth; a dead end turns around.
  nextNode(from, to, random = Math.random) {
    const start = this.neighbourStart[to];
    const end = this.neighbourStart[to + 1];
    if (end <= start) return from;

    const ax = this.positions[to * 3] - this.positions[from * 3];
    const az = this.positions[to * 3 + 2] - this.positions[from * 3 + 2];
    const alen = Math.hypot(ax, az) || 1;

    let best = -1;
    let bestScore = -Infinity;
    let options = 0;
    for (let i = start; i < end; i++) {
      const candidate = this.neighbours[i];
      if (candidate === from) continue;
      options++;
      const bx = this.positions[candidate * 3] - this.positions[to * 3];
      const bz = this.positions[candidate * 3 + 2] - this.positions[to * 3 + 2];
      const blen = Math.hypot(bx, bz) || 1;
      // Dot product of the two directions: 1 is dead ahead, -1 doubling back.
      const straightness = (ax * bx + az * bz) / (alen * blen);
      const score = straightness + random() * 0.6;
      if (score > bestScore) { bestScore = score; best = candidate; }
    }
    return options === 0 ? from : best;
  }
}
