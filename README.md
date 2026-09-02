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
sun (Dir), fog, the sky gradient and tone-mapping exposure. Time and weather
are on the HUD panel.

Two values are reconstructed rather than read, because timecyc.dat does not
store them. The sun's direction is derived from an arc whose sunrise and sunset
come from the SunMult column, which holds at 13 through 9PM — IV's day runs
about 05:30 to 21:30. And the day/night brightness ratio is an explicit viewer
setting: in the file the Exposure column cancels the light multipliers almost
exactly (midday 14.75 x 0.19, midnight 1.00 x 2.69), because the engine layers
HDR luminance adaptation on top of them and this does not.

FogSt is parsed but not used as a fog start distance — FOGGY sits at 73-79
while SUNNY drops to 9, so it cannot mean that. Fog is exponential, tuned to
reach FarClp.

Still on the renderer, not yet done: the colour-grade pass
(Desaturation/Contrast/Gamma/ColourCorrectRGB, near and far, plus bloom from
BPThreshold/IntensityBloom), cascaded sun shadows, normal and specular maps,
the `gta_emissivenight*` shaders that light the windows after dark, and the
2dfx coronas.

## Checks

```powershell
npm test                        # browser smoke test -> artifacts/*.png
node test/probe-white.mjs       # per-pixel material/texture audit of the view
node test/timecyc-shots.mjs     # one frame per keyframe -> artifacts/timecyc/
node test/baked-ab.mjs          # COLOR_0 lighting on/off -> artifacts/baked/
```
