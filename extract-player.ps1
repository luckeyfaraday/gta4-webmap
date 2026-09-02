$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$game = Split-Path -Parent $root
$localDotnet = Join-Path $root '.dotnet\dotnet.exe'
$dotnet = if (Test-Path $localDotnet) { $localDotnet } else { 'dotnet' }
$project = Join-Path $root 'extractor\Gta4MapExtractor.csproj'
$extractor = Join-Path $root 'extractor\bin\Release\net8.0\Gta4MapExtractor.dll'
$playerRoot = Join-Path $root 'web\assets\player'
$textureRoot = Join-Path $root 'web\assets\textures'

& $dotnet build $project -c Release --nologo
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

New-Item -ItemType Directory -Force $playerRoot, $textureRoot | Out-Null

# The character is small enough (~2.7 MB) that it skips the gltf-transform pass
# the sectors go through: quantising a 90-bone skin and 62 clips costs more
# accuracy than the download saves.
& $dotnet $extractor --extract-player $game $playerRoot $textureRoot '../textures'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "Player written to $playerRoot"
