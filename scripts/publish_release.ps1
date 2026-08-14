param(
  [Parameter(Mandatory = $true)]
  [string]$Version,
  [string]$Repository = $env:AXON_RELEASE_REPOSITORY
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Repository)) {
  throw 'Set AXON_RELEASE_REPOSITORY (for example, owner/Axon-Releases) or pass -Repository before publishing.'
}
$repo = $Repository
$root = Split-Path -Parent $PSScriptRoot
$installer = Join-Path $root "dist\Axon-Setup-$Version.exe"
$checksum = "$installer.sha256"

if (-not (Test-Path -LiteralPath $installer)) {
  throw "Build Axon-Setup-$Version.exe first with npm run dist:win."
}

$hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
[System.IO.File]::WriteAllText($checksum, "$hash  Axon-Setup-$Version.exe`n", [System.Text.UTF8Encoding]::new($false))
gh release create "v$Version" $installer $checksum --repo $repo --title "Axon $Version" --notes "Windows installer for Axon $Version. Verify the attached SHA-256 checksum before installation."
