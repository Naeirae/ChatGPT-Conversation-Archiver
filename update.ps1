$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$InstallPath = Split-Path -Parent $MyInvocation.MyCommand.Path
$LogPath = Join-Path $InstallPath 'updater-last.log'

function Write-Log([string]$Message = '') {
  Write-Host $Message
  [Console]::Out.Flush()
  try {
    Add-Content -LiteralPath $LogPath -Value $Message -Encoding UTF8
  } catch {
    # Console output remains available if the log cannot be written.
  }
}

function Get-GitBlobSha([string]$RelativePath) {
  $full = Join-Path $InstallPath ($RelativePath -replace '/', [IO.Path]::DirectorySeparatorChar)
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
  $url = 'https://raw.githubusercontent.com/' + $script:repo + '/' + $script:branch + '/' + $encoded
  $temporary = "$Target.download"

  try {
    Invoke-WebRequest -Uri $url -Headers $script:rawHeaders -OutFile $temporary -UseBasicParsing -TimeoutSec $script:timeout -MaximumRedirection 5
    Move-Item -LiteralPath $temporary -Destination $Target -Force
  } catch {
    if (Test-Path -LiteralPath $temporary) {
      Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    }
    throw "Could not download $RelativePath from $url. $($_.Exception.Message)"
  }
}

function Save-UpdaterState($RemoteFiles, [string]$RemoteVersion, [string]$StatePath) {
  $files = [ordered]@{}
  foreach ($item in $RemoteFiles) {
    $relative = [string]$item.path
    if ($relative -in @('update.cmd', 'update.ps1')) { continue }
    $files[$relative] = [string]$item.sha
  }

  $state = [ordered]@{
    schemaVersion = 2
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
  try {
    if (Test-Path -LiteralPath $LogPath) {
      Remove-Item -LiteralPath $LogPath -Force
    }
  } catch {
    # Logging must not prevent startup.
  }

  Write-Log '[0/4] Updater started.'

  $InstallPath = [IO.Path]::GetFullPath($InstallPath)
  Set-Location -LiteralPath $InstallPath

  $script:repo = 'Naeirae/ChatGPT-Conversation-Archiver'
  $script:branch = 'main'
  $script:apiBase = 'https://api.github.com/repos/' + $script:repo
  $script:headers = @{
    'User-Agent' = 'ChatGPT-Conversation-Archiver-Updater'
    'Accept' = 'application/vnd.github+json'
    'X-GitHub-Api-Version' = '2022-11-28'
  }
  $script:rawHeaders = @{
    'User-Agent' = 'ChatGPT-Conversation-Archiver-Updater'
  }
  $script:timeout = 20

  $localManifest = Join-Path $InstallPath 'manifest.json'
  if (-not (Test-Path -LiteralPath $localManifest)) {
    throw 'manifest.json not found. Keep update.cmd and update.ps1 in the unpacked extension folder.'
  }

  try {
    $localManifestData = Get-Content -Raw -LiteralPath $localManifest | ConvertFrom-Json
    $localVersion = [string]$localManifestData.version
  } catch {
    throw 'Could not read local manifest.json.'
  }

  Write-Log '[1/4] Checking GitHub...'
  $treeUrl = $script:apiBase + '/git/trees/' + [Uri]::EscapeDataString($script:branch) + '?recursive=1'
  Write-Log ('  Request: ' + $treeUrl)

  try {
    $tree = Invoke-RestMethod -Uri $treeUrl -Headers $script:headers -Method Get -TimeoutSec $script:timeout
  } catch {
    throw "Could not reach GitHub tree endpoint $treeUrl. $($_.Exception.Message)"
  }

  if ($tree.truncated) {
    throw 'GitHub returned a truncated repository tree.'
  }

  $remoteFiles = @($tree.tree | Where-Object { $_.type -eq 'blob' })
  $remoteManifestItem = $remoteFiles | Where-Object { $_.path -eq 'manifest.json' } | Select-Object -First 1
  if (-not $remoteManifestItem) {
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
      throw 'Updater state file is damaged. Remove only .chatgpt-archiver-updater-state.json and run again.'
    }
  }

  $firstRun = -not $state
  if ($firstRun) {
    Write-Log ('  First updater run for local version ' + $localVersion + '. Existing changed files will be backed up before replacement.')
  }

  $changed = @()
  $conflicts = @()

  foreach ($item in $remoteFiles) {
    $relative = [string]$item.path

    # Stable updater control plane: never replace the files that are running the update.
    if ($relative -in @('update.cmd', 'update.ps1')) {
      continue
    }

    $target = Join-Path $InstallPath ($relative -replace '/', [IO.Path]::DirectorySeparatorChar)
    if (-not (Test-Path -LiteralPath $target)) {
      $changed += [pscustomobject]@{
        Path = $relative
        Sha = [string]$item.sha
        Exists = $false
        Reason = 'missing'
      }
      continue
    }

    $localSha = Get-GitBlobSha $relative
    $remoteSha = [string]$item.sha

    if ($localSha -eq $remoteSha) {
      continue
    }

    if ($firstRun) {
      $changed += [pscustomobject]@{
        Path = $relative
        Sha = $remoteSha
        Exists = $true
        Reason = 'first-run'
      }
      continue
    }

    $baselineSha = Get-StateSha $state $relative
    if (-not $baselineSha -or $localSha -ne $baselineSha) {
      $conflicts += [pscustomobject]@{
        Path = $relative
        LocalSha = $localSha
        BaselineSha = $baselineSha
        RemoteSha = $remoteSha
      }
      continue
    }

    $changed += [pscustomobject]@{
      Path = $relative
      Sha = $remoteSha
      Exists = $true
      Reason = 'remote'
    }
  }

  if ($conflicts.Count -gt 0) {
    Write-Log '[2/4] Local changes detected. Update stopped before writing extension files.'
    foreach ($item in $conflicts) {
      Write-Log ('  Local change: ' + $item.Path)
    }
    throw 'Local changes would be overwritten.'
  }

  if ($changed.Count -eq 0) {
    Write-Log ("[2/4] Already up to date: $localVersion")
    Save-UpdaterState $remoteFiles $remoteVersion $statePath
    Write-Log '[3/4] Updater state saved.'
    Write-Log '[4/4] No files to update.'
    return
  }

  Write-Log ("[2/4] Updating $localVersion -> $remoteVersion")
  Write-Log ('  Files to update: ' + $changed.Count)

  $backupRoot = $null
  if ($firstRun -and @($changed | Where-Object { $_.Exists }).Count -gt 0) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backupRoot = Join-Path (Join-Path $InstallPath '.archiver-update-backup') $stamp
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    Write-Log ('  First-run backup: ' + $backupRoot)
  }

  foreach ($item in $changed) {
    $target = Join-Path $InstallPath ($item.Path -replace '/', [IO.Path]::DirectorySeparatorChar)
    $directory = Split-Path -Parent $target
    if ($directory -and -not (Test-Path -LiteralPath $directory)) {
      New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }

    if ($backupRoot -and $item.Exists) {
      $backupTarget = Join-Path $backupRoot ($item.Path -replace '/', [IO.Path]::DirectorySeparatorChar)
      $backupDirectory = Split-Path -Parent $backupTarget
      if ($backupDirectory -and -not (Test-Path -LiteralPath $backupDirectory)) {
        New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
      }
      Copy-Item -LiteralPath $target -Destination $backupTarget -Force
      Write-Log ('  Backed up: ' + $item.Path)
    }

    Download-RemoteFile $item.Path $target
    Write-Log ('  Updated: ' + $item.Path)
  }

  Save-UpdaterState $remoteFiles $remoteVersion $statePath
  Write-Log '[3/4] Updater state saved.'
  Write-Log ("[4/4] Update complete: $remoteVersion")
  Write-Log 'Reload the extension at chrome://extensions.'
} catch {
  Write-Log ''
  Write-Log ('ERROR: ' + $_.Exception.Message)
  exit 1
}
