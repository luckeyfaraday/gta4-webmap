param([switch]$Force, [string[]]$Model)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$game = Split-Path -Parent $root
$localDotnet = Join-Path $root '.dotnet\dotnet.exe'
$dotnet = if (Test-Path $localDotnet) { $localDotnet } else { 'dotnet' }
$project = Join-Path $root 'extractor\Gta4MapExtractor.csproj'
$extractor = Join-Path $root 'extractor\bin\Release\net8.0\Gta4MapExtractor.dll'
$vehicleRoot = Join-Path $root 'web\assets\vehicles'
$textureRoot = Join-Path $root 'web\assets\textures'

& $dotnet build $project -c Release --nologo
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

New-Item -ItemType Directory -Force $vehicleRoot, $textureRoot | Out-Null

& $dotnet $extractor --extract-vehicles $game $vehicleRoot $textureRoot '../textures' @Model
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# Same meshopt pass the sectors go through, and for the same reason: the raw
# glTF pair is ~780 KB per car, which is 99 MB across the full set. The player
# export skips this because quantising a 90-bone skin and 62 clips costs more
# accuracy than it saves; a car has no clips and one bone per vertex, so it
# compresses about 5.5x with nothing visible lost.
#
# --flatten and --join stay off deliberately. Both would collapse the node
# hierarchy, and that hierarchy is the point: the wheel and door bones are what
# the viewer rotates.
$manifest = Get-Content -Raw (Join-Path $vehicleRoot 'vehicles.json') | ConvertFrom-Json
$index = 0
Push-Location $root
try {
    foreach ($vehicle in $manifest.vehicles) {
        $index++
        $source = Join-Path $vehicleRoot "$($vehicle.model).gltf"
        $target = Join-Path $vehicleRoot "$($vehicle.model).glb"
        if (-not (Test-Path $source)) { continue }
        if ((-not $Force) -and (Test-Path $target) -and ((Get-Item $target).LastWriteTime -gt (Get-Item $source).LastWriteTime)) {
            continue
        }
        Write-Host "[$index/$($manifest.vehicles.Count)] Compressing $($vehicle.model)"
        npx --yes '@gltf-transform/cli@4.4.2' optimize `
            "web/assets/vehicles/$($vehicle.model).gltf" "web/assets/vehicles/$($vehicle.model).glb" `
            --compress meshopt --flatten false --join false --instance false `
            --palette false --simplify false --texture-compress false
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        Remove-Item -LiteralPath $source, (Join-Path $vehicleRoot "$($vehicle.model).bin") -Force
    }
}
finally { Pop-Location }

# Point the catalogue at the compressed files the viewer will actually fetch.
foreach ($vehicle in $manifest.vehicles) { $vehicle.gltf = "$($vehicle.model).glb" }
$manifest | ConvertTo-Json -Depth 12 | Set-Content -Encoding utf8 (Join-Path $vehicleRoot 'vehicles.json')

$bytes = (Get-ChildItem $vehicleRoot -Filter '*.glb' | Measure-Object -Property Length -Sum).Sum
Write-Host "Vehicles ready: $($manifest.count) models, $([math]::Round($bytes / 1MB, 1)) MB"
