import * as THREE from 'three';
import { loadVehicle, loadCatalogue } from './vehicle-model.js';

// Ambient traffic: vehicles spawned on the road graph near the player, driving
// from node to node, despawned once they are far enough behind to be nobody's
// business.
//
// Population control is by distance rather than by count alone, because the
// player moves: cars are spawned into a ring that starts beyond the near edge
// of view and culled outside a larger radius, so driving forward continuously
// replaces the fleet instead of dragging the same cars along.

const SPAWN_MIN = 60;      // do not pop a car into existence in front of the player
const SPAWN_MAX = 220;
const DESPAWN = 320;
const LANE_WIDTH = 3.2;

// A node chain is one carriageway, not a road centreline. Measured: sampling
// 1,446 edges for their nearest near-parallel neighbour gives a bimodal
// distribution with a clear mode at 9-10 m, which is a dual carriageway with a
// chain per direction — so lanes are centred ON the chain, not offset off one
// side of it. Offsetting by a whole lane set (the obvious reading of the
// `lanes` column) drives the outer lane of a 4-lane road 11 m wide of its own
// carriageway and onto the pavement.
function laneOffset(lane, laneCount) {
  return LANE_WIDTH * (lane - (laneCount - 1) / 2);
}

export class Traffic {
  #graph;
  #scene;
  #renderer;
  #catalogue;
  #spawnable = [];
  #totalFrequency = 0;
  #active = [];
  #inFlight = 0;
  #edgeScratch = [];
  #from = new THREE.Vector3();
  #to = new THREE.Vector3();
  #forward = new THREE.Vector3();
  #right = new THREE.Vector3();

  constructor(graph, scene, renderer, catalogue, options = {}) {
    this.#graph = graph;
    this.#scene = scene;
    this.#renderer = renderer;
    this.#catalogue = catalogue;
    this.maxVehicles = options.maxVehicles ?? 28;
    this.enabled = options.enabled ?? true;

    // Optional (x, z, yHint) -> y probe against the streamed city.
    //
    // Path node heights turn out to be the drivable surface already: probing
    // 712 times against sector geometry moves a car by a median of 0 and at
    // most 0.15 m. (An earlier measurement suggesting a 1.36 m deficit was
    // wrong — that ray was hitting the car's own bodywork, so it measured the
    // height of a roof above its wheels.) The probe is kept because those small
    // corrections are real, and because it keeps cars on the surface across
    // bridges and slopes rather than trusting a straight line between two
    // nodes. Where no probe is supplied (the standalone preview draws no city)
    // cars use the node height directly.
    this.groundProbe = options.groundProbe ?? null;
    this.probeInterval = options.probeInterval ?? 0.2;

    // vehicles.ide's Frq column is the game's own relative spawn weight, and
    // its flags mark what should not appear in ordinary traffic: emergency
    // vehicles, boats, helicopters and the subway are all in the catalogue but
    // are not ambient cars.
    for (const entry of catalogue.vehicles) {
      if (entry.type !== 'car') continue;
      if (!entry.wheels || entry.wheels.length < 4) continue;
      if (entry.frequency <= 0) continue;
      if (NON_TRAFFIC.has(entry.model)) continue;
      this.#spawnable.push(entry);
      this.#totalFrequency += entry.frequency;
    }
  }

  static async create(graph, scene, renderer, options) {
    const catalogue = await loadCatalogue();
    return new Traffic(graph, scene, renderer, catalogue, options);
  }

  get count() { return this.#active.length; }
  get spawnableCount() { return this.#spawnable.length; }

  #pickModel(random = Math.random) {
    let roll = random() * this.#totalFrequency;
    for (const entry of this.#spawnable) {
      roll -= entry.frequency;
      if (roll <= 0) return entry;
    }
    return this.#spawnable[this.#spawnable.length - 1];
  }

  // How many of this model are already out. vehicles.ide caps it per model.
  #countOf(model) {
    let total = 0;
    for (const car of this.#active) if (car.entry.model === model) total++;
    return total;
  }

  async #spawn(playerPosition) {
    const candidates = this.#graph.edgesNear(playerPosition.x, playerPosition.z, SPAWN_MAX, this.#edgeScratch);
    if (candidates.length === 0) return false;

    // Reject edges too close to the player so cars do not blink into view.
    let edge = -1;
    for (let attempt = 0; attempt < 12; attempt++) {
      const pick = candidates[(Math.random() * candidates.length) | 0];
      const [a, b] = this.#graph.edgeNodes(pick);
      this.#graph.node(a, this.#from);
      const distance = this.#from.distanceTo(playerPosition);
      if (distance >= SPAWN_MIN) { edge = pick; break; }
    }
    if (edge < 0) return false;

    const entry = this.#pickModel();
    if (this.#countOf(entry.model) >= Math.max(1, entry.maxNumber)) return false;

    const [a, b] = this.#graph.edgeNodes(edge);
    // Direction is taken from node index order rather than at random. Chains
    // are numbered along their length, so every car on a given carriageway
    // flows the same way instead of half of them driving into the other half.
    // (The file's own direction encoding is not identified: link columns 5 and
    // 6 carry 0/1/2 and 0..3 with no confirmed meaning, so this is a
    // consistent convention, not a claim about the game's intent.)
    const start = Math.min(a, b);
    const end = Math.max(a, b);

    this.#inFlight++;
    let model;
    try {
      model = await loadVehicle(`./assets/vehicles/${entry.gltf}`, this.#renderer, { clone: true });
    } catch (error) {
      console.warn('Traffic: failed to load', entry.model, error);
      return false;
    } finally {
      this.#inFlight--;
    }

    // The catalogue carries the model's own legal paint combinations; the first
    // index of a set is the body colour.
    const sets = entry.colourSets;
    if (sets?.length) {
      const colour = this.#catalogue.palette[sets[(Math.random() * sets.length) | 0][0]];
      if (colour) model.paint(colour.rgb);
    }

    // The exported world is mirrored (see README); vehicles are mirrored back
    // exactly as Niko is.
    model.root.scale.x = -1;
    // Tagged so a downward ground probe skips the car it is probing for —
    // otherwise the first thing the ray hits is that car's own roof.
    model.root.userData.isVehicle = true;
    model.root.traverse(object => { object.userData.isVehicle = true; });

    const car = {
      entry,
      model,
      from: start,
      to: end,
      t: Math.random() * 0.8,
      lane: (Math.random() * this.#graph.laneCount(edge)) | 0,
      laneCount: this.#graph.laneCount(edge),
      speed: this.#cruiseSpeed(entry),
      wheelAngle: 0,
      // Height correction from the ground probe, re-sampled on a stagger so 24
      // cars do not all raycast on the same frame.
      lift: 0,
      probeTimer: Math.random() * this.probeInterval,
      lifted: false,
      // Front wheel radius, for rolling the wheels at the right rate.
      wheelRadius: entry.wheelRadius?.[0] > 0.05 ? entry.wheelRadius[0] : 0.35,
    };
    this.#active.push(car);
    this.#scene.add(model.root);
    this.#place(car);
    return true;
  }

  // The height the graph alone would put this car at, before any probe.
  #baseHeight(car) {
    const a = this.#graph.positions[car.from * 3 + 1];
    const b = this.#graph.positions[car.to * 3 + 1];
    return a + (b - a) * Math.min(1, Math.max(0, car.t));
  }

  // handling.dat's top speed is a flat-out figure; ambient traffic cruises well
  // below it, with a little spread so a queue is not lockstep.
  #cruiseSpeed(entry) {
    const top = entry.handling?.topSpeed ?? 120;
    const kmh = Math.min(top, 34 + Math.random() * 18);
    return kmh / 3.6;
  }

  #place(car) {
    const graph = this.#graph;
    graph.node(car.from, this.#from);
    graph.node(car.to, this.#to);
    this.#forward.subVectors(this.#to, this.#from);
    const length = this.#forward.length() || 1;
    this.#forward.divideScalar(length);

    // Lanes straddle the chain — see laneOffset above.
    this.#right.set(-this.#forward.z, 0, this.#forward.x).normalize();
    const offset = laneOffset(car.lane, car.laneCount);

    const position = this.#from.clone().addScaledVector(this.#forward, car.t * length)
      .addScaledVector(this.#right, offset);
    position.y += car.lift;
    car.model.root.position.copy(position);

    // Face along travel. The mesh is mirrored on x, so yaw is measured in the
    // mirrored frame to match — the same correction Niko needs.
    car.model.root.rotation.y = Math.atan2(-this.#forward.x, -this.#forward.z);
    car.segmentLength = length;
  }

  update(delta, playerPosition) {
    if (!this.enabled) return;

    for (let i = this.#active.length - 1; i >= 0; i--) {
      const car = this.#active[i];
      const length = car.segmentLength || 1;
      car.t += (car.speed * delta) / length;

      while (car.t >= 1) {
        car.t -= 1;
        const next = this.#graph.nextNode(car.from, car.to);
        car.from = car.to;
        car.to = next;
      }
      // Re-probe the road under the car occasionally and ease onto it, so a
      // car crossing a hill or a bridge follows the surface instead of
      // stepping. Easing also hides the moment a sector finishes streaming and
      // a probe starts returning a hit where it previously returned nothing.
      if (this.groundProbe) {
        car.probeTimer -= delta;
        if (car.probeTimer <= 0) {
          car.probeTimer = this.probeInterval;
          const base = this.#baseHeight(car);
          this.probesAttempted = (this.probesAttempted ?? 0) + 1;
          const surface = this.groundProbe(car.model.root.position.x, car.model.root.position.z, base);
          if (surface !== null && Number.isFinite(surface)) {
            this.probesHit = (this.probesHit ?? 0) + 1;
            const wanted = surface - base;
            // A first hit snaps; later ones ease, so streaming does not lurch.
            car.lift = car.lifted ? car.lift + (wanted - car.lift) * 0.5 : wanted;
            car.lifted = true;
          }
        }
      }
      this.#place(car);

      // Roll the wheels from distance travelled rather than a fixed rate, so
      // they match the speed the car is actually doing.
      car.wheelAngle += (car.speed * delta) / car.wheelRadius;
      car.model.spin(car.wheelAngle);

      if (car.model.root.position.distanceTo(playerPosition) > DESPAWN) {
        this.#scene.remove(car.model.root);
        this.#active.splice(i, 1);
      }
    }

    // One spawn attempt per frame at most: loading a model is async and
    // flooding the loader stalls the frame that needs it.
    if (this.#active.length + this.#inFlight < this.maxVehicles && this.#inFlight < 2) {
      this.#spawn(playerPosition);
    }
  }

  clear() {
    for (const car of this.#active) this.#scene.remove(car.model.root);
    this.#active.length = 0;
  }

  // Hand the nearest car over to the player. It leaves the simulation but stays
  // in the scene, so its paint, wheels and position carry straight across
  // rather than being swapped for a freshly loaded copy.
  takeNearest(position, maxDistance = 6) {
    let best = -1;
    let bestDistance = maxDistance * maxDistance;
    for (let i = 0; i < this.#active.length; i++) {
      const distance = this.#active[i].model.root.position.distanceToSquared(position);
      if (distance < bestDistance) { bestDistance = distance; best = i; }
    }
    if (best < 0) return null;
    const car = this.#active[best];
    this.#active.splice(best, 1);
    return { entry: car.entry, model: car.model, yaw: car.model.root.rotation.y };
  }

  // Take a car back into ambient traffic, on whatever segment it is nearest.
  // Returns false when it is nowhere near a road, in which case the caller
  // should just leave it standing.
  give(vehicle) {
    const position = vehicle.model.root.position;
    const candidates = this.#graph.edgesNear(position.x, position.z, 40, this.#edgeScratch);
    if (!candidates.length) return false;
    let edge = -1;
    let best = Infinity;
    for (const candidate of candidates) {
      const [a, b] = this.#graph.edgeNodes(candidate);
      this.#graph.node(a, this.#from);
      const distance = this.#from.distanceToSquared(position);
      if (distance < best) { best = distance; edge = candidate; }
    }
    if (edge < 0) return false;
    const [a, b] = this.#graph.edgeNodes(edge);
    const car = {
      entry: vehicle.entry,
      model: vehicle.model,
      from: Math.min(a, b),
      to: Math.max(a, b),
      t: 0,
      lane: 0,
      laneCount: this.#graph.laneCount(edge),
      speed: this.#cruiseSpeed(vehicle.entry),
      wheelAngle: 0,
      wheelRadius: vehicle.entry.wheelRadius?.[0] > 0.05 ? vehicle.entry.wheelRadius[0] : 0.35,
      lift: 0,
      probeTimer: 0,
      lifted: false,
    };
    this.#active.push(car);
    this.#place(car);
    return true;
  }

  getState() {
    return {
      enabled: this.enabled,
      hasGroundProbe: !!this.groundProbe,
      probesAttempted: this.probesAttempted ?? 0,
      probesHit: this.probesHit ?? 0,
      lifts: this.#active.map(car => Number(car.lift.toFixed(2))),
      count: this.#active.length,
      spawnable: this.#spawnable.length,
      max: this.maxVehicles,
      models: this.#active.map(car => car.entry.model),
      speeds: this.#active.map(car => Math.round(car.speed * 3.6)),
    };
  }

  // Per-car horizontal distance to the centreline of the segment it claims to
  // be driving on. A car should sit a lane offset away and no further, so this
  // is the single number that catches a bad graph, a bad lane offset or bad
  // stepping between nodes — none of which are obvious by eye at speed.
  debugCars() {
    const from = new THREE.Vector3();
    const to = new THREE.Vector3();
    const along = new THREE.Vector3();
    const relative = new THREE.Vector3();
    return this.#active.map((car, index) => {
      this.#graph.node(car.from, from);
      this.#graph.node(car.to, to);
      along.subVectors(to, from);
      along.y = 0;
      const length = along.length() || 1;
      along.divideScalar(length);
      relative.subVectors(car.model.root.position, from);
      relative.y = 0;
      const alongDistance = relative.dot(along);
      relative.addScaledVector(along, -alongDistance);
      return {
        index,
        model: car.entry.model,
        distanceToSegment: relative.length(),
        position: car.model.root.position.toArray(),
        speed: car.speed,
        from: car.from,
        to: car.to,
      };
    });
  }
}

// In the catalogue but not ambient traffic: emergency response, the airport and
// dock plant, and the rail stock. The wanted system spawns the police ones
// deliberately instead.
const NON_TRAFFIC = new Set([
  'police', 'police2', 'polmav', 'fbi', 'noose', 'nstockade',
  'ambulance', 'firetruk',
  'airtug', 'ripley', 'forklift', 'skylift',
  'subway_hi', 'subway_lo', 'cablecar',
  'rhino', 'apc',
]);
