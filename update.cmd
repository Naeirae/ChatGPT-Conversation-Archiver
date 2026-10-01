@echo off
setlocal
cd /d "%~dp0"

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo This folder is not a Git repository.
  pause
  exit /b 1
)

for /f "delims=" %%B in ('git branch --show-current') do set "BRANCH=%%B"
if not "%BRANCH%"=="main" (
  echo Current branch is %BRANCH%. Switch to main first.
  pause
  exit /b 1
)

git status --porcelain | findstr . >nul
if not errorlevel 1 (
  echo Local changes found. Update stopped.
  pause
  exit /b 1
)

echo Checking GitHub...
git fetch https://github.com/Naeirae/ChatGPT-Conversation-Archiver.git main --quiet
if errorlevel 1 (
  echo GitHub fetch failed.
  pause
  exit /b 1
)

for /f "delims=" %%L in ('git rev-parse HEAD') do set "LOCAL=%%L"
for /f "delims=" %%R in ('git rev-parse FETCH_HEAD') do set "REMOTE=%%R"

if "%LOCAL%"=="%REMOTE%" (
  echo Already up to date.
  pause
  exit /b 0
)

echo Changes:
git diff --stat HEAD..FETCH_HEAD
git merge --ff-only FETCH_HEAD
if errorlevel 1 (
  echo Fast-forward update failed.
  pause
  exit /b 1
)

echo Update complete.
echo Reload the extension at chrome://extensions
pause
