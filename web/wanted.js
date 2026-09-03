// The wanted level: how much heat the player is carrying, what that buys in
// police response, and how it cools off.
//
// Modelled on GTA IV's own behaviour rather than the older games'. Two things
// follow from that and shape the code:
//
//  * Heat is continuous and stars are a display of it, so a second offence
//    while already wanted escalates smoothly instead of snapping a star at a
//    time.
//  * Cooling needs the player to break line of sight. In IV a wanted level does
//    not simply time out while a officer is watching you — you have to leave the
//    search area. So decay only runs once nothing has seen the player for a
//    grace period, and any sighting resets it.

// Heat thresholds for each star. Six stars is the ceiling, as in the game.
const STAR_AT = [0, 1, 2.6, 4.6, 7.2, 10.4, 14.4];

// What each offence costs. Killing a police officer is deliberately far more
// expensive than killing a civilian.
export const CRIMES = {
  pedKilled: 1.15,
  pedInjured: 0.45,
  vehicleStolen: 0.35,
  copSeenCrime: 0.6,
  copInjured: 1.6,
  copKilled: 3.0,
  shotFired: 0.3,
  ranOverPed: 1.15,
};

export class Wanted {
  #heat = 0;
  #stars = 0;
  #sinceSeen = Infinity;
  #listeners = new Set();
  #log = [];

  constructor(options = {}) {
    // Seconds out of sight before heat starts falling, and how fast it falls.
    // Higher stars take longer to shake, which is what makes a five-star chase
    // a different problem from a one-star one.
    this.graceSeconds = options.graceSeconds ?? 8;
    this.coolPerSecond = options.coolPerSecond ?? 0.55;
    this.maxStars = options.maxStars ?? 6;
  }

  get stars() { return this.#stars; }
  get heat() { return this.#heat; }
  get wanted() { return this.#stars > 0; }
  get secondsSinceSeen() { return this.#sinceSeen; }
  // True while the player is being actively hunted rather than merely wanted.
  get pursued() { return this.#stars > 0 && this.#sinceSeen < this.graceSeconds; }

  onChange(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }

  #starsFor(heat) {
    let stars = 0;
    for (let i = 1; i < STAR_AT.length && i <= this.maxStars; i++) {
      if (heat >= STAR_AT[i]) stars = i;
    }
    return stars;
  }

  #settle(reason) {
    const stars = this.#starsFor(this.#heat);
    if (stars === this.#stars) return;
    const previous = this.#stars;
    this.#stars = stars;
    for (const listener of this.#listeners) listener(stars, previous, reason);
  }

  // Commit an offence. `witnessed` false is a crime nobody saw — it still adds
  // heat, but far less, because in IV what escalates a chase is being seen
  // doing it.
  report(crime, { witnessed = true, at = null } = {}) {
    const cost = CRIMES[crime];
    if (cost === undefined) return this.#stars;
    this.#heat = Math.min(STAR_AT[this.maxStars] * 1.35, this.#heat + cost * (witnessed ? 1 : 0.35));
    if (witnessed) this.#sinceSeen = 0;
    this.#log.push({ crime, witnessed, at, heat: Number(this.#heat.toFixed(2)) });
    if (this.#log.length > 64) this.#log.shift();
    this.#settle(crime);
    return this.#stars;
  }

  // Called every frame with whether anything hostile currently has eyes on the
  // player. Sightings hold the level; silence eventually cools it.
  update(delta, seen) {
    if (seen) {
      this.#sinceSeen = 0;
      return this.#stars;
    }
    this.#sinceSeen += delta;
    if (this.#sinceSeen < this.graceSeconds || this.#heat <= 0) return this.#stars;

    // Cooling slows as the level rises, so six stars is not shaken in the time
    // one star is.
    const resistance = 1 + this.#stars * 0.45;
    this.#heat = Math.max(0, this.#heat - (this.coolPerSecond / resistance) * delta);
    this.#settle('cooled');
    return this.#stars;
  }

  clear(reason = 'cleared') {
    this.#heat = 0;
    this.#sinceSeen = Infinity;
    this.#settle(reason);
  }

  // What the response should look like at the current level. The police module
  // reads this rather than deciding for itself, so difficulty lives in one
  // place.
  get response() {
    const stars = this.#stars;
    return {
      stars,
      // On-foot officers and cruisers hunting at once.
      officers: [0, 2, 3, 4, 5, 6, 7][stars] ?? 0,
      cars: [0, 1, 2, 3, 4, 4, 5][stars] ?? 0,
      // How far out they may be spawned, and how far they will follow.
      spawnRadius: [0, 90, 110, 130, 150, 170, 190][stars] ?? 0,
      // NOOSE and the heavier units arrive with the higher levels.
      swat: stars >= 4,
      // How keenly they close the distance.
      speed: [0, 2.6, 2.9, 3.2, 3.5, 3.8, 4.1][stars] ?? 0,
    };
  }

  getState() {
    return {
      stars: this.#stars,
      heat: Number(this.#heat.toFixed(2)),
      wanted: this.wanted,
      pursued: this.pursued,
      secondsSinceSeen: Number.isFinite(this.#sinceSeen) ? Number(this.#sinceSeen.toFixed(2)) : null,
      response: this.response,
      recentCrimes: this.#log.slice(-8),
    };
  }
}
