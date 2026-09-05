# Agent development guide

This project is a local Three.js viewer and extraction pipeline for a legally
installed copy of GTA IV: The Complete Edition. Agents must not commit game
files, extracted assets, or generated test evidence. Runtime and visual
changes need browser checks; source inspection alone is not enough.

## Layout

The repository must sit inside the game installation. Extractors treat the
parent directory as the game root:

```text
Grand Theft Auto IV - The Complete Edition/
├── GTAIV.exe
├── pc/
└── _webmap/       # this repository
```

Generated Rockstar-derived data is gitignored:

- `web/assets/` — extracted geometry and textures
- `web/data/` — timecycle, road graph, navmesh
- `artifacts/` — browser-check screenshots and JSON
- `converter/` — pinned GTA4Unity/RageLib checkout (GPL-3.0)
- `extractor/bin/`, `extractor/obj/`, `node_modules/`

## Standard workflow

1. From the repository directory, run `./setup.ps1` if `node_modules/` or
   `converter/` are missing.
2. Make the smallest relevant code change.
3. Run `npm run check` and, for extractor changes,
   `dotnet build extractor/Gta4MapExtractor.csproj --configuration Release --nologo`.
4. For extraction or viewer work, rebuild only the affected assets
   (`npm run extract:world`, `extract:player`, `extract:vehicles`,
   `extract:peds`, `extract:weapons`, `extract:paths`, `extract:navmesh`,
   `extract:timecyc`, `extract:sky`, or `npm run pack`).
5. Run the matching browser check from `README.md` (`npm test`,
   `npm run test:walk`, and so on). Inspect `artifacts/` for screenshots and
   JSON. Do not commit those files.

The viewer is served at <http://127.0.0.1:4174> with `npm run serve`.

## Runtime automation

Wait until `globalThis.gta4map` is ready. Prefer its documented helpers over
reaching into Three.js internals:

- `gta4map.setPaused(true)` freezes simulation while rendering continues
- `gta4map.lookAtPoint(x, y, z, [dx, dy, dz])` places the camera
- `gta4map.reportCrime()` and `gta4map.clearWanted()` drive the wanted path
- `gta4map.getState()` / player facing fields are what `npm run test:walk`
  asserts against

Treat browser console errors, page errors, and failed asset requests as
failures. Generated artifacts are local evidence and must not be committed.
