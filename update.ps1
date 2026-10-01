param(
  [string]$InstallPath = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $InstallPath

$repo = 'Naeirae/ChatGPT-Conversation-Archiver'
$branch = 'main'
$api = "https://api.github.com/repos/$repo/contents"
$headers = @{ 'User-Agent' = 'ChatGPT-Conversation-Archiver-Updater' }

function Get-RemoteFiles([string]$Path) {
  $url = if ($Path) { $api + '/' + $Path + '?ref=' + $branch } else { $api + '?ref=' + $branch }
  $items = Invoke-RestMethod -Uri $url -Headers $headers -Method Get
  $result = @()
  foreach ($item in @($items)) {
    if ($item.type -eq 'file') { $result += $item }
    elseif ($item.type -eq 'dir') { $result += Get-RemoteFiles $item.path }
  }
  return $result
}

function Get-GitBlobSha([string]$RelativePath) {
  $full = Join-Path $InstallPath ($RelativePath -replace '/', '')
  $bytes = [IO.File]::ReadAllBytes($full)
  $header = [Text.Encoding]::ASCII.GetBytes(('blob ' + $bytes.Length + [char]0))
  $all = New-Object byte[] ($header.Length + $bytes.Length)
  [Buffer]::BlockCopy($header, 0, $all, 0, $header.Length)
  [Buffer]::BlockCopy($bytes, 0, $all, $header.Length, $bytes.Length)
  $sha1 = [Security.Cryptography.SHA1]::Create()
  try { return (($sha1.ComputeHash($all) | ForEach-Object { $_.ToString('x2') }) -join '') }
  finally { $sha1.Dispose() }
}

$localManifest = Join-Path $InstallPath 'manifest.json'
if (-not (Test-Path -LiteralPath $localManifest)) { throw 'manifest.json not found.' }

$localVersion = (Get-Content -Raw -LiteralPath $localManifest | ConvertFrom-Json).version
$files = @(Get-RemoteFiles '')
$remoteManifest = $files | Where-Object { $_.path -eq 'manifest.json' } | Select-Object -First 1
if (-not $remoteManifest) { throw 'Remote manifest.json not found.' }
$remoteManifest = Invoke-RestMethod -Uri $remoteManifest.download_url -Headers $headers -Method Get
$remoteVersion = $remoteManifest.version

if ($localVersion -eq $remoteVersion) {
  Write-Host "Already up to date: $localVersion"
  exit 0
}

Write-Host "Updating $localVersion -> $remoteVersion"

foreach ($item in $files) {
  $relative = $item.path
  $target = Join-Path $InstallPath ($relative -replace '/', '')
  $directory = Split-Path -Parent $target
  if ($directory -and -not (Test-Path -LiteralPath $directory)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
  }

  $isUpdaterFile = $relative -in @('update.ps1', 'update.cmd')

  if ((-not $isUpdaterFile) -and (Test-Path -LiteralPath $target)) {
    $localSha = Get-GitBlobSha $relative
    if ($localSha -ne $item.sha) {
      throw "Local file changed: $relative. Update stopped."
    }
  }

  if ($relative -eq 'update.cmd') {
    $target = $target + '.new'
  }

  $temporary = "$target.download"
  Invoke-WebRequest -Uri $item.download_url -Headers $headers -OutFile $temporary -UseBasicParsing
  Move-Item -LiteralPath $temporary -Destination $target -Force
  Write-Host "Updated $relative"
}

Write-Host "Update complete: $remoteVersion"
Write-Host 'Reload the extension at chrome://extensions.'
