$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

if (-not (Test-Path -LiteralPath '.git')) {
  throw 'Эта папка должна быть клоном GitHub-репозитория.'
}

if ((git status --porcelain)) {
  throw 'В рабочей папке есть несохраненные изменения. Сначала сохраните их в Git или уберите.'
}

$remote = 'https://github.com/Naeirae/ChatGPT-Conversation-Archiver.git'
$before = (git rev-parse HEAD).Trim()

Write-Host 'Проверяю публичный GitHub-репозиторий...'
git fetch $remote main --quiet
$after = (git rev-parse FETCH_HEAD).Trim()

if ($before -eq $after) {
  Write-Host 'Уже актуально.'
  exit 0
}

Write-Host 'Изменения:'
git diff --stat HEAD..FETCH_HEAD
git merge --ff-only FETCH_HEAD

$version = (Get-Content -Raw -LiteralPath 'manifest.json' | ConvertFrom-Json).version
Write-Host "Обновлено до версии $version."
Write-Host 'Перезагрузите расширение через chrome://extensions.'
