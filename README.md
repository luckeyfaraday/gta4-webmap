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
npm run extract:world   # all 34 outdoor sectors + web/assets/world.json + texture bundles
npm run extract         # single proof sector (manhat01) only
npm run pack            # texture bundles only (--max-edge 256, --sector <id>, --force)
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

## Checks

```powershell
npm test                        # browser smoke test -> artifacts/*.png
node test/probe-white.mjs       # per-pixel material/texture audit of the view
```
