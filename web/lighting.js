// Drives the scene from GTA IV's own timecycle.
//
// web/data/timecyc.json is a direct transcription of pc/data/timecyc.dat: for
// each of 9 weathers, 11 keyframes from Midnight to 10PM. Everything here that
// comes from the game is read straight out of those keyframes. Two things are
// NOT in the file and are reconstructed, marked DERIVED below:
//
//   * the sun's direction, which the engine spins about the axis in
//     visualSettings.dat rather than storing per keyframe, and
//   * the day/night brightness ratio. In timecyc.dat the Exposure column
//     cancels the light multipliers almost exactly (midday 14.75 x 0.19 = 2.80,
//     midnight 1.00 x 2.69 = 2.69) because the real engine layers HDR
//     luminance adaptation, clamped by LumMin/LumMax, on top. We are not
//     simulating that adaptation, so night is darkened by an explicit factor.
import * as THREE from 'three';

const NOT_INTERPOLATED = new Set(['label', 'hour', 'extra']);

// timecyc.dat authors every colour as an sRGB byte triple, so they have to be
// decoded into three.js's linear working space rather than assigned raw.
const srgb = (target, [r, g, b]) => target.setRGB(r, g, b, THREE.SRGBColorSpace);
const srgbColor = rgb => srgb(new THREE.Color(), rgb);

export class Timecycle {
  constructor(data) {
    this.data = data;
    this.weathers = Object.keys(data.weathers);
  }

  // Keyframes are unevenly spaced (0, 5, 6, 7, 9, 12, 18, 19, 20, 21, 22), and
  // the last one wraps back round to Midnight across a two-hour gap.
  sample(weather, hour) {
    const frames = this.data.weathers[weather] ?? this.data.weathers[this.weathers[0]];
    const wrapped = ((hour % 24) + 24) % 24;
    let index = frames.length - 1;
    for (let n = 0; n < frames.length; n++) if (frames[n].hour <= wrapped) index = n;
    const from = frames[index];
    const to = frames[(index + 1) % frames.length];
    const span = ((to.hour - from.hour + 24) % 24) || 24;
    const t = (((wrapped - from.hour + 24) % 24) / span);

    const out = { hour: wrapped, from: from.label, to: to.label, blend: t };
    for (const key of Object.keys(from)) {
      if (NOT_INTERPOLATED.has(key)) continue;
      const a = from[key], b = to[key];
      out[key] = Array.isArray(a) ? a.map((value, i) => value + (b[i] - value) * t) : a + (b - a) * t;
    }
    return out;
  }
}

// DERIVED. The extractor maps GTA (x, y, z) to world (-x, z, -y), so world +Y
// is up, world +Z is south and world -X is east: the sun rises at -X, transits
// the southern sky and sets at +X.
//
// Sunrise and sunset are read off timecyc.dat rather than assumed. SunMult is
// 0 at Midnight, 2 by 5AM and 12.5 by 6AM, and it holds at 13 all the way
// through 9PM before dropping back to 0 at 10PM — so IV's day runs roughly
// 05:30 to 21:30, not 06:00 to 18:00. Putting the sun below the horizon at
// 19:30 would black out the golden hour the keyframes are clearly describing.
export const SUNRISE = 5.5;
export const SUNSET = 21.5;

export function sunDirection(hour, options = {}, target = new THREE.Vector3()) {
  const { sunrise = SUNRISE, sunset = SUNSET, tilt = 0.42 } = options;
  const wrapped = ((hour % 24) + 24) % 24;
  const day = sunset - sunrise;
  // Daylight covers the first half turn; the shorter night is stretched across
  // the second so the arc stays continuous and comes back up at sunrise.
  const theta = wrapped >= sunrise && wrapped <= sunset
    ? (wrapped - sunrise) / day * Math.PI
    : Math.PI * (1 + ((wrapped - sunset + 24) % 24) / (24 - day));
  return target.set(
    -Math.cos(theta),
    Math.sin(theta) * Math.cos(tilt),
    Math.sin(theta) * Math.sin(tilt),
  ).normalize();
}

// Matches three.js ACESFilmicToneMapping exactly, including its exposure / 0.6
// scaling, so the sky dome and the tone-mapped scene agree at the horizon
// instead of showing a seam where fogged geometry meets the sky.
const SKY_FRAGMENT = /* glsl */`
uniform vec3 uHorizon, uZenith, uSunCore, uSunCorona, uSunDir;
uniform float uSunSize, uSpriteBrightness, uExposure, uHazeAmount;
varying vec3 vDirection;

vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}

vec3 acesFilmic(vec3 color) {
  const mat3 inputMat = mat3(
    vec3(0.59719, 0.07600, 0.02840),
    vec3(0.35458, 0.90834, 0.13383),
    vec3(0.04823, 0.01566, 0.83777));
  const mat3 outputMat = mat3(
    vec3( 1.60475, -0.10208, -0.00327),
    vec3(-0.53108,  1.10813, -0.07276),
    vec3(-0.07367, -0.00605,  1.07602));
  color *= uExposure / 0.6;
  color = inputMat * color;
  color = RRTAndODTFit(color);
  color = outputMat * color;
  return clamp(color, 0.0, 1.0);
}

vec3 linearToSRGB(vec3 c) {
  return mix(pow(c, vec3(0.41666)) * 1.055 - vec3(0.055), c * 12.92, vec3(lessThanEqual(c, vec3(0.0031308))));
}

void main() {
  vec3 direction = normalize(vDirection);
  float height = clamp(direction.y, 0.0, 1.0);
  vec3 colour = mix(uHorizon, uZenith, pow(height, 0.45));

  // SunSz and SprBght come from the keyframe; the exponent mapping is a fit,
  // not a game constant.
  float alignment = max(dot(direction, normalize(uSunDir)), 0.0);
  float corona = pow(alignment, max(360.0 / max(uSunSize, 0.05), 8.0));
  float core = smoothstep(0.9993, 0.99985, alignment);
  colour += uSunCorona * corona * uSpriteBrightness;
  colour += uSunCore * core * uSpriteBrightness * 6.0;

  // Below the horizon the dome would otherwise cut to a hard edge against the
  // fogged geometry, so fade into the haze colour instead.
  colour = mix(uHorizon * uHazeAmount, colour, smoothstep(-0.10, 0.02, direction.y));

  gl_FragColor = vec4(linearToSRGB(acesFilmic(colour)), 1.0);
}
`;

const SKY_VERTEX = /* glsl */`
varying vec3 vDirection;
void main() {
  vDirection = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export class LightingRig {
  constructor(scene, renderer, camera, timecycle, options = {}) {
    this.scene = scene;
    this.renderer = renderer;
    this.camera = camera;
    this.timecycle = timecycle;

    this.weather = options.weather ?? 'EXTRASUNNY';
    this.hour = options.hour ?? 12;
    // All three are viewer-side, not from the game. See the DERIVED note above.
    this.exposureGain = options.exposureGain ?? 1.4;
    this.nightGain = options.nightGain ?? 0.3;
    this.skyGain = options.skyGain ?? 0.4;
    this.fogDensity = options.fogDensity ?? 1.5;
    this.sunPath = { sunrise: SUNRISE, sunset: SUNSET, tilt: 0.42, ...options.sunPath };

    this.ambient = new THREE.HemisphereLight(0xffffff, 0xffffff, 1);
    scene.add(this.ambient);

    this.sun = new THREE.DirectionalLight(0xffffff, 1);
    this.sun.position.set(0, 1, 0);
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.sunDir = new THREE.Vector3(0, 1, 0);
    this.uniforms = {
      uHorizon: { value: new THREE.Color(0.5, 0.6, 0.8) },
      uZenith: { value: new THREE.Color(0.1, 0.2, 0.5) },
      uSunCore: { value: new THREE.Color(1, 1, 1) },
      uSunCorona: { value: new THREE.Color(1, 0.9, 0.7) },
      uSunDir: { value: this.sunDir },
      uSunSize: { value: 1.2 },
      uSpriteBrightness: { value: 1.2 },
      uExposure: { value: 0.3 },
      uHazeAmount: { value: 0.75 },
    };

    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 20),
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: SKY_VERTEX,
        fragmentShader: SKY_FRAGMENT,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        toneMapped: false,
      }),
    );
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -1000;
    scene.add(this.sky);

    scene.fog = new THREE.FogExp2(0x8497a3, 0.001);
    this.frame = null;
    this.update();
  }

  setWeather(weather) { this.weather = weather; this.update(); }
  setHour(hour) { this.hour = hour; this.update(); }

  update() {
    const frame = this.timecycle.sample(this.weather, this.hour);
    this.frame = frame;

    sunDirection(frame.hour, this.sunPath, this.sunDir);
    // Above the horizon the sun is the key light; once it sets the keyframe's
    // own DirLightMult has already fallen away, so keep the light just above
    // the horizon rather than lighting the city from underneath.
    const elevation = Math.max(this.sunDir.y, 0.05);
    this.sun.position.set(this.sunDir.x, elevation, this.sunDir.z).normalize().multiplyScalar(2000);

    const daylight = THREE.MathUtils.smoothstep(this.sunDir.y, -0.15, 0.25);
    const exposure = frame.exposure * this.exposureGain * THREE.MathUtils.lerp(this.nightGain, 1, daylight);
    this.renderer.toneMappingExposure = exposure;
    this.uniforms.uExposure.value = exposure;

    srgb(this.ambient.color, frame.amb0);
    srgb(this.ambient.groundColor, frame.amb1);
    // HemisphereLight has one intensity for both hemispheres, so carry Amb0's
    // multiplier and fold the Amb1/Amb0 ratio into the ground colour.
    this.ambient.intensity = frame.ambLightMult0;
    this.ambient.groundColor.multiplyScalar(frame.ambLightMult1 / Math.max(frame.ambLightMult0, 1e-3));

    srgb(this.sun.color, frame.dir);
    this.sun.intensity = frame.dirLightMult * frame.globalSunMult;

    const horizon = srgbColor(frame.skyBottom).multiplyScalar(frame.skyLightMult * this.skyGain);
    // Sky top sits near black in every keyframe, so on its own it produces a
    // black zenith at noon. Lift it with Amb0, which is the colour the engine
    // uses for sky-side ambient.
    const zenith = srgbColor(frame.skyTop)
      .multiplyScalar(frame.skyLightMult * this.skyGain)
      .add(srgbColor(frame.amb0).multiplyScalar(frame.ambLightMult0 * this.skyGain * 0.35));

    this.uniforms.uHorizon.value.copy(horizon);
    this.uniforms.uZenith.value.copy(zenith);
    srgb(this.uniforms.uSunCore.value, frame.sunCore).multiplyScalar(frame.sunMult * this.skyGain);
    srgb(this.uniforms.uSunCorona.value, frame.sunCorona).multiplyScalar(frame.sunMult * this.skyGain);
    this.uniforms.uSunSize.value = frame.sunSize;
    this.uniforms.uSpriteBrightness.value = frame.spriteBrightness;

    // FarClp is the game's draw distance and is a flat 1500 in every weather
    // but TEMP. FogSt is deliberately NOT used as a fog start distance: its
    // values contradict that reading (FOGGY sits at 73-79 while SUNNY drops to
    // 9), so it is something closer to a sky-blend or height term. Exponential
    // fog tuned to reach the far plane keeps the near field clear, which is how
    // the game reads, instead of veiling everything a few blocks out.
    this.scene.fog.color.copy(horizon);
    this.scene.fog.density = this.fogDensity / frame.farClip;
    this.scene.background = null;
  }

  // The dome is a unit sphere parked on the camera, so it never clips against
  // the far plane no matter how far the player flies.
  follow() {
    this.sky.position.copy(this.camera.position);
    this.sky.scale.setScalar(this.camera.far * 0.45);
    this.sun.target.position.copy(this.camera.position);
    this.sun.target.updateMatrixWorld();
  }
}
