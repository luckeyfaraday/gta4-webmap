import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

// Weapons and combat.
//
// The point of these checks is that the weapons are the GAME'S weapons, not
// three interchangeable props: each carries its own damage, clip size, rate of
// fire and range straight out of WeaponInfo.xml, each plays its own animation
// set out of its own gun@ wad, and the difference shows in what a shot does.
const candidates = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);
const executablePath = candidates.find(existsSync);
if (!executablePath) throw new Error('Chrome or Edge was not found.');

const base = process.env.MAP_URL ?? 'http://127.0.0.1:4174';
await mkdir('artifacts', { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
const messages = [];
page.on('console', message => { if (message.type() === 'error') messages.push(`[console] ${message.text()}`); });
page.on('pageerror', error => messages.push(`[pageerror] ${error.stack ?? error.message}`));

const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
}

try {
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(() => globalThis.gta4map?.getState().ready, null, { timeout: 150_000 });
  await page.evaluate(() => globalThis.gta4map.setMode('walk'));
  await page.waitForTimeout(13_000);

  const initial = await page.evaluate(() => globalThis.gta4map.getState().weapons);
  check(initial !== null, 'the weapon system did not initialise');
  check(initial?.attached === true, 'weapons are not attached to the character');
  // gun@handgun + gun@rifle + gun@rocket + aim idles + move_rifle + move_rpg.
  check(initial?.clips > 120, `expected the armed clip library, got ${initial?.clips} clips`);
  for (const type of ['PISTOL', 'M4', 'RLAUNCHER']) {
    check(initial?.available.includes(type), `${type} is missing from the catalogue`);
  }

  // Each weapon's own figures, straight from WeaponInfo.xml, and its own
  // animation set. If these were shared the three would be interchangeable.
  const equipped = [];
  for (const type of ['PISTOL', 'M4', 'RLAUNCHER']) {
    const held = await page.evaluate(async name => globalThis.gta4map.equipWeapon(name), type);
    check(held !== null, `could not equip ${type}`);
    if (held) equipped.push(held);
    await page.waitForTimeout(400);
  }

  const [pistol, rifle, rpg] = equipped;
  if (pistol && rifle && rpg) {
    // The real numbers: pistol 25/17/333ms, M4 30/30/120ms, RPG explosive 1/800ms.
    check(pistol.damage === 25 && pistol.clipSize === 17 && pistol.timeBetweenShots === 333,
      `pistol figures wrong: ${pistol.damage} dmg, ${pistol.clipSize} clip, ${pistol.timeBetweenShots}ms`);
    check(rifle.damage === 30 && rifle.clipSize === 30 && rifle.timeBetweenShots === 120,
      `M4 figures wrong: ${rifle.damage} dmg, ${rifle.clipSize} clip, ${rifle.timeBetweenShots}ms`);
    check(rpg.fireType === 'PROJECTILE' && rpg.clipSize === 1,
      `RPG should be a single-shot projectile weapon, got ${rpg.fireType} clip ${rpg.clipSize}`);
    check(rifle.timeBetweenShots < pistol.timeBetweenShots, 'the M4 does not fire faster than the pistol');
    check(rifle.range > pistol.range, 'the M4 does not outrange the pistol');
    // Distinct animation sets, which is what stops all three sharing a gait.
    check(new Set([pistol.set, rifle.set, rpg.set]).size === 3,
      `weapons share animation sets: ${[pistol.set, rifle.set, rpg.set].join(', ')}`);
    check(equipped.every(weapon => weapon.inHand), 'a weapon was not parented to the hand bone');
  }

  // Firing: ammo goes down, the rate of fire is enforced, and reloading refills.
  const shooting = await page.evaluate(async () => {
    const api = globalThis.gta4map;
    api.clearWanted();
    await api.equipWeapon('PISTOL');
    const start = api.getState().weapons.held.ammo;
    const first = api.fireWeapon();
    const immediate = api.fireWeapon();          // blocked by the 333ms gap
    await new Promise(resolve => setTimeout(resolve, 500));
    const later = api.fireWeapon();
    const afterShots = api.getState().weapons.held.ammo;
    return { start, first, immediate, later, afterShots };
  });
  check(shooting.first?.fired === true, 'the first shot did not fire');
  check(shooting.immediate === null, 'the rate of fire is not enforced — a second shot fired immediately');
  check(shooting.later?.fired === true, 'no shot fired after the cooldown elapsed');
  check(shooting.afterShots === shooting.start - 2, `ammo went ${shooting.start} -> ${shooting.afterShots} for two shots`);

  const reloaded = await page.evaluate(async () => {
    const api = globalThis.gta4map;
    api.weapons.reload();
    await new Promise(resolve => setTimeout(resolve, 2400));
    return api.getState().weapons.held;
  });
  check(reloaded.ammo === reloaded.clipSize, `reload left ${reloaded.ammo}/${reloaded.clipSize}`);

  // Shooting a pedestrian: damage accumulates and the crime is reported.
  const combat = await page.evaluate(async () => {
    const api = globalThis.gta4map;
    api.clearWanted();
    await api.equipWeapon('M4');
    const peds = api.crowd.debugPeds();
    if (!peds.length) return { error: 'no peds to shoot' };
    // Stand off and aim straight at one.
    const THREE = api.THREE;
    const id = peds[0].id;
    const before = api.crowd.getState().count;
    const results = [];
    // Re-aim at the target's LIVE position before each shot. Peds walk, so a
    // direction computed once goes stale within a stride and the whole burst
    // misses — which says nothing about whether shooting works.
    for (let i = 0; i < 6; i++) {
      const live = api.crowd.debugPeds().find(ped => ped.id === id);
      if (!live) break;
      const origin = new THREE.Vector3(live.position[0] + 6, live.position[1] + 1.35, live.position[2]);
      const direction = new THREE.Vector3(live.position[0] - origin.x, (live.position[1] + 1.0) - origin.y, live.position[2] - origin.z).normalize();
      results.push(api.weapons.fire(origin, direction));
      await new Promise(resolve => setTimeout(resolve, 180));
    }
    return { results, before, after: api.crowd.getState().count, stars: api.getState().wanted.stars };
  });

  if (!combat.error) {
    const hits = combat.results.filter(row => row && row.hit);
    check(hits.length > 0, 'five aimed shots hit nothing');
    const killed = combat.results.some(row => row?.killed);
    check(killed, 'four M4 hits at 30 damage should drop a 100-health ped');
    check(combat.stars > 0, 'shooting a pedestrian raised no wanted level');
  }

  // The launcher throws a projectile rather than hitscanning.
  const rocketFired = await page.evaluate(async () => {
    const api = globalThis.gta4map;
    await api.equipWeapon('RLAUNCHER');
    const result = api.fireWeapon();
    // Poll rather than sleep a fixed time. The model loads asynchronously, so
    // the rocket appears a moment after the trigger, and it then takes about
    // 2.6 s to fly its 100 m range — a fixed wait races both.
    let flew = 0;
    let rockets = 0;
    for (let i = 0; i < 40; i++) {
      await new Promise(resolve => setTimeout(resolve, 200));
      rockets = api.getState().weapons.rockets;
      flew = Math.max(flew, api.getState().weapons.rocketDetail?.[0]?.travelled ?? 0);
      if (flew > 1 && rockets === 0) break;
    }
    return { result, flew, after: rockets, explosion: api.getState().weapons.lastExplosion };
  });
  check(rocketFired.result?.projectile === true, 'the launcher did not create a projectile');
  // The rocket may detonate almost at once at close quarters, so what is
  // asserted is that it flew and exploded, not that it was still in the air at
  // an arbitrary moment.
  // It only has to have flown and gone off. How far is up to what it meets:
  // fired into a crowd it detonates within a few metres, and that is the
  // weapon working, not failing.
  check(rocketFired.flew > 1, `the rocket never left the barrel (${rocketFired.flew}m)`);
  check(rocketFired.after === 0, `${rocketFired.after} rockets never detonated`);
  check(rocketFired.explosion !== null, 'the rocket never exploded');

  // ---- upper-body layering ------------------------------------------------
  //
  // Shooting while running has to move the arms without disturbing the legs.
  // Measured on the bones themselves: fire a weapon mid-stride and compare each
  // bone's world rotation against the same moment of the same stride unarmed.
  // The arms must change a lot, the legs almost not at all.
  const layering = await page.evaluate(async () => {
    const api = globalThis.gta4map;
    const THREE = api.THREE;
    const root = api.character.root;
    const bones = {};
    for (const name of ['Char_R_UpperArm', 'Char_R_Forearm', 'Char_L_UpperArm',
                        'Char_L_Thigh', 'Char_L_Calf', 'Char_R_Thigh', 'Char_R_Calf']) {
      bones[name] = root.getObjectByName(name);
    }
    const sample = () => {
      root.updateWorldMatrix(true, true);
      const out = {};
      for (const [name, bone] of Object.entries(bones)) {
        if (!bone) continue;
        out[name] = bone.getWorldQuaternion(new THREE.Quaternion()).toArray();
      }
      return out;
    };
    const angleBetween = (a, b) => {
      const qa = new THREE.Quaternion().fromArray(a);
      const qb = new THREE.Quaternion().fromArray(b);
      return 2 * Math.acos(Math.min(1, Math.abs(qa.dot(qb))));
    };

    // Equip FIRST and let the armed stride settle, so the base locomotion clip
    // is identical either side of the measurement. Comparing armed against
    // unarmed instead would also swap move_rifle/run in for run, and the legs
    // would differ because the whole cycle changed — which says nothing about
    // whether the gun layer is leaking into them.
    await api.equipWeapon('M4');
    api.play('move_rifle/run');
    await new Promise(r => setTimeout(r, 1400));   // let unholster finish
    const before = sample();

    // Same base clip, same moment of the stride; only the additive layer changes.
    api.weapons.fire(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1));
    await new Promise(r => setTimeout(r, 260));
    const after = sample();

    const delta = {};
    for (const name of Object.keys(before)) {
      if (after[name]) delta[name] = Number(angleBetween(before[name], after[name]).toFixed(3));
    }
    const state = api.getState().weapons;
    return { delta, layered: state.upperBodyLayered, additiveClips: state.additiveClips,
             moveSet: state.moveSet, baseClip: api.getState().player.clip };
  });

  check(layering.layered === true, 'the weapon clip is not playing as an additive layer');
  check(layering.additiveClips > 0, 'no upper-body additive clips were built');
  const arms = ['Char_R_UpperArm', 'Char_R_Forearm', 'Char_L_UpperArm']
    .map(name => layering.delta[name] ?? 0);
  const legs = ['Char_L_Thigh', 'Char_L_Calf', 'Char_R_Thigh', 'Char_R_Calf']
    .map(name => layering.delta[name] ?? 0);
  check(Math.max(...arms) > 0.25,
    `firing barely moved the arms (max ${Math.max(...arms).toFixed(3)} rad) — the layer is not reaching them`);
  // With the base clip held constant, the legs should barely register the shot.
  check(Math.max(...legs) < 0.08,
    `firing moved the legs ${Math.max(...legs).toFixed(3)} rad with the base clip unchanged — the layer is not upper-body only`);
  check(layering.baseClip?.startsWith('move_rifle/'),
    `armed locomotion did not take over the legs (base clip is ${layering.baseClip})`);

  await page.evaluate(() => globalThis.gta4map.equipWeapon('M4'));
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'artifacts/weapons.png' });

  const result = {
    clips: initial?.clips,
    available: initial?.available,
    weapons: equipped.map(w => ({
      type: w.type, model: w.model, set: w.set, damage: w.damage,
      clipSize: w.clipSize, timeBetweenShots: w.timeBetweenShots, range: w.range, fireType: w.fireType,
    })),
    shooting: { start: shooting.start, afterTwoShots: shooting.afterShots, rateLimited: shooting.immediate === null },
    reloadedTo: reloaded.ammo,
    combat: combat.error ? combat : {
      hits: combat.results.filter(r => r && r.hit).length,
      killed: combat.results.some(r => r?.killed),
      crowdBefore: combat.before, crowdAfter: combat.after, stars: combat.stars,
    },
    rocket: rocketFired,
    layering,
    failures,
    messages,
  };
  await writeFile('artifacts/weapons.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (failures.length) throw new Error(`Weapon checks failed:\n  ${failures.join('\n  ')}`);
} finally {
  await browser.close();
}
