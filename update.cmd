@echo off
setlocal
cd /d "%~dp0"

echo ChatGPT Archiver updater
echo ------------------------
echo.

if not exist "%~dp0manifest.json" (
  echo ERROR: manifest.json not found in this folder.
  echo Put update.cmd next to manifest.json and try again.
  pause
  exit /b 1
)

if not exist "%~dp0update.ps1" (
  echo ERROR: update.ps1 not found in this folder.
  pause
  exit /b 1
)

echo Starting local updater...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1" -InstallPath "%~dp0"
set "RC=%ERRORLEVEL%"

echo.
if not "%RC%"=="0" (
  echo Update failed. Error code %RC%.
  echo If GitHub is unreachable, check the network connection and try again.
  pause
  exit /b %RC%
)

if exist "%~dp0update.ps1.new" (
  move /y "%~dp0update.ps1.new" "%~dp0update.ps1" >nul
  echo Updated updater: update.ps1
)

if exist "%~dp0update.cmd.new" (
  move /y "%~dp0update.cmd.new" "%~dp0update.cmd" >nul
  echo Updated updater: update.cmd
)

echo.
echo Updater finished.
pause
exit /b 0
