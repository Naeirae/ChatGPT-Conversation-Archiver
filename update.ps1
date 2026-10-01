param(
  [string]$InstallPath = $PSScriptRoot
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Step([string]$Message) {
  Write-Host $Message
  [Console]::Out.Flush()
}

function Get-GitBlobSha([string]$RelativePath) {
  $full = Join-Path $InstallPath ($RelativePath -replace '/', '\')
  $bytes = [IO.File]::ReadAllBytes($full)
  $header = [Text.Encoding]::ASCII.GetBytes(('blob ' + $bytes.Length + [char]0))
  $all = New-Object byte[] ($header.Length + $bytes.Length)
  [Buffer]::BlockCopy($header, 0, $all, 0, $header.Length)
  [Buffer]::BlockCopy($bytes, 0, $all, $header.Length, $bytes.Length)
  $sha1 = [Security.Cryptography.SHA1]::Create()
  try {
    return (($sha1.ComputeHash($all) | ForEach-Object { $_.ToString('x2') }) -join '')
  } finally {
    $sha1.Dispose()
  }
}

function Get-StateSha($State, [string]$RelativePath) {
  if (-not $State -or -not $State.files) { return $null }
  $property = $State.files.PSObject.Properties[$RelativePath]
  if (-not $property) { return $null }
  return [string]$property.Value
}

function Download-RemoteFile([string]$RelativePath, [string]$Target) {
  $encoded = ($RelativePath -split '/' | ForEach-Object { [Uri]::EscapeDataString($_) }) -join '/'
  $url = $script:apiBase + '/contents/' + $encoded + '?ref=' + $script:branch
  $temporary = "$Target.download"
  try {
    Invoke-WebRequest -Uri $url -Headers $script:downloadHeaders -OutFile $temporary -UseBasicParsing -TimeoutSec $script:timeout -MaximumRedirection 5
    Move-Item -LiteralPath $temporary -Destination $Target -Force
  } catch {
    if (Test-Path -LiteralPath $temporary) {
      Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
    throw "Could not download $RelativePath. $($_.Exception.Message)"
  }
}

function Save-UpdaterState($RemoteFiles, [string]$RemoteVersion, [string]$StatePath) {
  $files = [ordered]@{}
  foreach ($item in $RemoteFiles) {
    if ([string]$item.path -eq 'update.cmd') { continue }
    $files[[string]$item.path] = [string]$item.sha
  }

  $state = [ordered]@{
    schemaVersion = 1
    repository = $script:repo
    branch = $script:branch
    remoteVersion = $RemoteVersion
    updatedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    files = $files
  }

  $json = $state | ConvertTo-Json -Depth 5
  Set-Content -LiteralPath $StatePath -Value $json -Encoding UTF8
}

try {
  Write-Step '[0/4] Updater started.'

  if (-not $InstallPath) {
    throw 'Install path is empty.'
  }

  $InstallPath = [IO.Path]::GetFullPath($InstallPath)
  Set-Location -LiteralPath $InstallPath

  foreach ($stale in @('update.ps1.new', 'update.cmd.new')) {
    $stalePath = Join-Path $InstallPath $stale
    if (Test-Path -LiteralPath $stalePath) {
      Remove-Item -LiteralPath $stalePath -Force -ErrorAction SilentlyContinue
    }
  }

  $script:repo = 'Naeirae/ChatGPT-Conversation-Archiver'
  $script:branch = 'main'
  $script:apiBase = "https://api.github.com/repos/$script:repo"
  $script:headers = @{
    'User-Agent' = 'ChatGPT-Conversation-Archiver-Updater'
    'Accept' = 'application/vnd.github+json'
    'X-GitHub-Api-Version' = '2022-11-28'
  }
  $script:downloadHeaders = @{
    'User-Agent' = 'ChatGPT-Conversation-Archiver-Updater'
    'Accept' = 'application/vnd.github.raw+json'
    'X-GitHub-Api-Version' = '2022-11-28'
  }
  $script:timeout = 20

  $localManifest = Join-Path $InstallPath 'manifest.json'
  if (-not (Test-Path -LiteralPath $localManifest)) {
    throw 'manifest.json not found. Run update.cmd from the unpacked extension folder.'
  }

  try {
    $localManifestData = Get-Content -Raw -LiteralPath $localManifest | ConvertFrom-Json
    $localVersion = [string]$localManifestData.version
  } catch {
    throw 'Could not read local manifest.json.'
  }

  Write-Step '[1/4] Checking GitHub...'
  $treeUrl = "$script:apiBase/git/trees/$script:branch?recursive=1"
  try {
    $tree = Invoke-RestMethod -Uri $treeUrl -Headers $script:headers -Method Get -TimeoutSec $script:timeout
  } catch {
    throw "Could not reach GitHub API. $($_.Exception.Message)"
  }

  if ($tree.truncated) {
    throw 'GitHub returned a truncated repository tree.'
  }

  $remoteFiles = @($tree.tree | Where-Object { $_.type -eq 'blob' })
  $remoteManifest = $remoteFiles | Where-Object { $_.path -eq 'manifest.json' } | Select-Object -First 1
  if (-not $remoteManifest) {
    throw 'Remote manifest.json not found.'
  }

  $remoteManifestPath = Join-Path $env:TEMP 'ChatGPT-Conversation-Archiver-manifest.json'
  try {
    Download-RemoteFile 'manifest.json' $remoteManifestPath
    $remoteManifestData = Get-Content -Raw -LiteralPath $remoteManifestPath | ConvertFrom-Json
    $remoteVersion = [string]$remoteManifestData.version
  } finally {
    if (Test-Path -LiteralPath $remoteManifestPath) {
      Remove-Item -LiteralPath $remoteManifestPath -Force -ErrorAction SilentlyContinue
    }
  }

  $statePath = Join-Path $InstallPath '.chatgpt-archiver-updater-state.json'
  $state = $null
  if (Test-Path -LiteralPath $statePath) {
    try {
      $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
    } catch {
      throw 'Updater state file is damaged. Remove .chatgpt-archiver-updater-state.json and run again.'
    }
  }

  $changed = @()
  $conflicts = @()
  foreach ($item in $remoteFiles) {
    $relative = [string]$item.path

    # update.cmd is the stable bootstrap. It must never replace itself while running.
    if ($relative -eq 'update.cmd') {
      continue
    }

    $target = Join-Path $InstallPath ($relative -replace '/', '\')
    if (-not (Test-Path -LiteralPath $target)) {
      $changed += [pscustomobject]@{
        Path = $relative
        Sha = [string]$item.sha
        Reason = 'missing'
        Exists = $false
      }
      continue
    }

    $localSha = Get-GitBlobSha $relative
    if ($localSha -eq [string]$item.sha) {
      continue
    }

    if ($relative -eq 'update.ps1') {
      $changed += [pscustomobject]@{
        Path = $relative
        Sha = [string]$item.sha
        Reason = 'updater'
        Exists = $true
      }
      continue
    }

    if ($state) {
      $baselineSha = Get-StateSha $state $relative
      if (-not $baselineSha -or $localSha -ne $baselineSha) {
        $conflicts += [pscustomobject]@{
          Path = $relative
          LocalSha = $localSha
          BaselineSha = $baselineSha
          RemoteSha = [string]$item.sha
        }
        continue
      }
    }

    $changed += [pscustomobject]@{
      Path = $relative
      Sha = [string]$item.sha
      Reason = $(if ($state) { 'remote' } else { 'first-run' })
      Exists = $true
    }
  }

  if ($conflicts.Count -gt 0) {
    Write-Step '[2/4] Local changes detected. Update stopped before writing files.'
    foreach ($item in $conflicts) {
      Write-Host ('  Local change: ' + $item.Path)
    }
    Write-Host 'Keep the local files, restore them, or remove the updater state only if you intentionally want a new baseline.'
    throw 'Local changes would be overwritten.'
  }

  if ($changed.Count -eq 0) {
    Write-Step "[2/4] Already up to date: $localVersion"
    Save-UpdaterState $remoteFiles $remoteVersion $statePath
    Write-Step '[3/4] State refreshed.'
    Write-Step '[4/4] No files to update.'
    return
  }

  Write-Step "[2/4] Updating $localVersion -> $remoteVersion"
  Write-Host ('Files to update: ' + $changed.Count)

  $backupRoot = $null
  if (-not $state -and @($changed | Where-Object { $_.Exists -and $_.Path -ne 'update.ps1' }).Count -gt 0) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backupRoot = Join-Path $InstallPath ('.archiver-update-backup\' + $stamp)
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    Write-Host ('First safe update: replacing files will be backed up under ' + $backupRoot)
  }

  foreach ($item in $changed) {
    $target = Join-Path $InstallPath ($item.Path -replace '/', '\')
    $directory = Split-Path -Parent $target
    if ($directory -and -not (Test-Path -LiteralPath $directory)) {
      New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }

    if ($backupRoot -and $item.Exists -and $item.Path -ne 'update.ps1') {
      $backupTarget = Join-Path $backupRoot ($item.Path -replace '/', '\')
      $backupDirectory = Split-Path -Parent $backupTarget
      if ($backupDirectory -and -not (Test-Path -LiteralPath $backupDirectory)) {
        New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
      }
      Copy-Item -LiteralPath $target -Destination $backupTarget -Force
      Write-Host ('  Backed up: ' + $item.Path)
    }

    Download-RemoteFile $item.Path $target
    Write-Host ('  Updated: ' + $item.Path)
  }

  Save-UpdaterState $remoteFiles $remoteVersion $statePath
  Write-Step '[3/4] Updater state saved.'
  Write-Step "[4/4] Update complete: $remoteVersion"
  Write-Host 'Reload the extension at chrome://extensions.'
} catch {
  Write-Host ''
  Write-Host ('ERROR: ' + $_.Exception.Message)
  [Console]::Out.Flush()
  exit 1
}
