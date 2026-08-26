param(
  [Parameter(Mandatory = $true)]
  [string]$Version,
  [string]$Repository = $env:AXON_DEB_RELEASE_REPOSITORY
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Repository)) {
  throw 'Set AXON_DEB_RELEASE_REPOSITORY (for example, owner/Axon-Debian) or pass -Repository before publishing.'
}

$root = Split-Path -Parent $PSScriptRoot
$package = Join-Path $root "dist\Axon_${Version}_amd64.deb"
$checksum = "$package.sha256"
if (-not (Test-Path -LiteralPath $package)) {
  throw "Build Axon_${Version}_amd64.deb first with npm run dist:deb."
}

$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
  $stream = [System.IO.File]::OpenRead($package)
  try { $hash = ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose() }
} finally { $sha256.Dispose() }
[System.IO.File]::WriteAllText($checksum, "$hash  Axon_$Version`_amd64.deb`n", [System.Text.UTF8Encoding]::new($false))
gh release create "v$Version" $package $checksum --repo $Repository --title "Axon $Version for Debian" --notes "Debian package for Axon $Version. Verify the attached SHA-256 checksum before installation."
