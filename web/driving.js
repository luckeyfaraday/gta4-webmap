import * as THREE from 'three';

// Driving a vehicle the player has taken over from traffic.
//
// The handling is an arcade model, but its constants are not invented: mass,
// drive force, top speed, brake force and steering lock all come out of the
// catalogue, which reads them from the game's own handling.dat. So an Infernus
// pulls away from a Taxi, and a Trashmaster corners like a Trashmaster, without
// anything here knowing which is which.
//
// What it is NOT is a physics simulation. There is no suspension, no weight
// transfer and no tyre model; the car sits on the ground probe and turns at a
// rate the speed allows. GTA IV's real handling depends on RAGE's solver, and
// the archives carry the tuning, not the solver.

const KMH = 1 / 3.6;

export class Driving {
  #probe;
  #car = null;
  #scene;

  constructor(scene, { groundProbe = null, obstacleProbe = null } = {}) {
    this.#scene = scene;
    this.#probe = groundProbe;
    this.obstacleProbe = obstacleProbe;
  }

  get active() { return this.#car !== null; }
  get model() { return this.#car?.model ?? null; }
  get entry() { return this.#car?.entry ?? null; }
  get speed() { return this.#car?.speed ?? 0; }
  get speedKmh() { return this.#car ? Math.abs(this.#car.speed) / KMH : 0; }
  get position() { return this.#car?.model.root.position ?? null; }
  get yaw() { return this.#car?.yaw ?? 0; }

  // Take over a vehicle handed across from traffic. It keeps its own model, so
  // its paint and wheels carry straight over.
  enter(vehicle, { yaw = 0 } = {}) {
    const handling = vehicle.entry.handling ?? {};
    this.#car = {
      entry: vehicle.entry,
      model: vehicle.model,
      yaw,
      speed: 0,
      steer: 0,
      wheelAngle: 0,
      lift: vehicle.model.root.position.y,
      // handling.dat's own figures, converted where needed.
      topSpeed: (handling.topSpeed ?? 130) * KMH,
      driveForce: handling.driveForce ?? 0.2,
      brakeForce: handling.brakeForce ?? 0.3,
      steerLock: THREE.MathUtils.degToRad(handling.steeringLock ?? 35),
      mass: handling.mass ?? 1600,
      drive: handling.drive ?? 'R',
      wheelRadius: vehicle.entry.wheelRadius?.[0] > 0.05 ? vehicle.entry.wheelRadius[0] : 0.35,
    };
    vehicle.model.root.rotation.y = yaw;
    return this.#car;
  }

  // Hand the vehicle back. The caller decides what happens to it — traffic
  // takes it again, or it is simply left standing.
  exit() {
    const car = this.#car;
    this.#car = null;
    return car;
  }

  // The point a driver stands when getting out: beside the driver's door,
  // clear of the car, from the model's own seat bone where it has one.
  exitPoint(target = new THREE.Vector3()) {
    if (!this.#car) return null;
    const seats = this.#car.entry.seats ?? [];
    const driver = seats.find(seat => /dside_f/i.test(seat.name)) ?? seats[0];
    const sideways = driver ? Math.abs(driver.position[0]) + 0.9 : 1.9;
    const root = this.#car.model.root;
    // Left of travel, in the mirrored frame the viewer draws in.
    target.set(
      root.position.x + Math.cos(this.#car.yaw) * sideways,
      root.position.y,
      root.position.z - Math.sin(this.#car.yaw) * sideways,
    );
    return target;
  }

  update(delta, input) {
    const car = this.#car;
    if (!car) return null;

    const throttle = (input.forward ? 1 : 0) - (input.back ? 1 : 0);
    const steerInput = (input.left ? 1 : 0) - (input.right ? 1 : 0);

    // Steering eases toward the input rather than snapping, and the lock
    // tightens as speed rises — the cheapest thing that stops a car pivoting on
    // the spot at 100 km/h.
    const speedFraction = Math.min(1, Math.abs(car.speed) / Math.max(1, car.topSpeed));
    const lock = car.steerLock * (1 - 0.55 * speedFraction);
    car.steer += (steerInput * lock - car.steer) * Math.min(1, delta * 7);

    // Drive force scaled to something that feels like the game's own ordering.
    // Acceleration falls off toward top speed instead of stopping dead at it.
    const accel = car.driveForce * 34;
    if (throttle > 0) {
      car.speed += accel * (1 - speedFraction * 0.85) * delta;
    } else if (throttle < 0) {
      // Reverse is deliberately slow, and braking is what happens first when
      // the car is still moving forward.
      car.speed -= (car.speed > 0.5 ? car.brakeForce * 26 : accel * 0.4) * delta;
    }

    if (input.handbrake) {
      car.speed -= Math.sign(car.speed) * car.brakeForce * 34 * delta;
      if (Math.abs(car.speed) < 0.4) car.speed = 0;
    }

    // Rolling resistance and drag, so lifting off slows the car down.
    car.speed -= car.speed * (0.55 + Math.abs(car.speed) * 0.012) * delta;
    car.speed = THREE.MathUtils.clamp(car.speed, -car.topSpeed * 0.35, car.topSpeed);

    // A car turns because it is moving; the yaw rate follows speed, and
    // reverses when reversing, which is what makes backing out of a space read
    // correctly.
    if (Math.abs(car.speed) > 0.05) {
      const turn = car.steer * (car.speed / Math.max(2.5, Math.abs(car.speed) * 0.55)) * delta * 1.35;
      car.yaw += turn;
    }

    const root = car.model.root;
    const forward = new THREE.Vector3(-Math.sin(car.yaw), 0, -Math.cos(car.yaw));
    const step = car.speed * delta;

    // Refuse to drive into things. A short probe along travel is not collision
    // response — it just stops the car rather than letting it pass through a
    // building.
    if (this.obstacleProbe && Math.abs(step) > 0.001) {
      const blocked = this.obstacleProbe(root.position, forward, Math.abs(step) + 1.8, Math.sign(step));
      if (blocked) {
        car.speed *= -0.15;
        return this.#settle(car, delta);
      }
    }

    root.position.addScaledVector(forward, step);
    return this.#settle(car, delta, step);
  }

  #settle(car, delta, step = 0) {
    const root = car.model.root;
    if (this.#probe) {
      const surface = this.#probe(root.position.x, root.position.z, car.lift);
      if (surface !== null && Number.isFinite(surface)) {
        const gap = surface - car.lift;
        car.lift = Math.abs(gap) > 0.6 ? surface : car.lift + gap * Math.min(1, delta * 9);
      }
    }
    root.position.y = car.lift;
    root.rotation.y = car.yaw;

    car.wheelAngle += step / car.wheelRadius;
    car.model.spin(car.wheelAngle);
    // Point the steered wheels. They are joints of the body skin, so this is a
    // bone rotation like the roll is.
    for (const wheel of car.model.wheels) {
      if (/_[lr]f$/i.test(wheel.name)) wheel.rotation.y = car.steer;
    }
    return root.position;
  }

  getState() {
    if (!this.#car) return { driving: false };
    return {
      driving: true,
      model: this.#car.entry.model,
      name: this.#car.entry.name,
      speedKmh: Number(this.speedKmh.toFixed(1)),
      // Signed, because "speed" alone cannot tell braking from reversing —
      // pressing back when nearly stopped is a gear change, not a brake.
      velocityKmh: Number((this.#car.speed / KMH).toFixed(1)),
      topSpeedKmh: Number((this.#car.topSpeed / KMH).toFixed(0)),
      drive: this.#car.drive,
      mass: this.#car.mass,
      steer: Number(this.#car.steer.toFixed(3)),
      yaw: Number(this.#car.yaw.toFixed(3)),
      position: this.#car.model.root.position.toArray(),
      seats: this.#car.entry.seats?.length ?? 0,
    };
  }
}
