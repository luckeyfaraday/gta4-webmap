import * as THREE from 'three';

// The walkable surface, from web/data/navmesh.json + navmesh.bin — 910,402
// points decoded out of GTA IV's own pedestrian navmesh. See the README for the
// .wnv format; the short version is that these are polygon centroids thinned
// onto a 2.5 m grid, so every one is somewhere a person may legally stand.
//
// Two conversions matter. Points are stored per tile, local and quantised, in
// RAGE coordinates; the viewer's world is the map's reflected space, so they go
// through (-x, -y) on the horizontal plane exactly as the road graph does.
// Heights are NOT in the file — the per-tile Z base is not stored — so callers
// supply a ground probe.
export class NavPoints {
  constructor(manifest, binary, { cell = 60 } = {}) {
    this.stats = manifest.stats;
    this.tileSize = manifest.tileSize;
    this.cell = cell;

    const view = new DataView(binary);
    const total = manifest.stats.points;
    // Flat arrays in viewer space, built once: 910k points as objects would be
    // tens of megabytes of heap for no gain.
    this.x = new Float32Array(total);
    this.z = new Float32Array(total);

    let cursor = 0;
    for (const tile of manifest.tiles) {
      for (let i = 0; i < tile.count; i++) {
        const offset = (tile.start + i) * 4;
        const rageX = tile.x + (view.getUint16(offset, true) / 65535) * manifest.tileSize;
        const rageY = tile.y + (view.getUint16(offset + 2, true) / 65535) * manifest.tileSize;
        // Same reflection the map and the road graph use.
        this.x[cursor] = -rageX;
        this.z[cursor] = -rageY;
        cursor++;
      }
    }
    this.count = cursor;

    // Uniform grid for "walkable points near here".
    this.grid = new Map();
    for (let i = 0; i < this.count; i++) {
      const key = this.#key(this.x[i], this.z[i]);
      let bucket = this.grid.get(key);
      if (!bucket) this.grid.set(key, bucket = []);
      bucket.push(i);
    }
  }

  static async load(url = './data/navmesh.json', options) {
    const manifest = await fetch(url).then(response => {
      if (!response.ok) throw new Error(`navmesh.json: ${response.status}`);
      return response.json();
    });
    const binaryUrl = new URL(manifest.binary, new URL(url, location.href)).href;
    const binary = await fetch(binaryUrl).then(response => {
      if (!response.ok) throw new Error(`${manifest.binary}: ${response.status}`);
      return response.arrayBuffer();
    });
    return new NavPoints(manifest, binary, options);
  }

  #key(x, z) {
    return `${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`;
  }

  point(index, target = new THREE.Vector3()) {
    return target.set(this.x[index], 0, this.z[index]);
  }

  // Indices of walkable points within `radius` of (x, z).
  near(x, z, radius, out = []) {
    out.length = 0;
    const span = Math.ceil(radius / this.cell);
    const cx = Math.floor(x / this.cell);
    const cz = Math.floor(z / this.cell);
    const limit = radius * radius;
    for (let gz = cz - span; gz <= cz + span; gz++) {
      for (let gx = cx - span; gx <= cx + span; gx++) {
        const bucket = this.grid.get(`${gx},${gz}`);
        if (!bucket) continue;
        for (const index of bucket) {
          const dx = this.x[index] - x;
          const dz = this.z[index] - z;
          if (dx * dx + dz * dz <= limit) out.push(index);
        }
      }
    }
    return out;
  }

  // The nearest walkable point to (x, z), or -1 if nothing is within `radius`.
  nearest(x, z, radius = 20) {
    let best = -1;
    let bestDistance = radius * radius;
    const span = Math.ceil(radius / this.cell);
    const cx = Math.floor(x / this.cell);
    const cz = Math.floor(z / this.cell);
    for (let gz = cz - span; gz <= cz + span; gz++) {
      for (let gx = cx - span; gx <= cx + span; gx++) {
        const bucket = this.grid.get(`${gx},${gz}`);
        if (!bucket) continue;
        for (const index of bucket) {
          const dx = this.x[index] - x;
          const dz = this.z[index] - z;
          const distance = dx * dx + dz * dz;
          if (distance < bestDistance) { bestDistance = distance; best = index; }
        }
      }
    }
    return best;
  }

  // A walkable point to walk to next: near `index`, roughly in `direction`, so a
  // ped keeps going rather than jittering on the spot. Points are thinned onto a
  // 2.5 m grid, so a step is a few metres.
  step(index, dirX, dirZ, scratch = []) {
    const x = this.x[index];
    const z = this.z[index];
    this.near(x, z, 6, scratch);
    let best = -1;
    let bestScore = -Infinity;
    for (const candidate of scratch) {
      if (candidate === index) continue;
      const dx = this.x[candidate] - x;
      const dz = this.z[candidate] - z;
      const length = Math.hypot(dx, dz);
      if (length < 0.5) continue;
      // Prefer straight on, with enough noise to spread the crowd out.
      const score = (dx * dirX + dz * dirZ) / length + Math.random() * 0.7;
      if (score > bestScore) { bestScore = score; best = candidate; }
    }
    return best;
  }
}
