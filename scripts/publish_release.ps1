param(
  [Parameter(Mandatory = $true)]
  [string]$Version,
  [string]$Repository = $env:NOCLI_RELEASE_REPOSITORY
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Repository)) {
  throw 'Set NOCLI_RELEASE_REPOSITORY (for example, owner/nocli.ai-releases) or pass -Repository before publishing.'
}
$repo = $Repository
$root = Split-Path -Parent $PSScriptRoot
$installer = Join-Path $root "dist\Calcium-Setup-$Version.exe"
$checksum = "$installer.sha256"

if (-not (Test-Path -LiteralPath $installer)) {
  throw "Build Calcium-Setup-$Version.exe first with npm run dist:win."
}

$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
  $stream = [System.IO.File]::OpenRead($installer)
  try { $hash = ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose() }
} finally { $sha256.Dispose() }
[System.IO.File]::WriteAllText($checksum, "$hash  Calcium-Setup-$Version.exe`n", [System.Text.UTF8Encoding]::new($false))
gh release create "v$Version" $installer $checksum --repo $repo --title "Calcium $Version" --notes "Windows installer for Calcium $Version. Verify the attached SHA-256 checksum before installation."
