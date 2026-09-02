# GTA IV browser map prototype

This project reads the installed GTA IV archives locally and exports the complete
outdoor Liberty City map — 34 sectors across Manhattan, Broker/Dukes/Bohan and
Alderney — to a streaming Three.js viewer with Overview, Fly and Walk modes.
Rockstar assets remain local and are not included in the source code.

## Run

```powershell
cd "C:\Games\Grand Theft Auto IV - The Complete Edition\_webmap"
npm install
npm run serve
```

Open <http://127.0.0.1:4174>.

## Rebuild the map

```powershell
npm run extract:world   # all 34 outdoor sectors + web/assets/world.json
npm run extract         # single proof sector (manhat01) only
```

The extractor reads each sector's `.img`, its base/streaming WPL placements,
WDR/WDD models, and WTD texture dictionaries. It writes an instanced,
Meshopt-compressed glTF scene per sector plus a deduplicated cache of the
original DDS texture mip chains shared across every sector.

Texture lookup is engine-faithful: GTA IV's `pgDictionary` hash table is keyed on
the bare leaf name with no extension (`road4cobble`), not on the stored
`pack:/road4cobble.dds` spelling. Verified against all 50,663 texture entries
under `pc/`.

## Lighting

```powershell
npm run extract:timecyc   # pc/data/timecyc.dat -> web/data/timecyc.json
```

The viewer is lit from the game's own timecycle: 9 weathers x 11 keyframes,
interpolated for the current hour to drive the ambient pair (Amb0/Amb1), the
sun (Dir), fog, the sky gradient and exposure. Time and weather
are on the HUD panel.

The sun's direction is reconstructed, because timecyc.dat does not store it: an
arc whose sunrise and sunset come from the SunMult column, which holds at 13
through 9PM — IV's day runs about 05:30 to 21:30, not 06:00 to 18:00. The
day/night brightness ratio is reconstructed too; see the Exposure note below.

FogSt is parsed but not used as a fog start distance — FOGGY sits at 73-79
while SUNNY drops to 9, so it cannot mean that. Fog is exponential, tuned to
reach FarClp, and dimmed relative to the sky it is sampled from: SkyLightMult
runs to 4x AmbLightMult0, and haze at full sky radiance washes the city out.

### Colour grade

The grade runs from the same keyframes, in `web/grade.js`: ColourCorrectRGB and
ColourAddRGB, Desaturation/Contrast/Gamma in near and far variants blended
between DepthFxNear and DepthFxFar, and bloom from
BPThreshold/MidGreyValue/IntensityBloom. Toggle it on the HUD panel.

Ordering note worth knowing: three.js applies tone mapping only when a material
renders straight to the canvas, so everything the composer sees is raw HDR
radiance. That pass therefore owns exposure, ACES and the sRGB encode as well as
the grade, and the sky dome deliberately stays in raw radiance so it and the
scene are tone mapped by the same code.

How each grade column is meant to be applied is undocumented, so each reading is
inferred from the data, recorded in the shader with its evidence, and sits behind
a gain. In short: ColourCorrectRGB is a tint about a 0.5 neutral (the whole file
averages 0.462) and is doubled; Desaturation is the saturation that survives,
used directly; Gamma is a direct exponent; Contrast pivots on MidGreyValue and is
softened because it reaches 10.0.

Exposure is not taken from the file. The Exposure column exists to cancel the
light multipliers - EXTRASUNNY midnight lands 8x brighter than midday if honoured
- because the engine layers HDR luminance adaptation on top. The rig aims the
frame's ambient contribution at an explicit key instead, which cancels Exposure
out of the arithmetic and is stable across weathers.

Still on the renderer, not yet done: cascaded sun shadows, normal and specular
maps, the `gta_emissivenight*` shaders that light the windows after dark, and the
2dfx coronas. Until those exist the night key is lifted above what the data
implies, because Amb0 is the only thing lighting the city after dark.

Known soft spot: the 7AM/9AM keyframes give a strongly green-tinted haze. Those
sit in the sky model - Sky top is near black in every keyframe and Sky bot is the
only usable horizon colour - which is the least certain part of the reconstruction.

## Checks

```powershell
npm test                        # browser smoke test -> artifacts/*.png
node test/probe-white.mjs       # per-pixel material/texture audit of the view
node test/timecyc-shots.mjs     # one frame per keyframe -> artifacts/timecyc/
node test/baked-ab.mjs          # COLOR_0 lighting on/off -> artifacts/baked/
node test/grade-depth.mjs       # asserts the grade's near/far split reads depth
```
