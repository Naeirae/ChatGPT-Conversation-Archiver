param(
  [string]$InstallPath = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Write-Host '[0/3] Updater started.'
[Console]::Out.Flush()
Set-Location -LiteralPath $InstallPath

$repo = 'Naeirae/ChatGPT-Conversation-Archiver'
$branch = 'main'
$apiBase = "https://api.github.com/repos/$repo"
$headers = @{
  'User-Agent' = 'ChatGPT-Conversation-Archiver-Updater'
  'Accept' = 'application/vnd.github+json'
  'X-GitHub-Api-Version' = '2026-03-10'
}
$timeout = 20

function Get-GitBlobSha([string]$RelativePath) {
  $full = Join-Path $InstallPath ($RelativePath -replace '/', '\')
  $bytes = [IO.File]::ReadAllBytes($full)
  $header = [Text.Encoding]::ASCII.GetBytes(('blob ' + $bytes.Length + [char]0))
  $all = New-Object byte[] ($header.Length + $bytes.Length)
  [Buffer]::BlockCopy($header, 0, $all, 0, $header.Length)
  [Buffer]::BlockCopy($bytes, 0, $all, $header.Length, $bytes.Length)
  $sha1 = [Security.Cryptography.SHA1]::Create()
  try { return (($sha1.ComputeHash($all) | ForEach-Object { $_.ToString('x2') }) -join '') }
  finally { $sha1.Dispose() }
}

function Get-RemoteTree {
  $url = "$apiBase/git/trees/$branch?recursive=1"
  Write-Host '[1/3] Checking GitHub...'
  [Console]::Out.Flush()
  try {
    return Invoke-RestMethod -Uri $url -Headers $headers -Method Get -TimeoutSec $timeout
  } catch {
    throw "Could not reach GitHub API. $_"
  }
}

function Download-RemoteFile([string]$RelativePath, [string]$Target) {
  $encoded = ($RelativePath -split '/' | ForEach-Object { [Uri]::EscapeDataString($_) }) -join '/'
  $url = $apiBase + '/contents/' + $encoded + '?ref=' + $branch
  $downloadHeaders = @{
    'User-Agent' = 'ChatGPT-Conversation-Archiver-Updater'
    'Accept' = 'application/vnd.github.raw+json'
    'X-GitHub-Api-Version' = '2026-03-10'
  }
  $temporary = "$Target.download"
  try {
    Invoke-WebRequest -Uri $url -Headers $downloadHeaders -OutFile $temporary -UseBasicParsing -TimeoutSec $timeout -MaximumRedirection 5
    Move-Item -LiteralPath $temporary -Destination $Target -Force
  } catch {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
    throw "Could not download $RelativePath. $_"
  }
}

$localManifest = Join-Path $InstallPath 'manifest.json'
if (-not (Test-Path -LiteralPath $localManifest)) {
  throw 'manifest.json not found. Select the folder containing the unpacked extension.'
}

try {
  $localManifestData = Get-Content -Raw -LiteralPath $localManifest | ConvertFrom-Json
  $localVersion = [string]$localManifestData.version
} catch {
  throw 'Could not read local manifest.json.'
}

$tree = Get-RemoteTree
if ($tree.truncated) { throw 'GitHub returned a truncated repository tree.' }
$remoteFiles = @($tree.tree | Where-Object { $_.type -eq 'blob' })

$remoteManifest = $remoteFiles | Where-Object { $_.path -eq 'manifest.json' } | Select-Object -First 1
if (-not $remoteManifest) { throw 'Remote manifest.json not found.' }

$remoteManifestPath = Join-Path $InstallPath 'manifest.remote.json'
try {
  Download-RemoteFile 'manifest.json' $remoteManifestPath
  $remoteManifestData = Get-Content -Raw -LiteralPath $remoteManifestPath | ConvertFrom-Json
  $remoteVersion = [string]$remoteManifestData.version
} finally {
  if (Test-Path -LiteralPath $remoteManifestPath) { Remove-Item -LiteralPath $remoteManifestPath -Force -ErrorAction SilentlyContinue }
}

$changed = @()
$protected = @('update.ps1', 'update.cmd')
foreach ($item in $remoteFiles) {
  $relative = [string]$item.path
  $target = Join-Path $InstallPath ($relative -replace '/', '\')
  if (-not (Test-Path -LiteralPath $target)) {
    $changed += [pscustomobject]@{ Path = $relative; Sha = $item.sha; Reason = 'missing' }
    continue
  }

  if ($protected -contains $relative) {
    if ((Get-GitBlobSha $relative) -ne $item.sha) {
      $changed += [pscustomobject]@{ Path = $relative; Sha = $item.sha; Reason = 'updater' }
    }
    continue
  }

  $localSha = Get-GitBlobSha $relative
  if ($localSha -ne $item.sha) {
    $changed += [pscustomobject]@{ Path = $relative; Sha = $item.sha; Reason = 'changed' }
  }
}

if ($changed.Count -eq 0) {
  Write-Host "[2/3] Already up to date: $localVersion"
  Write-Host '[3/3] No files to update.'
  exit 0
}

Write-Host "[2/3] Updating $localVersion -> $remoteVersion"
[Console]::Out.Flush()
Write-Host ("Files to update: " + $changed.Count)

foreach ($item in $changed) {
  $target = Join-Path $InstallPath ($item.Path -replace '/', '\')
  $directory = Split-Path -Parent $target
  if ($directory -and -not (Test-Path -LiteralPath $directory)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
  }

  if ($protected -contains $item.Path) {
    $target = $target + '.new'
    Download-RemoteFile $item.Path $target
    Write-Host ("  Staged updater: " + $item.Path)
  } else {
    Download-RemoteFile $item.Path $target
    Write-Host ("  Updated: " + $item.Path)
  }
}

Write-Host "[3/3] Update complete: $remoteVersion"
[Console]::Out.Flush()
Write-Host 'Reload the extension at chrome://extensions.'
