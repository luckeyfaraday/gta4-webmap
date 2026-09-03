import * as THREE from 'three';
import { loadPed, loadClips, loadCatalogue as loadPedCatalogue } from './ped-model.js';
import { loadVehicle, loadCatalogue as loadVehicleCatalogue } from './vehicle-model.js';

// The police response to a wanted level: officers on foot who run the navmesh
// toward the player, and cruisers that drive the road graph toward them.
//
// Nothing here decides difficulty — it reads `wanted.response`, so the numbers
// behind a three-star chase all live in wanted.js.
//
// The units are the ones the ambient systems deliberately hold back:
// traffic.js keeps the police vehicles out of its rotation and crowd.js keeps
// the cop peds out of its own, so they only ever appear because of this.

const OFFICER_MODELS = ['m_y_cop', 'm_y_cop_traffic'];
const SWAT_MODELS = ['m_y_swat', 'm_m_fbi'];
const CAR_MODELS = ['police', 'police2'];
const SWAT_CAR_MODELS = ['noose', 'fbi'];

// How close an officer has to be, and how clear the line, to count as having
// seen the player. Sight is what holds a wanted level up.
const SIGHT_RANGE = 70;
const ARRIVE_DISTANCE = 2.5;

export class Police {
  #nav;
  #graph;
  #scene;
  #renderer;
  #wanted;
  #clips;
  #clipByName = new Map();
  #pedCatalogue;
  #vehicleCatalogue;
  #officers = [];
  #cars = [];
  #inFlight = 0;
  #scratch = [];
  #stepScratch = [];
  #nextId = 1;

  constructor(nav, graph, scene, renderer, wanted, pedCatalogue, clips, vehicleCatalogue, options = {}) {
    this.#nav = nav;
    this.#graph = graph;
    this.#scene = scene;
    this.#renderer = renderer;
    this.#wanted = wanted;
    this.#pedCatalogue = pedCatalogue;
    this.#vehicleCatalogue = vehicleCatalogue;
    this.#clips = clips;
    for (const clip of clips) this.#clipByName.set(clip.name, clip);

    this.enabled = options.enabled ?? true;
    this.groundProbe = options.groundProbe ?? null;
    this.probeInterval = options.probeInterval ?? 0.25;
  }

  static async create(nav, graph, scene, renderer, wanted, options = {}) {
    const pedCatalogue = await loadPedCatalogue();
    const clips = await loadClips(`./assets/peds/${pedCatalogue.animations}`);
    const vehicleCatalogue = await loadVehicleCatalogue();
    return new Police(nav, graph, scene, renderer, wanted, pedCatalogue, clips, vehicleCatalogue, options);
  }

  get officerCount() { return this.#officers.length; }
  get carCount() { return this.#cars.length; }

  // Officers use the cop locomotion set from move_cop.wad. It is a small set —
  // six clips — so anything it lacks falls back to the male generic set.
  #clip(name) {
    return this.#clipByName.get(`cop/${name}`) ?? this.#clipByName.get(`m@generic/${name}`) ?? null;
  }

  #available(models, catalogue, key) {
    return models.map(name => catalogue.find(entry => entry[key] === name)).filter(Boolean);
  }

  async #spawnOfficer(centre, swat) {
    const pool = this.#available(swat ? SWAT_MODELS : OFFICER_MODELS, this.#pedCatalogue.peds, 'ped');
    if (!pool.length) return false;
    const entry = pool[(Math.random() * pool.length) | 0];
    const radius = this.#wanted.response.spawnRadius;

    // Spawn out of sight behind the player where possible: an officer that
    // blinks into view in front of you reads as a cheat rather than a response.
    const candidates = this.#nav.near(centre.x, centre.z, radius, this.#scratch);
    if (!candidates.length) return false;
    let index = -1;
    for (let attempt = 0; attempt < 20; attempt++) {
      const pick = candidates[(Math.random() * candidates.length) | 0];
      const distance = Math.hypot(this.#nav.x[pick] - centre.x, this.#nav.z[pick] - centre.z);
      if (distance > radius * 0.45) { index = pick; break; }
    }
    if (index < 0) return false;

    const groundY = this.groundProbe
      ? this.groundProbe(this.#nav.x[index], this.#nav.z[index], centre.y)
      : 0;
    if (this.groundProbe && (groundY === null || !Number.isFinite(groundY))) return false;

    this.#inFlight++;
    let model;
    try {
      model = await loadPed(`./assets/peds/${entry.gltf}`, this.#renderer, { clone: true });
    } catch (error) {
      console.warn('Police: failed to load officer', entry.ped, error);
      return false;
    } finally {
      this.#inFlight--;
    }

    model.root.scale.x = -1;
    model.root.userData.isPed = true;
    model.root.traverse(object => { object.userData.isPed = true; });

    const mixer = new THREE.AnimationMixer(model.root);
    const officer = {
      // Stable for this officer's lifetime; see the note in crowd.js.
      id: this.#nextId++,
      entry, model, mixer, swat,
      actions: {},
      state: null,
      from: index,
      to: index,
      t: 0,
      lift: groundY ?? 0,
      probeTimer: Math.random() * this.probeInterval,
    };
    for (const name of ['idle', 'walk', 'run']) {
      const clip = this.#clip(name);
      if (clip) officer.actions[name] = mixer.clipAction(clip);
    }
    this.#play(officer, 'run');
    this.#officers.push(officer);
    this.#scene.add(model.root);
    model.root.position.set(this.#nav.x[index], officer.lift, this.#nav.z[index]);
    return true;
  }

  #play(officer, name) {
    const next = officer.actions[name] ?? officer.actions.walk ?? officer.actions.idle;
    if (!next || officer.state === name) return;
    next.reset().setLoop(THREE.LoopRepeat, Infinity).play();
    const current = officer.actions[officer.state];
    if (current && current !== next) current.crossFadeTo(next, 0.25, false);
    officer.state = name;
  }

  async #spawnCar(centre, swat) {
    const pool = this.#available(swat ? SWAT_CAR_MODELS : CAR_MODELS, this.#vehicleCatalogue.vehicles, 'model');
    if (!pool.length || !this.#graph) return false;
    const entry = pool[(Math.random() * pool.length) | 0];
    const radius = this.#wanted.response.spawnRadius;

    const edges = this.#graph.edgesNear(centre.x, centre.z, radius, this.#scratch);
    if (!edges.length) return false;
    let edge = -1;
    for (let attempt = 0; attempt < 16; attempt++) {
      const pick = edges[(Math.random() * edges.length) | 0];
      const [a] = this.#graph.edgeNodes(pick);
      const distance = Math.hypot(
        this.#graph.positions[a * 3] - centre.x,
        this.#graph.positions[a * 3 + 2] - centre.z);
      if (distance > radius * 0.5) { edge = pick; break; }
    }
    if (edge < 0) return false;

    this.#inFlight++;
    let model;
    try {
      model = await loadVehicle(`./assets/vehicles/${entry.gltf}`, this.#renderer, { clone: true });
    } catch (error) {
      console.warn('Police: failed to load cruiser', entry.model, error);
      return false;
    } finally {
      this.#inFlight--;
    }

    // Police liveries are painted, not tinted: the model carries a single
    // carcols set and it is the right one, so it is applied as-is.
    const sets = entry.colourSets;
    if (sets?.length) {
      const colour = this.#vehicleCatalogue.palette[sets[0][0]];
      if (colour) model.paint(colour.rgb);
    }
    model.root.scale.x = -1;
    model.root.userData.isVehicle = true;
    model.root.traverse(object => { object.userData.isVehicle = true; });

    const [a, b] = this.#graph.edgeNodes(edge);
    const car = {
      id: this.#nextId++,
      entry, model,
      from: Math.min(a, b),
      to: Math.max(a, b),
      t: Math.random(),
      wheelAngle: 0,
      wheelRadius: entry.wheelRadius?.[0] > 0.05 ? entry.wheelRadius[0] : 0.35,
      lift: 0,
      lifted: false,
      probeTimer: Math.random() * this.probeInterval,
    };
    this.#cars.push(car);
    this.#scene.add(model.root);
    return true;
  }

  // Officers head for the player over the navmesh, one walkable point at a
  // time. This is a greedy step toward the target rather than a planned route:
  // with points every 2.5 m it follows pavements well enough, and a real A*
  // over 910k points is not what a chase needs to feel right.
  #advanceOfficer(officer, target, delta, speed) {
    const nav = this.#nav;
    const position = officer.model.root.position;
    const toTarget = new THREE.Vector3().subVectors(target, position);
    toTarget.y = 0;
    const distance = toTarget.length();

    if (distance <= ARRIVE_DISTANCE) {
      this.#play(officer, 'idle');
    } else {
      this.#play(officer, speed > 2.2 ? 'run' : 'walk');
      toTarget.normalize();
      const ax = nav.x[officer.from], az = nav.z[officer.from];
      const bx = nav.x[officer.to], bz = nav.z[officer.to];
      const segment = Math.hypot(bx - ax, bz - az) || 1;
      officer.t += (speed * delta) / segment;
      while (officer.t >= 1) {
        officer.t -= 1;
        const next = nav.step(officer.to, toTarget.x, toTarget.z, this.#stepScratch);
        officer.from = officer.to;
        officer.to = next >= 0 ? next : officer.from;
        // Height changes at segment boundaries; probe on arrival. See crowd.js.
        officer.probeTimer = 0;
      }
      const nax = nav.x[officer.from], naz = nav.z[officer.from];
      const nbx = nav.x[officer.to], nbz = nav.z[officer.to];
      position.set(nax + (nbx - nax) * officer.t, officer.lift, naz + (nbz - naz) * officer.t);
      const dx = nbx - nax, dz = nbz - naz;
      // Mirrored frame, as everywhere else in the viewer.
      if (dx || dz) officer.model.root.rotation.y = Math.atan2(-dx, -dz);
    }

    if (this.groundProbe) {
      officer.probeTimer -= delta;
      if (officer.probeTimer <= 0) {
        officer.probeTimer = this.probeInterval;
        const surface = this.groundProbe(position.x, position.z, officer.lift);
        if (surface !== null && Number.isFinite(surface)) {
          const step = surface - officer.lift;
          officer.lift = Math.abs(step) > 0.5 ? surface : officer.lift + step * 0.4;
        }
      }
    }
    position.y = officer.lift;
    officer.mixer.update(delta);
    return distance;
  }

  // Cruisers drive the road graph, choosing at each junction whichever exit
  // points most nearly at the player. Same greedy idea as the officers.
  #advanceCar(car, target, delta, speed) {
    const graph = this.#graph;
    const from = new THREE.Vector3(), to = new THREE.Vector3();
    graph.node(car.from, from);
    graph.node(car.to, to);
    const forward = new THREE.Vector3().subVectors(to, from);
    const length = forward.length() || 1;
    forward.divideScalar(length);

    car.t += (speed * delta) / length;
    while (car.t >= 1) {
      car.t -= 1;
      // Pick the neighbour that most reduces the distance to the player.
      const start = graph.neighbourStart[car.to];
      const end = graph.neighbourStart[car.to + 1];
      let best = -1, bestScore = Infinity;
      for (let i = start; i < end; i++) {
        const candidate = graph.neighbours[i];
        if (candidate === car.from && end - start > 1) continue;
        const dx = graph.positions[candidate * 3] - target.x;
        const dz = graph.positions[candidate * 3 + 2] - target.z;
        const score = dx * dx + dz * dz;
        if (score < bestScore) { bestScore = score; best = candidate; }
      }
      car.from = car.to;
      car.to = best >= 0 ? best : car.from;
      graph.node(car.from, from);
      graph.node(car.to, to);
    }

    graph.node(car.from, from);
    graph.node(car.to, to);
    const position = from.clone().lerp(to, Math.min(1, Math.max(0, car.t)));
    if (this.groundProbe) {
      car.probeTimer -= delta;
      if (car.probeTimer <= 0) {
        car.probeTimer = this.probeInterval;
        const surface = this.groundProbe(position.x, position.z, position.y);
        if (surface !== null && Number.isFinite(surface)) {
          const wanted = surface - position.y;
          car.lift = car.lifted ? car.lift + (wanted - car.lift) * 0.5 : wanted;
          car.lifted = true;
        }
      }
    }
    position.y += car.lift;
    car.model.root.position.copy(position);
    const direction = new THREE.Vector3().subVectors(to, from).normalize();
    car.model.root.rotation.y = Math.atan2(-direction.x, -direction.z);
    car.wheelAngle += (speed * delta) / car.wheelRadius;
    car.model.spin(car.wheelAngle);
    return position.distanceTo(target);
  }

  #trim(list, allowed, target) {
    while (list.length > allowed) {
      let furthest = 0;
      let best = -Infinity;
      for (let i = 0; i < list.length; i++) {
        const distance = list[i].model.root.position.distanceToSquared(target);
        if (distance > best) { best = distance; furthest = i; }
      }
      this.#scene.remove(list[furthest].model.root);
      list.splice(furthest, 1);
    }
  }

  // Take one unit out — what happens when the player shoots an officer.
  remove(id) {
    for (const list of [this.#officers, this.#cars]) {
      const index = list.findIndex(unit => unit.id === id);
      if (index < 0) continue;
      this.#scene.remove(list[index].model.root);
      list.splice(index, 1);
      return true;
    }
    return false;
  }

  #despawn(list, item) {
    this.#scene.remove(item.model.root);
    list.splice(list.indexOf(item), 1);
  }

  update(delta, target) {
    if (!this.enabled) return;
    const response = this.#wanted.response;

    // Stand down when the level clears: units leave rather than linger.
    if (response.stars === 0) {
      if (this.#officers.length || this.#cars.length) this.clear();
      this.#wanted.update(delta, false);
      return;
    }

    let seen = false;
    let nearest = Infinity;

    for (let i = this.#officers.length - 1; i >= 0; i--) {
      const officer = this.#officers[i];
      const distance = this.#advanceOfficer(officer, target, delta, response.speed);
      nearest = Math.min(nearest, distance);
      if (distance < SIGHT_RANGE) seen = true;
      // Officers give up if the player gets a long way clear.
      if (distance > response.spawnRadius * 2.5) this.#despawn(this.#officers, officer);
    }

    for (let i = this.#cars.length - 1; i >= 0; i--) {
      const car = this.#cars[i];
      const distance = this.#advanceCar(car, target, delta, response.speed * 3.2);
      nearest = Math.min(nearest, distance);
      if (distance < SIGHT_RANGE) seen = true;
      if (distance > response.spawnRadius * 3) this.#despawn(this.#cars, car);
    }

    // A sighting holds the wanted level up; silence lets it cool.
    this.#wanted.update(delta, seen);

    // Shed units the current level no longer justifies — the furthest first, so
    // the response thins from the edges rather than vanishing from under the
    // player's nose as the level falls.
    this.#trim(this.#officers, response.officers, target);
    this.#trim(this.#cars, response.cars, target);

    // In-flight spawns count against the cap. Without that, two loads can be in
    // the air while the list is still short and the response overshoots — four
    // cruisers turning up for a three-cruiser wanted level.
    if (this.#inFlight < 2) {
      if (this.#officers.length + this.#inFlight < response.officers) {
        this.#spawnOfficer(target, response.swat && Math.random() < 0.5);
      } else if (this.#cars.length + this.#inFlight < response.cars) {
        this.#spawnCar(target, response.swat && Math.random() < 0.4);
      }
    }

    this.nearestDistance = nearest;
    this.seen = seen;
  }

  clear() {
    for (const officer of this.#officers) this.#scene.remove(officer.model.root);
    for (const car of this.#cars) this.#scene.remove(car.model.root);
    this.#officers.length = 0;
    this.#cars.length = 0;
  }

  getState() {
    return {
      enabled: this.enabled,
      officers: this.#officers.length,
      cars: this.#cars.length,
      officerModels: this.#officers.map(officer => officer.entry.ped),
      carModels: this.#cars.map(car => car.entry.model),
      states: this.#officers.map(officer => officer.state),
      playing: this.#officers.map(officer => officer.actions[officer.state]?.getClip().name ?? null),
      nearestDistance: Number.isFinite(this.nearestDistance) ? Number(this.nearestDistance.toFixed(1)) : null,
      seen: !!this.seen,
    };
  }

  debugUnits() {
    return [
      ...this.#officers.map(officer => ({
        id: officer.id, kind: 'officer', model: officer.entry.ped, position: officer.model.root.position.toArray(),
      })),
      ...this.#cars.map(car => ({
        id: car.id, kind: 'car', model: car.entry.model, position: car.model.root.position.toArray(),
      })),
    ];
  }
}
