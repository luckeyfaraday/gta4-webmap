param([switch]$Force)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$game = Split-Path -Parent $root
$localDotnet = Join-Path $root '.dotnet\dotnet.exe'
$dotnet = if (Test-Path $localDotnet) { $localDotnet } else { 'dotnet' }
$project = Join-Path $root 'extractor\Gta4MapExtractor.csproj'
$extractor = Join-Path $root 'extractor\bin\Release\net8.0\Gta4MapExtractor.dll'
$sectorRoot = Join-Path $root 'web\assets\sectors'
$textureRoot = Join-Path $root 'web\assets\textures'

& $dotnet build $project -c Release --nologo
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

New-Item -ItemType Directory -Force $sectorRoot, $textureRoot | Out-Null
$regions = @('manhat', 'east', 'jersey')
$sectors = foreach ($region in $regions) {
    $mapDir = Join-Path $game "pc\data\maps\$region"
    foreach ($img in Get-ChildItem $mapDir -Filter '*.img') {
        $name = $img.BaseName
        if ((Test-Path (Join-Path $mapDir "$name.ide")) -and (Test-Path (Join-Path $mapDir "$name.wpl"))) {
            [pscustomobject]@{ Region = $region; Name = $name; RelativeDir = "pc/data/maps/$region" }
        }
    }
}

$index = 0
foreach ($sector in $sectors) {
    $index++
    Write-Host "[$index/$($sectors.Count)] Extracting $($sector.Region)/$($sector.Name)"
    $output = Join-Path $sectorRoot $sector.Name
    New-Item -ItemType Directory -Force $output | Out-Null
    if ((-not $Force) -and (Test-Path (Join-Path $output 'map_optimized.glb'))) {
        Write-Host "  Reusing completed sector"
        continue
    }
    & $dotnet $extractor $game $sector.RelativeDir $sector.Name $output $textureRoot '../../textures'
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    Push-Location $root
    try {
        npx --yes '@gltf-transform/cli@4.4.2' optimize `
            "web/assets/sectors/$($sector.Name)/map.gltf" "web/assets/sectors/$($sector.Name)/map_optimized.glb" `
            --compress meshopt --flatten false --join false --instance true `
            --instance-min 2 --palette false --simplify false --texture-compress false
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        Remove-Item -LiteralPath (Join-Path $output 'map.gltf'), (Join-Path $output 'map.bin') -Force
    }
    finally { Pop-Location }
}

$worldSectors = foreach ($sector in $sectors) {
    $manifestPath = Join-Path $sectorRoot "$($sector.Name)\manifest.json"
    if (-not (Test-Path $manifestPath)) { continue }
    $manifest = Get-Content -Raw $manifestPath | ConvertFrom-Json
    [ordered]@{
        id = $sector.Name
        region = $sector.Region
        url = "./assets/sectors/$($sector.Name)/map_optimized.glb"
        placements = $manifest.placements
        models = $manifest.models
        bounds = $manifest.bounds
    }
}

$world = [ordered]@{
    name = 'Liberty City'
    textureBase = './assets/textures/'
    sectors = @($worldSectors)
}
$world | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 (Join-Path $root 'web\assets\world.json')
Write-Host "World ready: $($worldSectors.Count) sectors, $((Get-ChildItem $textureRoot -Filter '*.dds').Count) shared textures"
