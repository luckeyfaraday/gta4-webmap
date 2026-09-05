# Contributing

Thanks for helping improve the project. By participating, you agree to follow
the [Code of Conduct](CODE_OF_CONDUCT.md).

## Before opening a change

- Search existing issues and pull requests first.
- Open an issue before a large feature or architectural change.
- Do not submit game files, extracted assets, generated data, test artifacts,
  credentials, personal data, or material you do not have permission to
  redistribute.
- Keep pull requests focused and explain both what changed and why.

## Development setup

Follow the setup instructions in `README.md`. A legally installed copy of GTA
IV: The Complete Edition is required for extraction and runtime tests, but not
for JavaScript syntax checks or compiling the extractor in CI.

For agent-driven gameplay or rendering work, follow [AGENTS.md](AGENTS.md).
Generated files under `artifacts/`, `web/assets/`, and `web/data/` are local
and must not be committed.

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

## Pull requests

Pull requests must:

- pass CI and the relevant browser/gameplay checks;
- avoid unrelated formatting or generated-file churn;
- document user-visible behavior changes;
- include tests for new behavior where practical; and
- confirm that submitted work may be distributed under the MIT license.

By contributing, you license your contribution under the repository's MIT
license. Third-party assets are excluded as described in
[ASSET_NOTICE.md](ASSET_NOTICE.md).
