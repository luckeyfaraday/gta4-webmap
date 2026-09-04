# Contributing

Thanks for helping improve the project. Before starting a substantial change,
open an issue describing the problem and proposed approach so work does not get
duplicated.

## Development setup

Follow the setup instructions in `README.md`. A legally installed copy of GTA
IV: The Complete Edition is required for extraction and runtime tests, but not
for JavaScript syntax checks or compiling the extractor in CI.

Keep changes focused and include an explanation of the behavior being changed.
Do not commit game files, extracted assets, generated data, test artifacts,
credentials, logs, or machine-specific configuration.

## Checks

Run the checks relevant to your change before opening a pull request:

```powershell
npm ci
npm run check
dotnet build extractor/Gta4MapExtractor.csproj --configuration Release --nologo
```

Changes to rendering or gameplay should also run the applicable browser checks
listed in `README.md`. Include concise reproduction and verification notes in
the pull request.
