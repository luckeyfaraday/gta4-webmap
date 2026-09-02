$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$game = Split-Path -Parent $root
$localDotnet = Join-Path $root '.dotnet\dotnet.exe'
$dotnet = if (Test-Path $localDotnet) { $localDotnet } else { 'dotnet' }
$project = Join-Path $root 'extractor\Gta4MapExtractor.csproj'
$output = Join-Path $root 'web\assets\manhat01'

& $dotnet build $project -c Release --nologo
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& $dotnet (Join-Path $root 'extractor\bin\Release\net8.0\Gta4MapExtractor.dll') $game 'pc/data/maps/manhat' 'manhat01' $output
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Push-Location $root
try {
    npx --yes '@gltf-transform/cli@4.4.2' optimize `
        'web/assets/manhat01/map.gltf' 'web/assets/manhat01/map_optimized.glb' `
        --compress meshopt --flatten false --join false --instance true `
        --instance-min 2 --palette false --simplify false --texture-compress false
}
finally { Pop-Location }
