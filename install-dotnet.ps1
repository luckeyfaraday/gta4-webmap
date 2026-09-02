$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$installer = Join-Path $root 'dotnet-install.ps1'
$sdkDir = Join-Path $root '.dotnet'

if (-not (Test-Path -LiteralPath $installer)) {
    Invoke-WebRequest 'https://dot.net/v1/dotnet-install.ps1' -OutFile $installer
}

& $installer -Channel '8.0' -InstallDir $sdkDir -NoPath
