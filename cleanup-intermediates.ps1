$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$sectorRoot = [IO.Path]::GetFullPath((Join-Path $root 'web\assets\sectors'))
$prefix = $sectorRoot + [IO.Path]::DirectorySeparatorChar
$targets = Get-ChildItem -LiteralPath $sectorRoot -Recurse -File |
    Where-Object { $_.Name -eq 'map.gltf' -or $_.Name -eq 'map.bin' }

foreach ($target in $targets) {
    $resolved = [IO.Path]::GetFullPath($target.FullName)
    if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing unsafe cleanup target: $resolved"
    }
}

$bytes = ($targets | Measure-Object Length -Sum).Sum
foreach ($target in $targets) { Remove-Item -LiteralPath $target.FullName -Force }
Write-Host "Removed $($targets.Count) generated intermediates ($([math]::Round($bytes / 1MB)) MB) from $sectorRoot"
