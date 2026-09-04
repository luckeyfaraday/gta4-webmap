// Drives the scene from GTA IV's own timecycle.
//
// web/data/timecyc.json is a direct transcription of pc/data/timecyc.dat: for
// each of 9 weathers, 11 keyframes from Midnight to 10PM. Everything here that
// comes from the game is read straight out of those keyframes. Two things are
// NOT in the file and are reconstructed, marked DERIVED below:
//
//   * the sun's direction, which the engine spins about the axis in
//     visualSettings.dat rather than storing per keyframe, and
//   * the day/night brightness ratio, because the Exposure column exists to
//     cancel the light multipliers and hand the rest to HDR luminance
//     adaptation that this does not simulate. Exposure is replaced by an
//     explicit ambient-key curve; see the note in update().
//
// The sky itself is no longer reconstructed. GTA IV draws it with
// gta_atmoscatt_clouds, and common/shaders/dcl ships that shader's assembly
// with every constant named, so the dome below is a transcription of the game's
// own sky maths against the timecyc columns that feed it. See
// tools/parse-timecyc.mjs for how each column was identified, and SKY_FRAGMENT
// for the maths.
import * as THREE from 'three';
import { DDSLoader } from 'three/addons/loaders/DDSLoader.js';

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

// The dome emits raw radiance, in the same units as the scene lights, and is
// tone mapped and encoded by web/grade.js along with everything else. Doing it
// here instead would put a seam at the horizon where fogged geometry meets the
// sky, because three.js skips tone mapping entirely when a material renders
// into a render target.
const SKY_FRAGMENT = /* glsl */`
uniform vec3 uSkyColour, uAzimuthColour, uAzimuthColourEast, uSunsetColour;
uniform float uAzimuthHeight, uAzimuthStrength, uSunsetAmount;
uniform vec3 uSunCore, uSunCorona, uSunDir;
uniform vec2 uSunCentre;
uniform float uSunSize, uSpriteBrightness;
uniform vec3 uCloudColour, uCloudTopColour;
uniform float uCloudCoverage, uCloudEdgeSmooth, uCloudDetailScale, uCloudStrength;
uniform float uCloudInscattering, uCloudScroll, uCloudScale;
uniform vec3 uStarColour;
uniform float uStarBrightness, uHazeAmount, uHasTextures;
uniform sampler2D uPerlin, uDetail, uStarfield, uGalaxy;
varying vec3 vDirection;

void main() {
  vec3 direction = normalize(vDirection);

  // The gradient, transcribed from the gta_atmoscatt_clouds vertex shader. Its
  // last dozen instructions are, in order: saturate(dir.y * AzimuthHeight), one
  // minus that, times AzimuthStrength; dir.x * 0.5 + 0.5; a lerp from
  // AzimuthColorEast to AzimuthColor by it; that scaled by the first term; and
  // finally SkyColor ADDED on top.
  //
  // Two things fall out of reading it rather than guessing. The horizon colour
  // is added to the zenith colour, not crossfaded with it, so SkyColor sets the
  // whole dome's floor and the azimuth term is a glow laid over it. And the
  // horizon is two colours, not one, split east/west - which is what paints the
  // warm side of a sunrise without tinting the entire sky.
  //
  // dir.x here is the game's +X (east). The extractor negates X, so the
  // world-space direction has to be flipped back to index the lerp the same way.
  float azimuth = (1.0 - clamp(direction.y * uAzimuthHeight, 0.0, 1.0)) * uAzimuthStrength;
  float eastWest = -direction.x * 0.5 + 0.5;
  vec3 horizon = mix(uAzimuthColourEast, uAzimuthColour, eastWest);

  vec3 sunDir = normalize(uSunDir);
  float alignment = dot(direction, sunDir);

  // SunsetColor is the warm band that stands over the sun at dawn and dusk. In
  // the file it is a hard switch - (1.000, 0.882, 0.588) in the keyframes
  // either side of the sun and a muted grey in every other one - so how far it
  // reaches is the viewer's decision, not the file's. It tints the horizon
  // colour rather than adding to it: three additive terms on one dome overshoot
  // the moment they overlap, and at 9PM that turned the whole sky into one flat
  // orange. Tinting keeps the sky bounded by the colours the keyframe names.
  //
  // It follows the sun's compass bearing rather than its actual direction, so
  // the glow stays down on the horizon under the sun instead of riding up the
  // sky with it.
  vec2 bearing = normalize(vec2(direction.x, direction.z) + 1e-5);
  vec2 sunBearing = normalize(vec2(sunDir.x, sunDir.z) + 1e-5);
  float towardsSun = max(dot(bearing, sunBearing), 0.0);
  horizon = mix(horizon, uSunsetColour, clamp(pow(towardsSun, 3.0) * uSunsetAmount, 0.0, 1.0));

  vec3 colour = uSkyColour + azimuth * horizon;
  float above = smoothstep(0.0, 0.22, direction.y);

  if (uHasTextures > 0.5 && uStarBrightness > 0.001) {
    // Stars sit behind everything, on a spherical mapping so they hold still
    // against the dome. starfield.dds is the point field and galaxy.dds the
    // band behind it; both come out of pc/textures/skydome.wtd.
    vec2 sphere = vec2(
      atan(direction.z, direction.x) * 0.1591549 + 0.5,
      acos(clamp(direction.y, -1.0, 1.0)) * 0.3183099);
    vec3 stars = texture2D(uStarfield, sphere * vec2(3.0, 1.5)).rgb
               + texture2D(uGalaxy, sphere * vec2(2.0, 1.0)).rgb * 0.35;
    colour += stars * uStarColour * uStarBrightness * above;
  }

  // The sun. SunCentre is (0.980, 1.000) in all 99 keyframes and
  // visualSettings.dat's sky.sun.centreStart/centreEnd are 0.98/1.00, so the
  // disc is a smoothstep across that band of cos(angle to the sun) - a soft blob
  // about 11 degrees wide, which is why the game also carries a separate SunSize
  // for the tight corona around it.
  float disc = smoothstep(uSunCentre.x, uSunCentre.y, alignment);
  float corona = pow(max(alignment, 0.0), max(360.0 / max(uSunSize, 0.05), 8.0));
  colour += uSunCore * disc * uSpriteBrightness;
  colour += uSunCorona * corona * uSpriteBrightness;

  if (uHasTextures > 0.5 && uCloudCoverage > 0.001) {
    // Clouds are a flat layer read through the dome, so the direction is
    // projected onto it. The +0.10 keeps the projection finite at the horizon
    // instead of stretching to infinity.
    vec2 plane = direction.xz / max(direction.y + 0.10, 0.02);
    vec2 uv = plane * uCloudScale + vec2(uCloudScroll, uCloudScroll * 0.6);

    // baseperlinnoise3channel.dds is a lattice of random values, not a smooth
    // gradient noise, so it only becomes cloud once it is summed as octaves -
    // sampled flat it is either two magnified blobs or a field of speckle,
    // depending which way the scale is wrong. Each octave reads a different
    // channel so the three lattices stay decorrelated.
    vec3 o1 = texture2D(uPerlin, uv).rgb;
    vec3 o2 = texture2D(uPerlin, uv * 2.3 + vec2(0.31, 0.17)).rgb;
    vec3 o3 = texture2D(uPerlin, uv * 4.7 + vec2(0.73, 0.49)).rgb;
    float density = o1.r * 0.5 + o2.g * 0.3 + o3.b * 0.2;

    // detailbump2.dds is the high-frequency break-up CloudDetailScale and
    // CloudStrength are named for, kept off the silhouette so it roughens the
    // edges instead of dissolving them.
    float detail = texture2D(uDetail, uv * uCloudDetailScale * 0.25 + vec2(uCloudScroll * 1.7, 0.0)).r;
    density += (detail - 0.5) * uCloudStrength * 0.18;

    // Coverage is CloudAlpha: 0 under a clear midnight, 0.30 for ordinary
    // cover, 0.85 when DRIZZLE is overcast. It moves the threshold the noise has
    // to clear; CloudEdgeSmooth is how soft that edge is.
    float threshold = mix(1.00, 0.20, uCloudCoverage);
    float cloud = smoothstep(threshold, threshold + max(uCloudEdgeSmooth * 0.35, 0.02), density);
    cloud *= above;

    // Lit from the sun side and shaded underneath, with CloudInscatteringRange
    // setting how far the sun bleeds through around it.
    // Inscattering is lit off the cloud's own top colour, not the sun sprite:
    // the sprite is scaled to punch through bloom as a disc, and borrowing that
    // magnitude for a lobe this wide turned every cloud within 30 degrees of the
    // sun into flat white. The exponent is what keeps it a rim around the sun
    // rather than a wash over half the sky.
    vec3 lit = mix(uCloudColour, uCloudTopColour, clamp(density * 1.4, 0.0, 1.0));
    lit += uCloudTopColour * pow(max(alignment, 0.0), 24.0) * uCloudInscattering;
    colour = mix(colour, lit, cloud);
  }

  // Below the horizon the dome would otherwise cut to a hard edge against the
  // fogged geometry, so fade into the haze colour instead.
  vec3 haze = (uSkyColour + uAzimuthStrength * horizon) * uHazeAmount;
  colour = mix(haze, colour, smoothstep(-0.10, 0.02, direction.y));

  gl_FragColor = vec4(colour, 1.0);
}
`;

const SKY_VERTEX = /* glsl */`
varying vec3 vDirection;
void main() {
  vDirection = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// pc/textures/skydome.wtd, unpacked by `npm run extract:sky`. The dictionary
// also holds moon.dds, moonglow.dds and noise16p.dds, which nothing here draws
// yet.
const SKY_TEXTURES = {
  uPerlin: { file: 'baseperlinnoise3channel.png', colour: false },
  uDetail: { file: 'detailbump2.dds', colour: false },
  uStarfield: { file: 'starfield.dds', colour: true },
  uGalaxy: { file: 'galaxy.dds', colour: true },
};

export class LightingRig {
  constructor(scene, renderer, camera, timecycle, options = {}) {
    this.scene = scene;
    this.renderer = renderer;
    this.camera = camera;
    this.timecycle = timecycle;

    this.weather = options.weather ?? 'EXTRASUNNY';
    this.hour = options.hour ?? 12;
    // All three are viewer-side, not from the game. See the DERIVED note above.
    this.exposureGain = options.exposureGain ?? 1;
    this.dayKey = options.dayKey ?? 1.7;
    // Provisional: with no emissive night shaders or street lights yet, the
    // only thing lighting the city after dark is Amb0, so a truthful night key
    // renders near-black silhouettes. Lifted until gta_emissivenight* and the
    // 2dfx coronas exist to light it properly.
    this.nightKey = options.nightKey ?? 0.55;
    this.skyGain = options.skyGain ?? 0.75;
    this.fogDensity = options.fogDensity ?? 1.5;
    // The sky is legitimately much brighter than the ground - SkyLightMult is
    // over 4x AmbLightMult0 at 9AM - but handing the fog that same radiance
    // makes anything past a few blocks as bright as the sky itself and washes
    // the city out. The haze is dimmed relative to the dome it is sampled from.
    this.fogGain = options.fogGain ?? 0.5;
    // AzimuthHeight is not a column - it wants 1.0, which makes the horizon
    // glow fall off linearly and reach zero at the zenith. Columns 76, 79 and
    // 93 all sit at 1.000 in all 99 keyframes and any of them could be it.
    this.azimuthHeight = options.azimuthHeight ?? 1;
    this.azimuthGain = options.azimuthGain ?? 1;
    this.cloudGain = options.cloudGain ?? 1;
    // How far SunsetColor spreads either side of the sun's bearing. The file
    // says which colour and when, but not how wide, so this is viewer-side.
    this.sunsetAmount = options.sunsetAmount ?? 1.1;
    // How much of the noise a skyful of cloud covers. The cloud plane collapses
    // to a point at the zenith, so too low a number magnifies a couple of noise
    // cells across the whole sky and the clouds read as smeared blobs.
    this.cloudScale = options.cloudScale ?? 0.12;
    // The sun sprite keeps its own gain, off the same decoupled exposure as the
    // dome, because SunMult reaches 13 and multiplies an already-white colour.
    this.sunSpriteGain = options.sunSpriteGain ?? 0.28;
    // DERIVED. StarFieldBrightness could not be pinned to a column with any
    // confidence, so the stars are faded on sun elevation instead.
    this.starGain = options.starGain ?? 1.4;
    // visualSettings.dat sets sky.GameCloudSpeed to 0, so the game's clouds do
    // not drift on their own clock. A slow scroll reads better in a viewer that
    // has no wind, and it is the only part of the sky that is invented.
    this.cloudSpeed = options.cloudSpeed ?? 0.0015;
    this.sunPath = { sunrise: SUNRISE, sunset: SUNSET, tilt: 0.42, ...options.sunPath };

    this.ambient = new THREE.HemisphereLight(0xffffff, 0xffffff, 1);
    scene.add(this.ambient);

    this.sun = new THREE.DirectionalLight(0xffffff, 1);
    this.sun.position.set(0, 1, 0);
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.sunDir = new THREE.Vector3(0, 1, 0);
    this.uniforms = {
      uSkyColour: { value: new THREE.Color(0.1, 0.2, 0.5) },
      uAzimuthColour: { value: new THREE.Color(0.5, 0.6, 0.8) },
      uAzimuthColourEast: { value: new THREE.Color(0.5, 0.6, 0.8) },
      uAzimuthHeight: { value: this.azimuthHeight },
      uAzimuthStrength: { value: 0.46 },
      uSunsetColour: { value: new THREE.Color(0, 0, 0) },
      uSunsetAmount: { value: this.sunsetAmount },
      uSunCore: { value: new THREE.Color(1, 1, 1) },
      uSunCorona: { value: new THREE.Color(1, 0.9, 0.7) },
      uSunDir: { value: this.sunDir },
      uSunCentre: { value: new THREE.Vector2(0.98, 1) },
      uSunSize: { value: 1.2 },
      uSpriteBrightness: { value: 1.2 },
      uCloudColour: { value: new THREE.Color(0.4, 0.4, 0.4) },
      uCloudTopColour: { value: new THREE.Color(0.8, 0.8, 0.8) },
      uCloudCoverage: { value: 0 },
      uCloudEdgeSmooth: { value: 0.757 },
      uCloudDetailScale: { value: 8 },
      uCloudStrength: { value: 0.667 },
      uCloudInscattering: { value: 0.68 },
      uCloudScroll: { value: 0 },
      uCloudScale: { value: this.cloudScale },
      uStarColour: { value: new THREE.Color(1, 1, 1) },
      uStarBrightness: { value: 0 },
      uHazeAmount: { value: 0.75 },
      uHasTextures: { value: 0 },
      uPerlin: { value: null },
      uDetail: { value: null },
      uStarfield: { value: null },
      uGalaxy: { value: null },
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
    this.loadTextures(options.skyTextureDir ?? './assets/sky/');
  }

  // The dome renders correctly without these - it is the gradient and the sun
  // that carry it - so a missing web/assets/sky just means no clouds or stars
  // rather than a broken scene.
  async loadTextures(directory) {
    const dds = new DDSLoader();
    const plain = new THREE.TextureLoader();
    try {
      const loaded = await Promise.all(Object.entries(SKY_TEXTURES).map(([uniform, spec]) =>
        new Promise((resolve, reject) => {
          const loader = spec.file.endsWith('.dds') ? dds : plain;
          loader.load(directory + spec.file, texture => resolve([uniform, spec, texture]), undefined, reject);
        })));
      for (const [uniform, spec, texture] of loaded) {
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        if (spec.colour) texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = 4;
        this.uniforms[uniform].value = texture;
      }
      this.uniforms.uHasTextures.value = 1;
    } catch (error) {
      console.warn('Sky textures are not built; run npm run extract:sky.', error);
    }
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
    // DERIVED, and the Exposure column is deliberately not used. In the file
    // Exposure exists to cancel the light multipliers - EXTRASUNNY midnight is
    // AmbLightMult0 3.51 at Exposure 2.69, which lands 8x brighter than
    // midday's 6.25 at 0.19 - because the engine then puts HDR luminance
    // adaptation, clamped by LumMin/LumMax, on top. Without that adaptation,
    // honouring Exposure makes midnight as bright as noon.
    //
    // So aim the frame's ambient contribution at an explicit target instead,
    // driven by sun elevation. Exposure cancels out of that arithmetic by
    // construction, and the result is stable across weathers - RAIN's midnight
    // Exposure of 0.27 and EXTRASUNNY's 2.69 both land on the same key.
    const key = THREE.MathUtils.lerp(this.nightKey, this.dayKey, daylight) * this.exposureGain;
    this.exposure = key / Math.max(frame.ambLightMult0, 1e-3);

    srgb(this.ambient.color, frame.amb0);
    srgb(this.ambient.groundColor, frame.amb1);
    // HemisphereLight has one intensity for both hemispheres, so carry Amb0's
    // multiplier and fold the Amb1/Amb0 ratio into the ground colour.
    this.ambient.intensity = frame.ambLightMult0;
    this.ambient.groundColor.multiplyScalar(frame.ambLightMult1 / Math.max(frame.ambLightMult0, 1e-3));

    srgb(this.sun.color, frame.dir);
    this.sun.intensity = frame.dirLightMult * frame.globalSunMult;

    // The sky columns are floats rather than 0-255 bytes, but they are authored
    // in the same file by the same people and read as sRGB: decoded that way
    // EXTRASUNNY's midnight zenith is a deep blue, and taken as linear it is a
    // pale grey that no night sky has ever been.
    //
    // SkyLightMult deliberately does NOT scale the dome. It is how much light
    // the sky casts on the city, which is not the same number as how bright the
    // dome draws - gta_atmoscatt_clouds takes a separate HDRExposure for that,
    // and SkyColor is handed to it raw. Folding SkyLightMult in as well
    // double-counts: it runs 1.8 at midnight to 11.5 at midday, and 7PM pairs
    // 11.25 with a SkyColor already up at (0.73, 0.92, 1.00), which clipped the
    // whole sunset to one flat orange with no gradient left in it.
    //
    // The dome does not ride the scene exposure either, which is what the
    // separate HDRExposure is telling us. The scene exposure is the reciprocal
    // of AmbLightMult0, so it is a statement about how brightly the ground is
    // lit - and at 6AM AmbLightMult0 falls to 1.69, which sent the exposure to
    // 0.77 and rendered a dawn sky 2.8x brighter than midday's. Dividing it
    // back out here leaves the dome's brightness as SkyColor times one constant
    // in every keyframe, so the day/night swing comes from the colours the
    // artists authored rather than from the ground's exposure.
    const radiance = this.skyGain / Math.max(this.exposure, 1e-4);
    const strength = frame.azimuthStrength * this.azimuthGain;
    const skyColour = srgbColor(frame.skyColour).multiplyScalar(radiance);
    const azimuth = srgbColor(frame.azimuthColour).multiplyScalar(radiance);
    const azimuthEast = srgbColor(frame.azimuthColourEast).multiplyScalar(radiance);

    this.uniforms.uSkyColour.value.copy(skyColour);
    this.uniforms.uAzimuthColour.value.copy(azimuth);
    this.uniforms.uAzimuthColourEast.value.copy(azimuthEast);
    this.uniforms.uAzimuthHeight.value = this.azimuthHeight;
    this.uniforms.uAzimuthStrength.value = strength;
    srgb(this.uniforms.uSunsetColour.value, frame.sunsetColour).multiplyScalar(radiance);
    this.uniforms.uSunsetAmount.value = this.sunsetAmount;

    // Both the disc and the glow are drawn in SunCorona. The column the header
    // calls SunCore cannot be the disc: it is a saturated blue or cyan in every
    // daylight keyframe - (23, 126, 251) at 5AM, (139, 251, 232) at 6AM - while
    // SunCorona is the one that goes white as the sun comes up, and the pixel
    // shader only ever takes one SunColor anyway.
    // The SunCentre band is 11 degrees wide, so it is the halo around the sun
    // rather than the sun itself; at full brightness it renders as one flat
    // white disc a fifth of the sky across. It carries a fraction of the light
    // and the tight SunSize corona inside it is what reads as the disc.
    const sunSprite = frame.sunMult * this.sunSpriteGain / Math.max(this.exposure, 1e-4);
    srgb(this.uniforms.uSunCore.value, frame.sunCorona).multiplyScalar(sunSprite * 0.12);
    srgb(this.uniforms.uSunCorona.value, frame.sunCorona).multiplyScalar(sunSprite);
    this.uniforms.uSunCentre.value.set(
      frame.sunCentreStart,
      Math.max(frame.sunCentreEnd, frame.sunCentreStart + 1e-4),
    );
    this.uniforms.uSunSize.value = frame.sunSize;
    this.uniforms.uSpriteBrightness.value = frame.spriteBrightness;

    // LowCloudsRGB and BottomCloudRGB are named in timecyc.dat's own header, so
    // the cloud body is the one part of the layer that needs no inference: the
    // low colour lights the tops, the bottom colour shades the undersides.
    srgb(this.uniforms.uCloudTopColour.value, frame.lowClouds).multiplyScalar(radiance);
    srgb(this.uniforms.uCloudColour.value, frame.bottomClouds).multiplyScalar(radiance);
    this.uniforms.uCloudCoverage.value = frame.cloudAlpha * this.cloudGain;
    this.uniforms.uCloudEdgeSmooth.value = frame.cloudEdgeSmooth;
    this.uniforms.uCloudDetailScale.value = frame.cloudDetailScale;
    this.uniforms.uCloudStrength.value = frame.cloudStrength;
    this.uniforms.uCloudInscattering.value = frame.cloudInscatteringRange;

    this.uniforms.uStarBrightness.value = (1 - daylight) * this.starGain;

    // FarClp is the game's draw distance and is a flat 1500 in every weather
    // but TEMP. FogSt is deliberately NOT used as a fog start distance: its
    // values contradict that reading (FOGGY sits at 73-79 while SUNNY drops to
    // 9), so it is something closer to a sky-blend or height term. Exponential
    // fog tuned to reach the far plane keeps the near field clear, which is how
    // the game reads, instead of veiling everything a few blocks out.
    //
    // The haze is the dome's own colour at the horizon, which is now something
    // the gradient can actually be asked for: dir.y = 0 makes the azimuth term
    // full strength, and averaging the east and west ends gives the band the fog
    // sits in whichever way the camera faces.
    this.scene.fog.color.copy(azimuth).lerp(azimuthEast, 0.5)
      .multiplyScalar(strength)
      .add(skyColour)
      .multiplyScalar(this.fogGain);
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
    this.uniforms.uCloudScroll.value = performance.now() * 0.001 * this.cloudSpeed;
  }
}
