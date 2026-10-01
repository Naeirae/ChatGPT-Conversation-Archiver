$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

if (-not (Test-Path -LiteralPath '.git')) {
  throw 'This folder is not a Git repository.'
}

if ((git branch --show-current).Trim() -ne 'main') {
  throw 'Current branch is not main.'
}

if ((git status --porcelain)) {
  throw 'Local changes found. Update stopped.'
}

$remote = 'https://github.com/Naeirae/ChatGPT-Conversation-Archiver.git'
$before = (git rev-parse HEAD).Trim()

Write-Host 'Checking GitHub...'
git fetch $remote main --quiet
if ($LASTEXITCODE -ne 0) {
  throw 'GitHub fetch failed.'
}

$after = (git rev-parse FETCH_HEAD).Trim()

if ($before -eq $after) {
  Write-Host 'Already up to date.'
  exit 0
}

Write-Host 'Changes:'
git diff --stat HEAD..FETCH_HEAD
git merge --ff-only FETCH_HEAD
if ($LASTEXITCODE -ne 0) {
  throw 'Fast-forward update failed.'
}

$version = (Get-Content -Raw -LiteralPath 'manifest.json' | ConvertFrom-Json).version
Write-Host "Updated to version $version."
Write-Host 'Reload the extension at chrome://extensions.'
