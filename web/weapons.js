import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DDSLoader } from 'three/addons/loaders/DDSLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

// Weapons and combat.
//
// The three weapons are the game's own — w_glock, w_m4 and rpg out of
// weapons.img — and everything about how they behave comes from
// WeaponInfo.xml: damage, clip size, the gap between shots, range and reload
// time. The pistol really does fire every 333 ms for 25 damage from a
// 17-round magazine, because that is what the file says.
//
// The animations are the game's own too. gun@handgun, gun@rifle and gun@rocket
// are exported against Niko's skeleton into a separate clip library, namespaced
// by set because all three name their clips `fire`, `reload`, `holster` and
// `unholster` identically. move_rifle and move_rpg are the armed walk cycles.
//
// Hits are resolved against ped POSITIONS rather than by raycasting their
// meshes. A ped is a skinned mesh whose bounding volume is the bind pose, so
// mesh raycasting is both expensive and wrong mid-stride; a capsule around the
// spine is what the shot is really aimed at anyway.

// Everything from the spine up. A weapon clip is layered onto these bones only,
// so the legs keep whatever the locomotion is doing and the arms do the gun
// work. The lower body is Char (the root), Char_Pelvis, and the two leg chains;
// everything else on Niko's 90-bone skeleton hangs off Char_Spine.
const LOWER_BODY = new Set([
  'Char', 'Char_Pelvis',
  'Char_L_Thigh', 'Char_L_Calf', 'Char_L_Foot', 'Char_L_Toe0', 'L_Calf_Roll',
  'Char_R_Thigh', 'Char_R_Calf', 'Char_R_Foot', 'Char_R_Toe0', 'R_Calf_Roll',
]);

const HIT_RADIUS = 0.55;      // how near the ray must pass to count as a hit
const PED_HEALTH = 100;
const ROCKET_SPEED = 38;
const BLAST_RADIUS = 9;

export class Weapons {
  #scene;
  #renderer;
  #catalogue;
  #clips = [];
  #clipByName = new Map();
  #models = new Map();
  #rocketModel = null;
  #held = null;
  #hand = null;
  #mixer = null;
  #action = null;
  #rockets = [];
  #health = new Map();
  #restPose = new Map();
  #additive = new Map();

  constructor(scene, renderer, catalogue, clips, options = {}) {
    this.#scene = scene;
    this.#renderer = renderer;
    this.#catalogue = catalogue;
    this.#clips = clips;
    for (const clip of clips) this.#clipByName.set(clip.name, clip);
    this.crowd = options.crowd ?? null;
    this.police = options.police ?? null;
    this.wanted = options.wanted ?? null;
    this.groundProbe = options.groundProbe ?? null;
    this.state = { slot: null, ammo: 0, reserve: 0, reloading: false, cooldown: 0 };
  }

  static async create(scene, renderer, options = {}) {
    const catalogue = await fetch('./assets/weapons/weapons.json').then(response => {
      if (!response.ok) throw new Error(`weapons.json: ${response.status}`);
      return response.json();
    });
    const loader = () => new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const clips = await loader()
      .loadAsync(new URL(catalogue.clips, new URL('./assets/weapons/', location.href)).href)
      .then(gltf => gltf.animations)
      .catch(error => { console.warn('Weapon clips unavailable', error); return []; });
    return new Weapons(scene, renderer, catalogue, clips, options);
  }

  get weapons() { return this.#catalogue.weapons; }
  get held() { return this.#held; }
  get clipCount() { return this.#clips.length; }

  // Bind to the character: the weapon hangs off his right hand bone, and the
  // armed clips play on his own mixer so they blend with his locomotion.
  attachTo(characterRoot, mixer) {
    this.#hand = characterRoot?.getObjectByName('Char_R_Hand') ?? null;
    this.#mixer = mixer ?? null;

    // Capture the bind pose while nothing has animated yet. It is the
    // reference an additive clip is measured against: the layer we want is
    // "the weapon pose MINUS rest", so that adding it to a running pose raises
    // the arms into the aim without disturbing the legs.
    this.#restPose.clear();
    characterRoot?.traverse(object => {
      if (!object.isBone && !object.name) return;
      this.#restPose.set(object.name, {
        position: object.position.clone(),
        quaternion: object.quaternion.clone(),
      });
    });
    return !!this.#hand;
  }

  // An upper-body, additive version of a weapon clip.
  //
  // Two things have to be true for shooting while running to look right. The
  // clip must not touch the legs, or the gun animation's own stance fights the
  // stride; and it must be additive, because three.js averages two normal
  // actions that drive the same bone, so a full-weight fire clip over a
  // full-weight run gives a half-hearted blend of both rather than one on top
  // of the other.
  //
  // The delta is computed here rather than with AnimationUtils.makeClipAdditive
  // because that pairs target and reference tracks BY INDEX, which does not
  // survive dropping the lower-body tracks.
  #upperBody(clip) {
    if (this.#additive.has(clip.name)) return this.#additive.get(clip.name);

    const tracks = [];
    for (const track of clip.tracks) {
      const bone = track.name.slice(0, track.name.lastIndexOf('.'));
      const property = track.name.slice(track.name.lastIndexOf('.') + 1);
      if (LOWER_BODY.has(bone)) continue;
      const rest = this.#restPose.get(bone);
      if (!rest) continue;

      const copy = track.clone();
      const values = copy.values;
      if (property === 'quaternion') {
        // Additive quaternions are deltas: rest⁻¹ * pose.
        const inverse = rest.quaternion.clone().invert();
        const q = new THREE.Quaternion();
        for (let i = 0; i < values.length; i += 4) {
          q.set(values[i], values[i + 1], values[i + 2], values[i + 3]);
          q.premultiply(inverse);
          values[i] = q.x; values[i + 1] = q.y; values[i + 2] = q.z; values[i + 3] = q.w;
        }
      } else if (property === 'position') {
        for (let i = 0; i < values.length; i += 3) {
          values[i] -= rest.position.x;
          values[i + 1] -= rest.position.y;
          values[i + 2] -= rest.position.z;
        }
      } else {
        continue;
      }
      tracks.push(copy);
    }

    const built = tracks.length ? new THREE.AnimationClip(clip.name + '#upper', clip.duration, tracks) : null;
    this.#additive.set(clip.name, built);
    return built;
  }

  async #load(weapon) {
    if (this.#models.has(weapon.model)) return this.#models.get(weapon.model);
    const url = `./assets/weapons/${weapon.gltf}`;
    const promise = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url).then(async gltf => {
      const root = gltf.scene;
      const base = new URL(url, location.href);
      const ddsLoader = new DDSLoader();
      const jobs = [];
      root.traverse(object => {
        if (!object.isMesh) return;
        object.frustumCulled = false;
        for (const material of [object.material].flat()) {
          material.metalness = 0.15;
          material.roughness = 0.6;
          const source = material.userData?.texture;
          if (!source) continue;
          jobs.push(ddsLoader.loadAsync(new URL(source, base).href).then(texture => {
            texture.flipY = false;
            texture.colorSpace = THREE.SRGBColorSpace;
            material.map = texture;
            material.color.set(0xffffff);
            material.needsUpdate = true;
          }).catch(() => {}));
        }
      });
      await Promise.all(jobs);
      return root;
    });
    this.#models.set(weapon.model, promise);
    return promise;
  }

  // Put a weapon in his hand. The grip offsets below are tuned by eye: GTA IV
  // stores weapon attachment transforms in data this project does not read, so
  // these are the one part of the weapon setup that is NOT from the game files.
  async equip(type) {
    const weapon = this.#catalogue.weapons.find(entry => entry.type === type);
    if (!weapon) return null;
    if (this.#held?.weapon.type === type) return this.#held;

    const model = await this.#load(weapon);
    this.unequip();
    const held = model.clone(true);
    const grip = GRIPS[type] ?? GRIPS.PISTOL;
    held.position.fromArray(grip.position);
    held.rotation.fromArray(grip.rotation);
    held.scale.setScalar(grip.scale ?? 1);
    if (this.#hand) this.#hand.add(held);

    this.#held = {
      weapon,
      object: held,
      set: weapon.animSet,
      ammo: weapon.clipSize,
      reserve: Math.max(0, weapon.ammoMax - weapon.clipSize),
    };
    this.state.slot = weapon.slot;
    this.#refreshState();
    this.#playSet('unholster', { loop: false });
    return this.#held;
  }

  unequip() {
    if (this.#held?.object?.parent) this.#held.object.parent.remove(this.#held.object);
    this.#held = null;
    this.#stopAction();
    this.#refreshState();
  }

  #clip(set, name) {
    return this.#clipByName.get(`${set}/${name}`) ?? null;
  }

  #stopAction() {
    if (this.#action) { this.#action.fadeOut(0.15); this.#action = null; }
  }

  // Play a weapon clip as an upper-body layer on top of whatever the legs are
  // doing. Additive blend mode, so it adds to the locomotion rather than being
  // averaged with it.
  #playSet(name, { loop = true } = {}) {
    if (!this.#mixer || !this.#held) return null;
    const source = this.#clip(this.#held.set, name);
    if (!source) return null;
    const clip = this.#upperBody(source) ?? source;

    const action = this.#mixer.clipAction(clip);
    action.blendMode = THREE.AdditiveAnimationBlendMode;
    action.reset();
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    action.clampWhenFinished = !loop;
    action.setEffectiveWeight(1);
    action.fadeIn(0.12).play();
    if (this.#action && this.#action !== action) this.#action.fadeOut(0.12);
    this.#action = action;
    return action;
  }

  // Which full-body locomotion clip the legs should be running while this
  // weapon is held. GTA IV walks differently with a rifle or a launcher on the
  // shoulder and ships whole sets for both (move_rifle, move_rpg); a pistol
  // uses the ordinary walk, as it does in the game.
  baseClip(gait) {
    const set = this.#held?.weapon.moveSet;
    if (!set) return null;
    const clip = this.#clipByName.get(`${set}/${gait}`);
    return clip ?? null;
  }

  // The armed locomotion clips, for the caller to register on its own mixer.
  locomotionClips() {
    return this.#clips.filter(clip => clip.name.startsWith('move_rifle/') || clip.name.startsWith('move_rpg/'));
  }

  #refreshState() {
    this.state.ammo = this.#held?.ammo ?? 0;
    this.state.reserve = this.#held?.reserve ?? 0;
    this.state.slot = this.#held?.weapon.slot ?? null;
  }

  reload() {
    const held = this.#held;
    if (!held || this.state.reloading || held.ammo >= held.weapon.clipSize || held.reserve <= 0) return false;
    this.state.reloading = true;
    this.#playSet('reload', { loop: false });
    // WeaponInfo.xml's own reload time.
    setTimeout(() => {
      const need = held.weapon.clipSize - held.ammo;
      const taken = Math.min(need, held.reserve);
      held.ammo += taken;
      held.reserve -= taken;
      this.state.reloading = false;
      this.#refreshState();
    }, held.weapon.reloadTime);
    return true;
  }

  // Everything the player could shoot, as points with a health record.
  #targets() {
    const list = [];
    if (this.crowd) {
      for (const ped of this.crowd.debugPeds()) {
        list.push({ kind: 'ped', id: ped.id, model: ped.ped, position: ped.position });
      }
    }
    if (this.police) {
      for (const unit of this.police.debugUnits()) {
        list.push({
          kind: unit.kind === 'car' ? 'policeCar' : 'officer',
          id: unit.id, model: unit.model, position: unit.position,
        });
      }
    }
    return list;
  }

  // Health is keyed on the target's own id, not on where it is standing. An
  // earlier version keyed on rounded position, which meant a walking ped got a
  // fresh 100 health every time it moved a few centimetres and could never be
  // shot dead.
  #key(target) { return target.kind + ':' + target.id; }

  // Nearest target whose centre passes within HIT_RADIUS of the shot.
  #hitScan(origin, direction, range) {
    let best = null;
    let bestDistance = range;
    for (const target of this.#targets()) {
      const dx = target.position[0] - origin.x;
      const dy = target.position[1] + 1.0 - origin.y;   // aim at the chest, not the feet
      const dz = target.position[2] - origin.z;
      const along = dx * direction.x + dy * direction.y + dz * direction.z;
      if (along < 0 || along > bestDistance) continue;
      const perpendicular = Math.hypot(dx - direction.x * along, dy - direction.y * along, dz - direction.z * along);
      if (perpendicular > HIT_RADIUS) continue;
      bestDistance = along;
      best = { target, distance: along };
    }
    return best;
  }

  #kill(target, crime) {
    if (target.kind === 'ped') this.crowd?.remove(target.id);
    else this.police?.remove(target.id);
    this.wanted?.report(crime ?? (target.kind === 'ped' ? 'pedKilled' : 'copKilled'));
  }

  // Pull the trigger. Returns what happened, so the caller can show it.
  fire(origin, direction) {
    const held = this.#held;
    if (!held || this.state.reloading || this.state.cooldown > 0) return null;
    if (held.ammo <= 0) { this.reload(); return { empty: true }; }

    held.ammo--;
    this.state.cooldown = held.weapon.timeBetweenShots / 1000;
    this.#refreshState();
    this.#playSet('fire', { loop: false });
    this.wanted?.report('shotFired', { witnessed: true });

    if (held.weapon.fireType === 'PROJECTILE') {
      this.#launchRocket(origin, direction);
      return { fired: true, projectile: true, ammo: held.ammo };
    }

    const hit = this.#hitScan(origin, direction, held.weapon.weaponRange);
    if (!hit) return { fired: true, hit: null, ammo: held.ammo };

    // Instant-hit weapons do their damage now. Health is tracked per target so
    // a pistol takes four shots where the M4 takes four faster ones.
    const key = this.#key(hit.target);
    const remaining = (this.#health.get(key) ?? PED_HEALTH) - held.weapon.damage;
    if (remaining <= 0) {
      this.#health.delete(key);
      this.#kill(hit.target);
      return { fired: true, hit: hit.target.kind, killed: true, id: hit.target.id, model: hit.target.model, ammo: held.ammo };
    }
    this.#health.set(key, remaining);
    this.wanted?.report(hit.target.kind === 'officer' ? 'copInjured' : 'pedInjured');
    return { fired: true, hit: hit.target.kind, killed: false, remaining, id: hit.target.id, ammo: held.ammo };
  }

  async #launchRocket(origin, direction) {
    const info = this.#catalogue.projectile;
    if (!info) return;
    const model = await this.#load(info);
    const rocket = model.clone(true);
    rocket.position.copy(origin);
    rocket.userData.isProjectile = true;
    this.#scene.add(rocket);
    this.#rockets.push({
      object: rocket,
      direction: direction.clone().normalize(),
      travelled: 0,
      range: this.#catalogue.weapons.find(w => w.fireType === 'PROJECTILE')?.weaponRange ?? 100,
    });
  }

  // Rockets fly straight and detonate on the first thing they reach — a target,
  // the ground, or the end of their range.
  #updateRockets(delta) {
    for (let i = this.#rockets.length - 1; i >= 0; i--) {
      const rocket = this.#rockets[i];
      const step = ROCKET_SPEED * delta;
      rocket.object.position.addScaledVector(rocket.direction, step);
      rocket.travelled += step;

      const position = rocket.object.position;
      let detonate = rocket.travelled >= rocket.range;
      if (!detonate && this.groundProbe) {
        const ground = this.groundProbe(position.x, position.z, position.y);
        if (ground !== null && Number.isFinite(ground) && position.y <= ground + 0.4) detonate = true;
      }
      if (!detonate) {
        for (const target of this.#targets()) {
          if (Math.hypot(target.position[0] - position.x, target.position[2] - position.z) < 1.4) { detonate = true; break; }
        }
      }
      if (!detonate) continue;

      this.#explode(position);
      this.#scene.remove(rocket.object);
      this.#rockets.splice(i, 1);
    }
  }

  #explode(at) {
    let killed = 0;
    for (const target of this.#targets()) {
      const distance = Math.hypot(
        target.position[0] - at.x, target.position[1] - at.y, target.position[2] - at.z);
      if (distance > BLAST_RADIUS) continue;
      this.#kill(target);
      killed++;
    }
    this.lastExplosion = { at: at.toArray(), killed };
    return killed;
  }

  update(delta) {
    if (this.state.cooldown > 0) this.state.cooldown = Math.max(0, this.state.cooldown - delta);
    this.#updateRockets(delta);
  }

  getState() {
    return {
      available: this.#catalogue.weapons.map(weapon => weapon.type),
      clips: this.#clips.length,
      attached: !!this.#hand,
      held: this.#held ? {
        type: this.#held.weapon.type,
        model: this.#held.weapon.model,
        set: this.#held.set,
        damage: this.#held.weapon.damage,
        clipSize: this.#held.weapon.clipSize,
        timeBetweenShots: this.#held.weapon.timeBetweenShots,
        range: this.#held.weapon.weaponRange,
        fireType: this.#held.weapon.fireType,
        ammo: this.#held.ammo,
        reserve: this.#held.reserve,
        inHand: this.#held.object.parent === this.#hand,
      } : null,
      moveSet: this.#held?.weapon.moveSet ?? null,
      upperBodyLayered: !!(this.#action && this.#action.blendMode === THREE.AdditiveAnimationBlendMode),
      additiveClips: this.#additive.size,
      reloading: this.state.reloading,
      cooldown: Number(this.state.cooldown.toFixed(3)),
      rockets: this.#rockets.length,
      rocketDetail: this.#rockets.map(rocket => ({
        travelled: Number(rocket.travelled.toFixed(1)),
        range: rocket.range,
        y: Number(rocket.object.position.y.toFixed(2)),
      })),
      playing: this.#action?.getClip().name ?? null,
      lastExplosion: this.lastExplosion ?? null,
    };
  }
}

// Where each weapon sits in the hand. GTA IV keeps weapon attachment
// transforms in data this project does not read, so unlike everything else
// about these weapons, these five numbers are tuned by eye rather than taken
// from the game.
const GRIPS = {
  PISTOL: { position: [0.02, 0.02, 0.01], rotation: [Math.PI / 2, 0, Math.PI / 2], scale: 1 },
  M4: { position: [0.05, 0.02, 0.02], rotation: [Math.PI / 2, 0, Math.PI / 2], scale: 1 },
  RLAUNCHER: { position: [0.08, 0.03, 0.02], rotation: [Math.PI / 2, 0, Math.PI / 2], scale: 1 },
};
