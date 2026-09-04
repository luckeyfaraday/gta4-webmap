param([switch]$SkipDotnet)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$game = [IO.Path]::GetFullPath((Split-Path -Parent $root))
$converter = Join-Path $root 'converter'
$converterRevision = 'c107e46cf8ab4e3d42f9c0bf685f80bb732a3609'

if (-not (Test-Path -LiteralPath (Join-Path $game 'GTAIV.exe')) -or
    -not (Test-Path -LiteralPath (Join-Path $game 'pc'))) {
    throw "Place this repository directly inside a GTA IV Complete Edition installation. Game directory checked: $game"
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'Git is required to fetch the pinned GTA4Unity/RageLib dependency.'
}
if (-not (Get-Command node -ErrorAction SilentlyContinue) -or
    -not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw 'Node.js 22 or newer, including npm, is required.'
}
$nodeMajor = [int]((& node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 22) {
    throw "Node.js 22 or newer is required; found $(& node --version)."
}

if (-not (Test-Path -LiteralPath (Join-Path $converter '.git'))) {
    if (Test-Path -LiteralPath $converter) {
        throw "The converter path exists but is not a Git checkout: $converter"
    }
    & git clone 'https://github.com/Infinity-Loops/GTA4Unity.git' $converter
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
elseif (& git -C $converter status --porcelain) {
    throw "The GTA4Unity dependency has local changes. Clean them before setup continues: $converter"
}

& git -C $converter fetch origin $converterRevision --depth 1
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& git -C $converter checkout --detach $converterRevision
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Push-Location $root
try {
    & npm ci
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    if (-not $SkipDotnet -and -not (Get-Command dotnet -ErrorAction SilentlyContinue) -and
        -not (Test-Path -LiteralPath (Join-Path $root '.dotnet\dotnet.exe'))) {
        & (Join-Path $root 'install-dotnet.ps1')
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
}
finally {
    Pop-Location
}

Write-Host 'Dependencies are ready. Run npm run extract:world to build the local assets.'
