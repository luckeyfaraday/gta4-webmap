param([switch]$Force, [int]$MaxEdge = 256, [string[]]$Ped)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$game = Split-Path -Parent $root
$localDotnet = Join-Path $root '.dotnet\dotnet.exe'
$dotnet = if (Test-Path $localDotnet) { $localDotnet } else { 'dotnet' }
$project = Join-Path $root 'extractor\Gta4MapExtractor.csproj'
$extractor = Join-Path $root 'extractor\bin\Release\net8.0\Gta4MapExtractor.dll'
$pedRoot = Join-Path $root 'web\assets\peds'
$textureRoot = Join-Path $pedRoot 'textures'

& $dotnet build $project -c Release --nologo
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

New-Item -ItemType Directory -Force $pedRoot, $textureRoot | Out-Null

# Ped textures get their own directory rather than joining the shared cache the
# map, Niko and the vehicles share. Two reasons: they are trimmed to MaxEdge and
# must never be mistaken for full-resolution files, and their names are not
# unique — every ped's own .wtd calls its shirt "uppr_diff_000_a_uni" and those
# are different images. The exporter namespaces each file by ped for that reason.
& $dotnet $extractor --extract-peds $game $pedRoot $textureRoot 'textures/' $MaxEdge @Ped
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# The same meshopt pass the sectors and vehicles go through. --flatten and
# --join stay off: the bone hierarchy is what the shared clip library drives.
$manifest = Get-Content -Raw (Join-Path $pedRoot 'peds.json') | ConvertFrom-Json
$targets = @('animations') + ($manifest.peds | ForEach-Object { $_.ped })
$index = 0
Push-Location $root
try {
    foreach ($name in $targets) {
        $index++
        $source = Join-Path $pedRoot "$name.gltf"
        $target = Join-Path $pedRoot "$name.glb"
        if (-not (Test-Path $source)) { continue }
        if ((-not $Force) -and (Test-Path $target) -and ((Get-Item $target).LastWriteTime -gt (Get-Item $source).LastWriteTime)) {
            continue
        }
        Write-Host "[$index/$($targets.Count)] Compressing $name"
        npx --yes '@gltf-transform/cli@4.4.2' optimize `
            "web/assets/peds/$name.gltf" "web/assets/peds/$name.glb" `
            --compress meshopt --flatten false --join false --instance false `
            --palette false --simplify false --texture-compress false
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        Remove-Item -LiteralPath $source, (Join-Path $pedRoot "$name.bin") -Force
    }
}
finally { Pop-Location }

# Point the catalogue at the compressed files the viewer will actually fetch.
foreach ($ped in $manifest.peds) { $ped.gltf = "$($ped.ped).glb" }
$manifest.animations = 'animations.glb'
[System.IO.File]::WriteAllText((Join-Path $pedRoot 'peds.json'), ($manifest | ConvertTo-Json -Depth 12))

$models = (Get-ChildItem $pedRoot -Filter '*.glb' | Measure-Object -Property Length -Sum).Sum
$textures = (Get-ChildItem $textureRoot -Filter '*.dds' | Measure-Object -Property Length -Sum).Sum
Write-Host ("Peds ready: {0} models, {1} MB geometry + {2} MB textures (max edge {3})" -f `
    $manifest.count, [math]::Round($models / 1MB, 1), [math]::Round($textures / 1MB, 1), $MaxEdge)
