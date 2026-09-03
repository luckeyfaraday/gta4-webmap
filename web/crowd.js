import * as THREE from 'three';
import { loadPed, loadClips, loadCatalogue } from './ped-model.js';

// Ambient pedestrians walking the navmesh.
//
// Same population model as traffic: peds are spawned into a ring beyond the near
// edge of view and culled outside a larger radius, so walking forward replaces
// the crowd rather than dragging it along.
//
// The clips are the shared library — one 1.8 MB fetch for the whole population
// — and they are namespaced by their source wad, because move_m@generic,
// move_f@generic and move_cop share 50 clip names between them. A female ped
// asking for "walk" would otherwise silently get the male cycle.

const SPAWN_MIN = 22;
const SPAWN_MAX = 90;
const DESPAWN = 140;

// Locomotion sets in the shared library, by the ped's own name prefix.
const SET_MALE = 'm@generic';
const SET_FEMALE = 'f@generic';
const SET_COP = 'cop';

export class Crowd {
  #nav;
  #scene;
  #renderer;
  #catalogue;
  #clips;
  #clipByName = new Map();
  #spawnable = [];
  #active = [];
  #inFlight = 0;
  #scratch = [];
  #stepScratch = [];
  #nextId = 1;

  constructor(nav, scene, renderer, catalogue, clips, options = {}) {
    this.#nav = nav;
    this.#scene = scene;
    this.#renderer = renderer;
    this.#catalogue = catalogue;
    this.#clips = clips;
    for (const clip of clips) this.#clipByName.set(clip.name, clip);

    this.maxPeds = options.maxPeds ?? 20;
    this.enabled = options.enabled ?? true;
    this.groundProbe = options.groundProbe ?? null;
    this.probeInterval = options.probeInterval ?? 0.25;

    // Police are spawned deliberately by the wanted system, not as ambient
    // crowd; everything else in the catalogue is fair game.
    this.#spawnable = catalogue.peds.filter(entry => !/_cop|_swat|_fbi/i.test(entry.ped));
  }

  static async create(nav, scene, renderer, options = {}) {
    const catalogue = await loadCatalogue();
    const clips = await loadClips(`./assets/peds/${catalogue.animations}`);
    return new Crowd(nav, scene, renderer, catalogue, clips, options);
  }

  get count() { return this.#active.length; }
  get spawnableCount() { return this.#spawnable.length; }

  #setFor(entry) {
    if (/_cop|_swat|_fbi/i.test(entry.ped)) return SET_COP;
    return entry.sex === 'f' ? SET_FEMALE : SET_MALE;
  }

  #clip(set, name) {
    return this.#clipByName.get(`${set}/${name}`) ?? this.#clipByName.get(`${SET_MALE}/${name}`) ?? null;
  }

  async #spawn(centre) {
    const candidates = this.#nav.near(centre.x, centre.z, SPAWN_MAX, this.#scratch);
    if (candidates.length === 0) return false;

    let index = -1;
    for (let attempt = 0; attempt < 16; attempt++) {
      const pick = candidates[(Math.random() * candidates.length) | 0];
      const dx = this.#nav.x[pick] - centre.x;
      const dz = this.#nav.z[pick] - centre.z;
      if (Math.hypot(dx, dz) >= SPAWN_MIN) { index = pick; break; }
    }
    if (index < 0) return false;

    const entry = this.#spawnable[(Math.random() * this.#spawnable.length) | 0];
    this.#inFlight++;
    let model;
    try {
      model = await loadPed(`./assets/peds/${entry.gltf}`, this.#renderer, { clone: true });
    } catch (error) {
      console.warn('Crowd: failed to load', entry.ped, error);
      return false;
    } finally {
      this.#inFlight--;
    }

    // Mirrored back into the map's reflected space, exactly as Niko is.
    model.root.scale.x = -1;
    model.root.userData.isPed = true;
    model.root.traverse(object => { object.userData.isPed = true; });

    const set = this.#setFor(entry);
    const mixer = new THREE.AnimationMixer(model.root);
    const walk = this.#clip(set, 'walk');
    const action = walk ? mixer.clipAction(walk) : null;
    action?.setLoop(THREE.LoopRepeat, Infinity).play();

    // Height before the ped is ever shown. Traffic can fall back on the road
    // graph's own node heights, but the navmesh carries none, so an unprobed
    // ped would stand at y=0 — which in this city is anywhere from a basement
    // to a rooftop below where it belongs. The player's height is the hint,
    // since peds only spawn within 90 m of them.
    const groundY = this.groundProbe
      ? this.groundProbe(this.#nav.x[index], this.#nav.z[index], centre.y)
      : 0;
    if (this.groundProbe && (groundY === null || !Number.isFinite(groundY))) return false;

    const heading = Math.random() * Math.PI * 2;
    const ped = {
      // A stable identity for the lifetime of this ped. Anything tracking a
      // ped between frames — accumulated bullet damage, for one — needs a key
      // that does not change as it walks, and the model name is shared by
      // every instance of that model.
      id: this.#nextId++,
      entry,
      model,
      mixer,
      action,
      set,
      from: index,
      to: this.#nav.step(index, Math.cos(heading), Math.sin(heading), this.#stepScratch),
      t: 0,
      // GTA IV's walk cycle runs in place, so travel speed is a tuning
      // constant here just as it is for Niko in app.js.
      speed: 1.25 + Math.random() * 0.35,
      lift: groundY ?? 0,
      lifted: true,
      probeTimer: Math.random() * this.probeInterval,
      yaw: heading,
    };
    if (ped.to < 0) ped.to = index;

    this.#active.push(ped);
    this.#scene.add(model.root);
    this.#place(ped);
    return true;
  }

  #place(ped) {
    const nav = this.#nav;
    const ax = nav.x[ped.from], az = nav.z[ped.from];
    const bx = nav.x[ped.to], bz = nav.z[ped.to];
    const x = ax + (bx - ax) * ped.t;
    const z = az + (bz - az) * ped.t;
    ped.model.root.position.set(x, ped.lift, z);

    const dx = bx - ax, dz = bz - az;
    if (dx || dz) {
      // The mesh is mirrored on x, so facing is measured in the mirrored frame
      // — the same correction Niko and the traffic need.
      ped.yaw = Math.atan2(-dx, -dz);
      ped.model.root.rotation.y = ped.yaw;
    }
  }

  update(delta, centre) {
    if (!this.enabled) return;

    for (let i = this.#active.length - 1; i >= 0; i--) {
      const ped = this.#active[i];
      const nav = this.#nav;
      const ax = nav.x[ped.from], az = nav.z[ped.from];
      const bx = nav.x[ped.to], bz = nav.z[ped.to];
      const length = Math.hypot(bx - ax, bz - az) || 1;

      ped.t += (ped.speed * delta) / length;
      while (ped.t >= 1) {
        ped.t -= 1;
        const dirX = (bx - ax) / length;
        const dirZ = (bz - az) / length;
        const next = nav.step(ped.to, dirX, dirZ, this.#stepScratch);
        ped.from = ped.to;
        ped.to = next >= 0 ? next : ped.from;
        // Ground height changes at segment boundaries — a kerb, a step, the lip
        // of a plaza — so probe on arrival rather than waiting out the timer.
        // Otherwise a ped spends up to a quarter second at the old height,
        // which is a step's worth of floating.
        ped.probeTimer = 0;
      }

      // The navmesh carries no height — the per-tile Z base is not in the file
      // — so the ground under each ped is probed against the streamed city.
      if (this.groundProbe) {
        ped.probeTimer -= delta;
        if (ped.probeTimer <= 0) {
          ped.probeTimer = this.probeInterval;
          const surface = this.groundProbe(ped.model.root.position.x, ped.model.root.position.z, ped.lift);
          if (surface !== null && Number.isFinite(surface)) {
            // Ease over gentle ground so a walk does not stair-step, but snap
            // across anything abrupt — a kerb, steps, or crossing between two
            // levels of navmesh. Easing everything leaves a ped hanging a metre
            // off the pavement for about a second after a change in height.
            const step = surface - ped.lift;
            ped.lift = Math.abs(step) > 0.25 ? surface : ped.lift + step * 0.4;
          }
        }
      }

      this.#place(ped);
      ped.mixer.update(delta);

      if (ped.model.root.position.distanceTo(centre) > DESPAWN) {
        this.#scene.remove(ped.model.root);
        this.#active.splice(i, 1);
      }
    }

    if (this.#active.length + this.#inFlight < this.maxPeds && this.#inFlight < 2) {
      this.#spawn(centre);
    }
  }

  clear() {
    for (const ped of this.#active) this.#scene.remove(ped.model.root);
    this.#active.length = 0;
  }

  // Take one ped out of the world — what happens when the player attacks it.
  // Matches by model name, removing the nearest instance of it when several are
  // out, so the caller does not have to hold a handle to a private object.
  remove(which, near = null) {
    let best = -1;
    // By id when given one, which is exact; by model name otherwise, taking the
    // nearest instance, which is what a melee attack means by "that one".
    if (typeof which === 'number') {
      best = this.#active.findIndex(ped => ped.id === which);
    } else {
      let bestDistance = Infinity;
      for (let i = 0; i < this.#active.length; i++) {
        if (this.#active[i].entry.ped !== which) continue;
        const distance = near ? this.#active[i].model.root.position.distanceTo(near) : 0;
        if (distance < bestDistance) { bestDistance = distance; best = i; }
      }
    }
    if (best < 0) return false;
    this.#scene.remove(this.#active[best].model.root);
    this.#active.splice(best, 1);
    return true;
  }

  getState() {
    return {
      enabled: this.enabled,
      count: this.#active.length,
      spawnable: this.#spawnable.length,
      max: this.maxPeds,
      clips: this.#clips.length,
      hasGroundProbe: !!this.groundProbe,
      peds: this.#active.map(ped => ped.entry.ped),
      sets: this.#active.map(ped => ped.set),
      // Which clip each ped is actually playing, so a set mix-up is visible as
      // data rather than as a female ped with a male gait.
      playing: this.#active.map(ped => ped.action?.getClip().name ?? null),
    };
  }

  // Per-ped distance from the segment of navmesh it claims to be walking along,
  // and its distance to the nearest walkable point. Both should be small.
  debugPeds() {
    const nav = this.#nav;
    return this.#active.map(ped => {
      const position = ped.model.root.position;
      const nearest = nav.nearest(position.x, position.z, 25);
      return {
        id: ped.id,
        ped: ped.entry.ped,
        set: ped.set,
        position: position.toArray(),
        offNavmesh: nearest < 0 ? Infinity : Math.hypot(nav.x[nearest] - position.x, nav.z[nearest] - position.z),
      };
    });
  }
}
