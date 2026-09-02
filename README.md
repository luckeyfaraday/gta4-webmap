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
npm run extract:player  # Niko + his animation clips -> web/assets/player/
```

The extractor reads each sector's `.img`, its base/streaming WPL placements,
WDR/WDD models, and WTD texture dictionaries. It writes an instanced,
Meshopt-compressed glTF scene per sector plus a deduplicated cache of the
original DDS texture mip chains shared across every sector.

Texture lookup is engine-faithful: GTA IV's `pgDictionary` hash table is keyed on
the bare leaf name with no extension (`road4cobble`), not on the stored
`pack:/road4cobble.dds` spelling. Verified against all 50,663 texture entries
under `pc/`.

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

Two things the viewer has to know about the exported clips:

- **They run in place.** The `mover` track on bone 0 is a ±0.1 m body sway, not
  root motion — GTA IV drives travel from move-blend data the archives do not
  carry. Locomotion speed has to be a tuning constant, not extracted.
- **They disagree on facing.** `idle` opens at a root yaw of 0 while every
  locomotion clip opens at ~1.477 rad. Each clip's opening yaw is reported as
  `rootYaw` in `manifest.json` so a crossfade can cancel the difference instead
  of snapping.

The map is exported through `(-x, z, -y)`, which is a reflection, so the world
is mirrored; the character uses the proper `(x, z, -y)` conversion and is
mirrored back to match with a single `scale.x = -1`.

## Checks

```powershell
npm test                        # browser smoke test -> artifacts/*.png
npm run test:player             # character checks -> artifacts/player-*.png
node test/probe-white.mjs       # per-pixel material/texture audit of the view
```
