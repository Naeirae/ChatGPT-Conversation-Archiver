@echo off
setlocal
cd /d "%~dp0"

echo ChatGPT Archiver updater
echo ------------------------
echo.

if not exist "%~dp0manifest.json" (
  echo ERROR: manifest.json not found next to update.cmd.
  echo Put the updater files into the unpacked extension folder.
  pause
  exit /b 1
)

if not exist "%~dp0update.ps1" (
  echo ERROR: update.ps1 not found next to update.cmd.
  echo Keep update.cmd and update.ps1 together.
  pause
  exit /b 1
)

echo Starting PowerShell updater...
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1"
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
  echo Update failed. Error code %RC%.
  echo If PowerShell started, details are in updater-last.log.
) else (
  echo Updater finished.
)

pause
exit /b %RC%
