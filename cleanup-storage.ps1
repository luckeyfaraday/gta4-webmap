$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$targets = @(
    [IO.Path]::GetFullPath((Join-Path $root '.dotnet')),
    [IO.Path]::GetFullPath((Join-Path $root 'web\assets\manhat01'))
)

foreach ($target in $targets) {
    if (-not $target.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing unsafe cleanup target: $target"
    }
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
}

$textureRoot = [IO.Path]::GetFullPath((Join-Path $root 'web\assets\textures'))
$groups = Get-ChildItem -LiteralPath $textureRoot -File -Filter '*.dds' |
    ForEach-Object { [pscustomobject]@{ File = $_; Hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash } } |
    Group-Object Hash | Where-Object Count -gt 1
$linked = 0
foreach ($group in $groups) {
    $canonical = $group.Group[0].File.FullName
    foreach ($entry in $group.Group | Select-Object -Skip 1) {
        $duplicate = $entry.File.FullName
        if (-not $duplicate.StartsWith($textureRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing unsafe hard-link target: $duplicate"
        }
        Remove-Item -LiteralPath $duplicate -Force
        New-Item -ItemType HardLink -Path $duplicate -Target $canonical | Out-Null
        $linked++
    }
}
Write-Host "Removed redundant local SDK/legacy assets and hard-linked $linked duplicate generated textures."
