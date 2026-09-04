# Liberty City browser map

An experimental, local-only Three.js viewer and extraction pipeline for Grand
Theft Auto IV: The Complete Edition.

This project reads the installed GTA IV archives locally and exports the complete
outdoor Liberty City map — 34 sectors across Manhattan, Broker/Dukes/Bohan and
Alderney — to a streaming Three.js viewer with Overview, Fly and Walk modes.
Walk mode plays as Niko in third person, with his own skeleton, textures and
animations. The city's cast is exported too: all 127 traffic vehicles, and 343
ambient peds driven by one shared library of 112 locomotion clips. Rockstar
assets remain local and are not included in the source code.

> [!IMPORTANT]
> This repository contains source code only. It does not include or download
> GTA IV game files. You must own and supply a legally installed copy of GTA IV:
> The Complete Edition. Do not commit or redistribute generated files from
> `web/assets/` or `web/data/`.

This is an unofficial fan project and is not affiliated with or endorsed by
Rockstar Games or Take-Two Interactive. Grand Theft Auto, GTA IV, Liberty City,
and related names are trademarks of their respective owners.

| | models | payload |
| --- | --- | --- |
| map | 34 sectors | see Rendering |
| player | 1, 62 clips | 2.8 MB |
| vehicles | 127 | 19 MB |
| peds | 343, 112 shared clips | 30 MB + 51 MB textures |

## Requirements

- Windows 10 or 11 with Windows PowerShell
- A legally installed copy of GTA IV: The Complete Edition
- Git
- Node.js 22 or newer
- .NET SDK 8, or permission for the setup script to install a repository-local
  copy
- Chrome or Edge for the browser checks

The repository must be cloned directly inside the game installation. The
extractors intentionally resolve the parent directory as the game root:

```text
Grand Theft Auto IV - The Complete Edition/
├── GTAIV.exe
├── pc/
└── _webmap/       # this repository
```

## Setup

From the repository directory, install the JavaScript dependencies, fetch the
pinned GTA4Unity/RageLib source dependency, and install .NET locally when it is
not already available:

```powershell
./setup.ps1
```

The generated game assets are intentionally absent from a fresh clone. Build
them locally, then start the static server:

```powershell
npm run extract:world
npm run serve
```

Open <http://127.0.0.1:4174>.

Generated assets can take several gigabytes. They and all other game-derived
data are ignored by Git.

## Rebuild the map

```powershell
npm run extract:world   # all 34 outdoor sectors + web/assets/world.json + texture bundles
npm run extract         # single proof sector (manhat01) only
npm run pack            # texture bundles only (--max-edge 256, --sector <id>, --force)
npm run extract:player  # Niko + his animation clips -> web/assets/player/
npm run extract:vehicles # all 127 traffic vehicles -> web/assets/vehicles/
npm run extract:peds    # all 343 ambient peds + shared clips -> web/assets/peds/
npm run extract:weapons # pistol, M4 and RPG + their stats -> web/assets/weapons/
npm run extract:paths   # the road network -> web/data/paths.json
npm run extract:navmesh # the ped navmesh -> web/data/navmesh.json + .bin
```

The extractor reads each sector's `.img`, its base/streaming WPL placements,
WDR/WDD models, and WTD texture dictionaries. It writes an instanced,
Meshopt-compressed glTF scene per sector plus a deduplicated cache of the
original DDS texture mip chains shared across every sector.

Texture lookup is engine-faithful: GTA IV's `pgDictionary` hash table is keyed on
the bare leaf name with no extension (`road4cobble`), not on the stored
`pack:/road4cobble.dds` spelling. Verified against all 50,663 texture entries
under `pc/`.

## Rendering

The viewer is draw-call bound, not fill or shader bound, so the renderer is
built around collapsing draw calls rather than simplifying pixels:

- `tools/pack-textures.mjs` buckets each sector's DDS files by size and format
  into WebGL2 texture arrays, trimming leading mips to `--max-edge` (256 by
  default). Trimming is a slice of the chain the game already stored, so it
  needs no re-encode, and it merges buckets — a trimmed 512x512 lands exactly on
  the native 256x256 bucket. ~800 textures per sector become ~24 arrays.
- `web/sector-builder.js` then merges everything sharing an array into one
  `BatchedMesh`, sampling `sampler2DArray` through a per-vertex layer index.
  Texture *arrays* rather than an atlas, because this content tiles and atlasing
  would break `RepeatWrapping`.

Measured on an AMD iGPU at 1440x900, versus one material per texture:

| | before | after |
| --- | --- | --- |
| draw calls | 3,590 | 88 |
| shader programs | ~3,500 materials | 2 |
| render time | 32.7 ms | 3.4 ms |
| requests to first render | 2,838 | 19 |

Sector residency is capped by texture memory, not draw calls — see `tuning` in
`web/app.js`.

Batching decides the baked-lighting split at build time. GTA IV's prelighting
lives in COLOR_0, so `web/sector-builder.js` widens it to a float vec3 on every
batch geometry that carries it (white where a placement has none), and groups on
whether the batch is baked as well as on its array and cutout flag. That keeps
the `gta_terrain_va_*` family — which reuses COLOR_0 as per-layer blend weights
rather than light — in its own batches with `vertexColors` off, and leaves the
HUD toggle flipping a couple of dozen materials instead of several thousand.

## Lighting

```powershell
npm run extract:timecyc   # pc/data/timecyc.dat -> web/data/timecyc.json
npm run extract:sky       # pc/textures/skydome.wtd -> web/assets/sky/
```

The viewer is lit from the game's own timecycle: 9 weathers x 11 keyframes,
interpolated for the current hour to drive the ambient pair (Amb0/Amb1), the
sun (Dir), fog, the sky and exposure. Time and weather are on the HUD panel.

The sun's direction is reconstructed, because timecyc.dat does not store it: an
arc whose sunrise and sunset come from the SunMult column, which holds at 13
through 9PM — IV's day runs about 05:30 to 21:30, not 06:00 to 18:00. The
day/night brightness ratio is reconstructed too; see the Exposure note below.

FogSt is parsed but not used as a fog start distance — FOGGY sits at 73-79
while SUNNY drops to 9, so it cannot mean that. Fog is exponential, tuned to
reach FarClp, and its colour is the dome's own gradient evaluated at the
horizon, averaged across the east and west ends so it holds whichever way the
camera faces.

### The sky

The sky is not reconstructed. GTA IV draws it with `gta_atmoscatt_clouds`, and
`common/shaders/dcl` ships that shader's assembly with every constant named, so
`web/lighting.js` is a transcription of the game's own sky maths. Reading the
vertex shader's last dozen instructions gives the gradient exactly:

```
azimuth = (1 - saturate(dir.y * AzimuthHeight)) * AzimuthStrength
sky     = SkyColor + azimuth * mix(AzimuthColorEast, AzimuthColor, dir.x * 0.5 + 0.5)
```

Two things fall out of that which no amount of eyeballing would have found. The
horizon colour is **added** to the zenith colour rather than crossfaded with it,
so SkyColor is the whole dome's floor and the azimuth term is a glow laid over
it. And the horizon is **two** colours split east/west, which is what paints the
warm side of a sunrise without tinting the entire sky.

Naming the shader's constants also turns "what is column 64" into "which
constant does column 64 behave like", which the data can answer. timecyc.dat's
header leaves columns 63-119 unnamed; `tools/parse-timecyc.mjs` now names nine
of them and records the evidence for each. The strongest:

| column | constant | why |
| --- | --- | --- |
| 64-66 | SkyColor | goes flat grey in RAIN and blue in EXTRASUNNY |
| 67-69, 70-72 | AzimuthColor, AzimuthColorEast | bit-identical at 9AM and 6PM, split warm/cool at 6AM and 7PM |
| 73-75 | SunsetColor | (1.000, 0.882, 0.588) in exactly the keyframes either side of the sun, muted grey in every other |
| 63 | AzimuthStrength | 1.389 under a clear midnight — the city lighting its own haze |
| 88, 89 | CloudInscatteringRange, CloudEdgeSmooth | 0.680 and 0.757 against visualSettings.dat's 0.68 and 0.76 |
| 116-117 | SunCentre start/end | 0.980 and 1.000, exactly visualSettings.dat's sky.sun.centreStart/End |

The columns the header *does* name were the wrong ones: "Sky top" is `0 0 0` at
9AM, so the old two-stop dome was built on a black zenith and had to be lifted
with Amb0 to look like anything.

`npm run extract:sky` unpacks `pc/textures/skydome.wtd`, which is where the sky's
own textures live — a three-channel Perlin lattice and a detail bump for the
clouds, plus a starfield and a galaxy band for the night. The clouds are that
lattice summed as three octaves (sampled flat it is either two magnified blobs
or a field of speckle), thresholded by CloudAlpha — a 0-255 byte that reads 0
under a clear midnight and 217 when DRIZZLE is overcast — and coloured by the
LowCloudsRGB/BottomCloudRGB pair the header does name. The dictionary also holds
`moon.dds` and `moonglow.dds`, which nothing draws yet.

Two things about brightness are worth writing down, because both produced a
flat, blown-out sky before they were understood. SkyLightMult does not scale the
dome — it is how much light the sky casts on the city, not how brightly the dome
draws, which is what the shader's separate HDRExposure is for. And the dome does
not ride the scene exposure either: that exposure is the reciprocal of
AmbLightMult0, so at 6AM it climbs to 0.77 and rendered a dawn sky 2.8x brighter
than midday's. Dividing it back out leaves the dome's brightness as SkyColor
times one constant in every keyframe.

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
maps, the `gta_emissivenight*` shaders that light the windows after dark, the
2dfx coronas, and the moon. Until those exist the night key is lifted above what
the data implies, because Amb0 is the only thing lighting the city after dark.

Still inferred in the sky, and marked as such in the source: AzimuthHeight is not
a column at all — it wants 1.0, and columns 79 and 93 both hold 1.000 in all 99
keyframes, so either could be it. How far SunsetColor spreads either side of the
sun is a viewer-side choice; the file says which colour and when, but not how
wide. StarFieldBrightness could not be pinned to a column with any confidence, so
the stars fade on sun elevation instead. And the column the header calls SunCore
cannot be the sun's disc — it is a saturated blue or cyan in every daylight
keyframe, while SunCorona is the one that goes white as the sun comes up — so
both the disc and its halo are drawn in SunCorona.

## The player character

`npm run extract:player` reads `pc/models/cdimages/playerped.rpf` and writes a
single skinned, animated glTF to `web/assets/player/`, sharing the same
deduplicated texture cache as the map:

- the 90-bone skeleton from `player.wft`, composed into glTF nodes plus a skin
  whose inverse bind matrices are derived from that hierarchy rather than from
  the file's own matrices, so the two cannot disagree
- Niko's default outfit (`head/hair/teef/uppr/lowr/feet/hand_000`) as skinned
  meshes; RAGE blend indices are remapped through each geometry's matrix palette
  into skin joints
- 62 clips: all 53 of `move_player.wad` (idle, walk, run, sprint, strafes,
  turns, starts and stops) and all 9 of `jump_std.wad`

`web/player.html` previews it on its own, without the streamed world.

Two things about the source clips shaped the export:

- **They run in place.** The `mover` track on bone 0 is a ±0.1 m body sway, not
  root motion — GTA IV drives travel from move-blend data the archives do not
  carry. Locomotion speed is therefore a tuning constant in `app.js` (`GAITS`),
  not something extracted, and clips are played back at
  `actualSpeed / gaitSpeed` to keep the feet off the ice.
- **They disagreed on facing.** `idle` opened at a root yaw of 0 while every
  locomotion clip opened at ~1.477 rad, so crossfading between them swung the
  body through the difference. The exporter now cancels each clip's opening yaw
  and records what it removed as `rootYawRemoved` in `manifest.json`; facing
  belongs to the viewer alone.

The map is exported through `(-x, z, -y)`, which is a reflection, so the world
is mirrored; the character uses the proper `(x, z, -y)` conversion and is
mirrored back to match with a single `scale.x = -1`.

## Vehicles

`npm run extract:vehicles` reads `pc/models/cdimages/vehicles.img` and writes
one Meshopt-compressed `.glb` per model into `web/assets/vehicles/`, plus a
`vehicles.json` catalogue, sharing the same deduplicated texture cache as the
map. All 127 models in `vehicles.ide` export, none skipped.

The thing worth knowing about a `.wft`: a car looks like it should be a bag of
loose parts, and it is not. The fragment's `Children` are physics proxies and
all but one report no geometry at all — the whole body is a *single* drawable,
rigid-skinned to the 40-70 bone fragment skeleton, with a per-geometry matrix
palette binding each panel to its bone. Doors, sirens, lights and glass separate
by joint, not by mesh. So a car exports through the same path the player does,
minus the clips, and the viewer opens a door by rotating `door_dside_f` rather
than by hunting for a door mesh.

The one genuine exception is the wheel. Wheel geometry lives in the frag
children, and unlike the body those drawables are authored in **bone-local**
space — vertices centred on the origin, not out at the hub the file stores them
against — so each is parented to its bone with no transform of its own, and
rolling a wheel is a rotation of that bone.

A car ships one wheel drawable and leaves its other three wheel children empty,
so that mesh is instanced onto every wheel bone. Bikes and six-wheelers ship
*two*, on `wheel_lf` and `wheel_lr`, because their front and rear wheels are
genuinely different sizes; each bone takes whichever side of its own axle exists,
and a six-wheeler's middle axle falls back to the rear wheel it shares a size
with. Collapsing those into one mesh puts a bike's rear tyre on the front.

That bone-local detail also decides where the vehicle sits. The ground offset
cannot come from the lowest vertex the way the character's does, because the
wheel's vertices are in a different space and reach 0.36 m below an origin that
is not the car's. It is measured instead as the true minimum of each tyre's
vertices under its own hub bone's world transform — rotation included, which
matters because a bike's front wheel hangs off a raked fork. On most vehicles
that contact patch, not the body, is the lowest thing on the model. Exported this
way every model lands on `y = 0`.

Two details the viewer depends on:

- **Paint is per-instance, not in the texture.** `gta_vehicle_paint*` samples a
  spec map; the actual colour comes from the model's `carcols.dat` sets, which
  the catalogue carries as indices into a shared 134-entry palette. Those
  materials are tagged `extras.paint` so the viewer knows what to tint. Every
  model has at least one colour set; the Banshee has 24, the police car 1.
- **Most of the surface is not in the model's own `.wtd`.** `police.wtd` holds
  three badge and light textures and nothing else; bodywork, glass and interior
  all resolve out of the shared `vehshare` dictionary. Lookup is model, then
  `vehshare`/`vehshare_truck`, then the drawable's embedded dictionary. Across
  all 127 models exactly one texture name fails to resolve — `givemechecker`,
  which is the game's own checkerboard placeholder.

`handling.dat` and `vehicles.ide` are parsed for the catalogue: mass, gearing,
top speed, steering lock, spawn frequency and traffic cap. Note that
`handling.dat` has no drive-type letter anywhere in the row — RWD/FWD/AWD is
column 7, `fDriveBiasFront`, being 0 / 1 / in between. Seat count is not in
`handling.dat` either; it comes from counting the skeleton's `seat_*` bones,
which also gives seat *positions* for free. The counts come out right: the
Banshee and Infernus two, the Admiral and police car four.

Wheel counts are a free sanity check on the whole pipeline, and they land: 101
models with four, 7 with two (the bikes), 5 with six (the trucks), 14 with none
(boats, helicopters, the subway).

`web/vehicles.html` previews the fleet on its own, the way `player.html` does the
character: pick a model, respray it from its own carcols sets, watch the wheels
turn. `npm run test:vehicles` drives that page over a spread of the shapes the
exporter has to get right — a saloon, a supercar, the police car with its seven
sirens, a bike, a six-wheeled truck and a boat with no wheels at all.

One note on testing ground contact, because both obvious instruments are wrong
and each is wrong somewhere different. `Box3` transforms a geometry's AABB, so a
*rotated* node inflates it: a spinning 0.33 m wheel, or a bike's raked fork,
reports a box reaching 0.14 m under the road while every vertex of it is above
the road. Reading `geometry.attributes.position` and applying `matrixWorld`
fixes that for the rigid wheels but is wrong for the body, which is skinned —
that attribute holds bind-pose vertices and the bones are what place them, so a
boat's hull reads 0.79 m high. The check parks the wheels and pushes skinned
vertices through `applyBoneTransform`; every model then measures within 0.2 mm
of the road.

## The population

`npm run extract:peds` reads `pc/models/cdimages/componentpeds.img` and writes
one Meshopt-compressed `.glb` per ped into `web/assets/peds/`, plus a shared
`animations.glb` and a `peds.json` catalogue.

An ambient ped is shaped differently from Niko, whose components are loose
`.wdr` files in `playerped.rpf`. Here each one is a triple: `<name>.wdd` is a
pgDictionary of component drawables, `<name>.wft` the skeleton, `<name>.wtd` the
textures.

The fact the whole design rests on: **every ped shares one skeleton.** All 345
`.wft` files are between 25,982 and 27,196 bytes, and they agree on all 80 bone
IDs. So the clip library is exported *once* — 112 clips from `move_m@generic`,
`move_f@generic` and `move_cop` — into a single `animations.glb` the viewer
fetches one time and plays on any ped. Embedding clips per ped instead would
have multiplied about 2 MB by the population and spent the entire budget on
duplicate walk cycles. To make that work the copies' small disagreements have to
be ironed out: they differ on a couple of bone *names* (`Char_L_Toe` against
`Char_L_Toe0`) while agreeing on every BoneID, so node names are taken from one
reference ped and applied by ID to all of them.

Three things were not what they looked like:

- **Component names are hashes, and the obvious fallback lies.** The dictionary
  keys are name hashes, reversed by hashing candidate spellings. Where that
  failed I first read the slot off the shader's texture name instead — which
  quietly broke peds, because a component can bundle geometry that is not its
  own slot. `m_y_bronx_01`'s `lowr_000_u` carries two geometries and the *first*
  is textured `head_diff_000_a_bla`, so the trousers were labelled a head, and
  they displaced the real head and left the ped headless. The dictionary name is
  the authority; the texture is only a fallback, and it now takes the slot from
  the geometry with the most vertices so a small patch cannot outvote the
  garment it sits on.
- **Ped texture names are not unique, and deduplicating by name is silently
  destructive.** Every ped's own `.wtd` calls its shirt `uppr_diff_000_a_uni`,
  and those are *different images* — verified by comparing bytes. Sharing the
  map's texture cache would have dressed all 343 in the first ped's clothes, so
  ped textures live in their own directory, namespaced per ped.
- **`superlod` is not a ped.** It is the game's 3-vertex stand-in for a body too
  far away to draw. It, and `m_y_gbik_hi_01` (which ships no `.wtd` of its own),
  are recorded in the catalogue's `skipped` list rather than silently dropped.

Textures are capped at 256 px on the long edge (`-MaxEdge`), which is a slice of
the mip chain the game already stored and so costs no re-encode — the same trick
`tools/pack-textures.mjs` uses on the map. Only the diffuse textures the default
outfit actually references are written, not all 33 in each `.wtd`.

Each ped exports the lowest-numbered variant of each slot — its default outfit.
The other variants are listed in the catalogue as `otherVariants` but not
exported: 343 bodies is already the variety, and shipping every shirt multiplies
the payload for little visible gain.

The meshopt pass runs one `npx` per ped, so a full population takes roughly half
an hour. If it is interrupted, `bash tools/compress-peds.sh` picks up from
whatever is still uncompressed and rewrites the catalogue — re-running
`npm run extract:peds` instead would re-extract every ped first, making all 343
`.gltf` files newer than their `.glb` and forcing the whole set through again.

`web/peds.html` previews the population, and `npm run test:peds` drives it over
a male, a female and two police types — asserting among other things that the
shared clip library actually moves each ped's own joints, which is what proves
the canonical BoneID naming holds across the population.

## Traffic

`npm run extract:paths` reads `common/data/maps/paths*.ipl` into
`web/data/paths.json`, and `web/traffic.js` drives cars along it.

Finding the network took a moment: the `path` section those text IPLs still
carry is *empty*. The data is in two sections the GTA III-era format never had —
`vnod` (a vehicle node: x, y, z and a street-name hash) and `link` (a node pair
plus a lane count). Of the four files, `paths` and `paths2` are the road network
(24,602 nodes, 24,568 edges, 1,440 junctions, median segment 8 m), `paths3` is
boat lanes — its Max file is literally `paths3_boats.max` — and `paths4`
(`Networkpaths_4.max`) has nodes but no links at all, so it is not a graph and is
skipped. Link indices are per file, so each file is parsed in its own index space
and offset on concatenation; every one of the 24,568 links resolves and no node
is left isolated.

**A node chain is one carriageway, not a road centreline.** This is the thing to
get right and it is not stated anywhere. Sampling 1,446 edges for their nearest
near-parallel neighbour gives a bimodal distribution with a clear mode at 9-10 m
— a dual carriageway with a separate chain per direction. So lanes straddle the
chain rather than sitting off one side of it. Reading the `lanes` column the
obvious way instead puts the outer lane of a 4-lane road 11.2 m wide of its own
carriageway, on the pavement. Cars now sit at most 1.6 m off their segment.

Direction is taken from node index order rather than at random, so every car on
a carriageway flows the same way instead of half of them driving into the other
half. That is a self-consistent convention, not a claim about the game's intent:
link columns 5 and 6 carry 0/1/2 and 0..3 with no meaning identified.

Models are drawn by `vehicles.ide`'s own `Frq` weight and capped by its
`MaxNum`, minus a list of things that are in the catalogue but are not ambient
traffic — emergency vehicles, the airport and dock plant, rail stock. 95 models
stay in the rotation; a typical 24-car sample shows about 20 distinct ones. Each
car takes a colour from its own `carcols` sets, cruises at 34-52 km/h, and rolls
its wheels from distance travelled rather than at a fixed rate.

Path node heights turn out to be the drivable surface already: probing against
the streamed city moves a car by a median of 0 and at most 0.15 m, and every car
measures within 0.1 m of the road. The probe is kept anyway, because those small
corrections are real and because it keeps cars on the surface over bridges and
slopes instead of trusting a straight line between two nodes.

A measurement trap worth recording, since it produced a confident wrong answer
first time round: a downward ray from above a car hits *that car's own bodywork*
before the road, and reports the surface as ~1.4 m above the wheels — which is
just the height of a roof. Vehicles are tagged `userData.isVehicle` so a ground
probe can skip them.

`web/traffic.html` previews the network and the driving with the city replaced
by a wireframe of the graph, so a failure there is the path data or the driving
and never sector streaming; `web/index.html` runs the same traffic in the real
world.

## The pedestrian navmesh

`npm run extract:navmesh` reads `pc/data/cdimages/navmeshes.img` into
`web/data/navmesh.json` + `navmesh.bin`: **910,402 walkable points in 3.5 MB**,
from all 3,600 tiles, none skipped.

This is the only source for where a person may stand. `paths*.ipl` is a vehicle
graph with nothing for peds — GTA IV navigates the crowd on a navmesh instead —
and RageLib has no reader for `.wnv`, so the format had to be worked out.

`nav.dat` gives the geometry: `SECTORS_PER_NAVMESH=2` over 50 m game sectors, so
each tile is 100 m. The filenames' indices are sector numbers, which is why they
are all even, and the 3,600 tiles form a dense 60x60 grid — 6,000 m per axis,
putting the world origin at -3000. Each tile is an RSC5 container with a zlib
stream at offset 12:

| offset | meaning |
| --- | --- |
| `0x40`, `0x44` | tile size X, Y — always 100 |
| `0x48` | tile Z extent — varies per tile, 0 to ~215 m |
| `0x58` / `0x78` | vertex array / count — 6 bytes, 3 x uint16 quantised over the tile |
| `0x60` / `0x68` | index array / count — uint16 into the vertices |
| `0x6c` / `0x7c` | polygon array / count — 40 bytes, uint16 at `+4` is its first index |

A polygon's vertex count is the next polygon's first index minus its own, which
gives 3 to 10.

Three independent checks, because a self-consistent reading of a binary is not
the same as a correct one:

- Decoded vertices land **0.07-0.72 m** from road-graph nodes in the same tile,
  which pins the origin, the tile size and the absence of an axis flip.
- The index array holds **exactly `vertexCount` distinct values with a maximum
  of `vertexCount - 1`** — it addresses every vertex and nothing else. This is
  what identified it: three other candidate arrays gave out-of-range indices or
  polygons whose vertices were scattered across the tile.
- Across 18 tiles from 67 to 7,121 vertices: no out-of-range index, no
  degenerate polygon, and a median height spread **within** a polygon of
  0.00-0.48 m. Navmesh polygons are flat, and wrong indexing cannot produce
  that.

And the output check: every road node in the city has a walkable point within
15 m, mean **2.17 m**. Pavement exists beside every road, which is what a ped
navmesh should say.

**The per-tile Z minimum is not decoded, and is not needed.** The Z extent is
stored at `0x48` but the base is not, and no float anywhere in a tile's header
matches the offset measured against real road heights (it varies per tile:
+15.65, -9.14, +0.51, -24.20, +35.29). Heights come from the viewer's own ground
raycast, which is exact; what the navmesh uniquely provides is the walkable
footprint in plan.

Points are polygon centroids thinned onto a 2.5 m grid — 1.86 million polygons
becomes 910 thousand points, about 253 per tile. Full detail is far more than a
crowd needs and would not fit in a sensible download.

## The crowd

`web/crowd.js` walks peds along the navmesh points, spawned into a ring around
the player and culled outside a larger one, the same population model the
traffic uses. `web/nav-points.js` holds the walkable set and answers "what is
near here" and "where can this ped step next".

Two things about it are worth knowing, because both were bugs first.

**Clips are namespaced by their source wad.** `move_m@generic`, `move_f@generic`
and `move_cop` share **50 clip names** between them — `walk`, `run` and `idle`
among them — so a flat library silently resolves `walk` to whichever wad loaded
first, and the entire female population inherits the male gait. Clips are now
`m@generic/walk`, `f@generic/walk`, `cop/walk`, and the test asserts that each
ped is playing a clip from its own set rather than merely playing something.

**The reference skeleton is chosen before any filter.** Bone names are stamped
from one reference ped onto every ped and onto the clip library. Re-exporting
*just* the clips with a ped filter picked a different reference, and since peds
disagree on two bone names (`Char_L_Toe` against `Char_L_Toe0`, same BoneID) the
library came back with tracks for bones the population does not have — visible
only as a `THREE.PropertyBinding` warning and two dead toes.

Heights come from the same ground probe the traffic uses, since the navmesh has
none. Peds are probed once at spawn — before they are ever shown, and the spawn
is abandoned if nothing is under it — because unlike traffic there is no node
height to fall back on, and an unprobed ped stands at `y = 0`, which in this city
is anywhere from a basement to a rooftop away. While walking, the probe eases
over gentle ground and snaps across anything abrupt: easing everything leaves a
ped hanging a metre off the pavement for about a second after a kerb.

Measured in the streamed city: 18 peds, 17 distinct models, both locomotion sets
in use, every ped within **0.14 m** of the ground and **2.2 m** of a walkable
point.

## The wanted system

`web/wanted.js` keeps the level, `web/police.js` is the response to it. Six
stars, shown top right, dimmed once nothing has eyes on the player.

It follows IV rather than the older games in two ways that shaped the code.
Heat is continuous and stars are a *display* of it, so a second offence while
already wanted escalates smoothly instead of snapping. And a level does not
simply time out: cooling only begins once nothing has seen the player for a
grace period, any sighting resets it, and higher levels resist cooling — six
stars is a different problem from one.

Offences are priced in `CRIMES`; killing an officer costs nearly three times a
civilian, and an unwitnessed crime costs about a third of a witnessed one.
`wanted.response` is the single place difficulty lives — officers, cruisers,
spawn radius, pursuit speed and when the heavier units arrive — and `police.js`
only reads it.

The response uses exactly the units the ambient systems hold back: `traffic.js`
keeps `police`/`police2`/`noose`/`fbi` out of its rotation and `crowd.js` keeps
the cop peds out of its own, so they appear only because of a wanted level.
Officers run the navmesh greedily toward the player and cruisers drive the road
graph the same way — not planned routes, because a chase does not need A* over
910,000 points to read correctly. Officers use the `cop/*` locomotion set from
`move_cop.wad`, falling back to the male generic set for anything those six
clips lack.

Two things the tests caught:

- **In-flight spawns must count against the cap.** Two loads can be in the air
  while the list is still short, and four cruisers turn up for a three-cruiser
  level. Units are also shed — furthest first — when the level falls, so the
  response thins from the edges instead of vanishing from under the player.
- **A ground probe must prefer the surface nearest the unit, not the topmost.**
  The navmesh points carry no height, so a point on a bridge and one on the
  street beneath it are the same point in plan; taking the first ray hit drops
  a ped off the bridge. This is the one place where not decoding the per-tile Z
  base is felt, and it is why `test:crowd` asserts a tight *median* grounding
  error with a looser worst case: a ped crossing between levels can be briefly
  wrong by about a storey, and only a systematic break moves the median.

`G` attacks the nearest pedestrian — the viewer has no weapons, so it stands in
for the offence itself: the ped is removed and the crime reported, witnessed if
anything is close enough to see it. `gta4map.reportCrime()` and
`gta4map.clearWanted()` drive the same paths from the console.

## Driving

`E` gets into the nearest car and out again. `web/driving.js` handles it, with a
chase camera that sits in the car's frame rather than the mouse's, so the view
leads through a corner.

The handling is an arcade model — there is no suspension, no weight transfer and
no tyre model, because GTA IV's real handling lives in RAGE's solver and the
archives carry the tuning, not the solver. But the *constants* are not invented:
mass, drive force, top speed, brake force and steering lock all come from the
catalogue, which read them from the game's own `handling.dat`. So an Infernus
pulls away from a Taxi and a Trashmaster corners like a Trashmaster without
anything in the module knowing which is which. The steering lock also tightens
with speed, which is the cheapest thing that stops a car pivoting on the spot at
100 km/h, and the front wheel bones are steered as well as rolled.

Getting in takes the car **out of traffic and keeps the same object**, so its
paint, its wheels and its position carry straight across rather than being
swapped for a freshly loaded copy — the test asserts the traffic count drops by
exactly one. Getting out puts the player beside the driver's door, using the
model's own `seat_dside_f` bone to decide how far, and hands the car back so it
rejoins the flow instead of standing abandoned.

Running someone down is `ranOverPed`, and it only counts above 12 km/h — a
stationary car resting against somebody is not the same offence.

Two ordering traps worth recording:

- **`setMode('walk')` seeds the player from the camera**, so the exit point has
  to be applied *after* the mode switch or it is immediately overwritten and the
  player steps out wherever the lens happened to be.
- **Speed alone cannot tell braking from reversing.** Pressing back from a
  standstill is a gear change, and an absolute speed reads that as accelerating.
  The state exposes a signed `velocityKmh` for exactly this reason; the first
  version of the test failed on it.

Not done: Niko is hidden while driving rather than seated. The seat bones say
where he should sit, but posing him needs a sitting clip, and those live in the
`amb@car_std_*` family rather than the movement wads the ped library was built
from.

## Weapons and combat

`npm run extract:weapons` pulls three weapons out of
`pc/models/cdimages/weapons.img` — `w_glock`, `w_m4` and `rpg` — and everything
about how they behave out of `common/data/WeaponInfo.xml`. `1`, `2` and `3`
draw them, `0` holsters, click fires, `R` reloads.

Nothing about their behaviour is invented. The file says the pistol does 25
damage from a 17-round magazine every 333 ms out to 50 m; the M4 does 30 from 30
rounds every 120 ms out to 70 m; the launcher is a single-shot `PROJECTILE` with
an `EXPLOSIVE` damage type on an 800 ms cycle. All of that is read straight
across, which is why the M4 both outranges and outshoots the pistol without
anything in the code saying so.

The animations are the game's too. `gun@handgun`, `gun@rifle` and `gun@rocket`
carry the real `fire`, `reload`, `holster` and `unholster` clips, and
`move_rifle`/`move_rpg` are the armed walk cycles — 141 clips, exported against
Niko's own skeleton into `weaponclips.glb` (2.3 MB) so `player.gltf` stays the
size it was. All three gun sets name their clips identically, so they are
namespaced by set exactly as the ped library is; without that every weapon would
play the handgun's animation.

Hits are resolved against ped **positions**, not by raycasting their meshes: a
ped is a skinned mesh whose bounding volume is the bind pose, so mesh
raycasting is both expensive and wrong mid-stride. A capsule round the spine is
what the shot is aimed at anyway. The launcher instead throws the game's own
`cj_rpg_rocket`, which flies until it meets a target, the ground or its 100 m
range and then takes out everything within nine metres.

Two bugs worth recording, both of which looked fine until measured:

- **Damage was keyed on rounded position.** A walking ped therefore got a fresh
  100 health every few centimetres and could not be shot dead. Peds and police
  units now carry a stable id for their lifetime, and health is keyed on that.
- **That health map was a `WeakMap`.** It cannot take string keys — it throws —
  so damage tracking would have failed outright the first time anything was hit.

### Upper-body layering

Shooting while running is two layers, not one clip.

The **base** is full-body locomotion, and when a rifle or launcher is out it is
the game's own armed locomotion — `move_rifle/*` or `move_rpg/*`, which ship
complete idle/walk/run/sprint sets. A pistol keeps the ordinary walk, as it does
in GTA IV. The **layer** on top is the `gun@` clip, restricted to the bones from
`Char_Spine` up and played in `AdditiveAnimationBlendMode`.

Both halves of that are load-bearing:

- **Restricted to the upper body**, or the gun clip's own stance fights the
  stride and the legs stop running.
- **Additive**, because three.js *averages* two normal actions that drive the
  same bone. A full-weight fire clip over a full-weight run does not put one on
  top of the other, it gives a half-hearted blend of both.

The additive delta is computed here rather than with
`AnimationUtils.makeClipAdditive`, which pairs target and reference tracks **by
index** — an assumption that does not survive dropping the lower-body tracks.
The reference is the bind pose, captured at attach time before anything has
animated, so the layer is "weapon pose minus rest" and adding it to any stride
raises the arms into the aim.

Measured, with the base clip held constant so only the layer changes: firing
turns the arms 0.50-1.15 rad and the legs 0.04-0.06 rad, and the residue on the
legs is the base cycle advancing during the sample rather than leakage.
`artifacts/run-and-fire.png` is the same thing to look at: `gta4map.setPaused(true)`
freezes the simulation mid-sprint while rendering carries on, so the camera can
be walked round a held pose — legs in a full stride, rifle shouldered. Getting
that experiment right mattered — comparing armed against unarmed instead also
swaps `move_rifle/run` in for `run`, and the legs then differ by 1.58 rad for
reasons that have nothing to do with the layer.

The one part of the weapon setup NOT taken from the game is where each weapon
sits in the hand: GTA IV keeps attachment transforms in data this project does
not read, so those five numbers per weapon are tuned by eye.

## Walk mode

Walk mode drives Niko and follows him in third person:

- WASD moves in the camera's frame and he turns to face where he is going, so
  the forward locomotion clips cover every direction and no strafe set is needed
- Shift sprints, Alt walks, Space jumps, `V` switches to first person (which
  simply hides him and drops the camera to eye height), `F` toggles fly
- the mouse orbits the character rather than turning the camera in place, and
  the camera pulls in when something is behind him instead of clipping through
- the animation state machine picks `idle`/`walk`/`run`/`sprint` from his actual
  speed and the `jump_takeoff → jump_inair → jump_land` chain from the ground
  probe, crossfading between them
- sector streaming follows the character, not the lens

The one calibration constant is `MODEL_YAW_OFFSET`: which way the bind pose
faces. `getState().player.facing` derives the real facing from the eye joints so
`npm run test:walk` fails if that constant is ever wrong, rather than leaving a
character who runs sideways.

## Third-party code and licensing

The extractor builds against RageLib sources from the
[GTA4Unity project](https://github.com/Infinity-Loops/GTA4Unity), pinned by
`setup.ps1` and CI to a known revision. GTA4Unity/RageLib is licensed under the
GNU General Public License version 3; its checkout stays separate in the ignored
`converter/` directory.

This repository does not yet declare a project-wide license. Until the
copyright holders add one, default copyright rules apply to this repository's
original source. Publishing the repository makes the code visible but does not
by itself grant permission to copy, modify, or redistribute it.

## Checks

```powershell
npm test                        # browser smoke test -> artifacts/*.png
npm run test:player             # character on its own -> artifacts/player-*.png
npm run test:walk               # walk mode in the streamed world
npm run test:vehicles           # fleet sample -> artifacts/vehicle-*.png
npm run test:peds               # population sample -> artifacts/ped-*.png
npm run test:traffic            # road graph + driving, without the city
npm run test:world-traffic      # traffic in the streamed city -> artifacts/world-traffic.png
npm run test:crowd              # the crowd on the navmesh -> artifacts/crowd.png
npm run test:wanted             # stars + police response -> artifacts/wanted.png
npm run test:driving            # taking a car and driving it -> artifacts/driving.png
npm run test:weapons            # the three weapons and combat -> artifacts/weapons.png
node test/probe-white.mjs       # per-pixel material/texture audit of the view
node test/timecyc-shots.mjs     # one frame per keyframe -> artifacts/timecyc/
node test/baked-ab.mjs          # COLOR_0 lighting on/off -> artifacts/baked/
node test/grade-depth.mjs       # asserts the grade's near/far split reads depth

`gta4map.setPaused(true)` stops the simulation without stopping the renderer,
and `gta4map.lookAtPoint(x, y, z, [dx, dy, dz])` puts the camera anywhere while
it is stopped. Between them any moment can be held still and photographed from
any angle, which is the only practical way to catch a pose mid-stride.
```
