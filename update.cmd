@echo off
setlocal
cd /d "%~dp0"
set "UPDATER_URL=https://raw.githubusercontent.com/Naeirae/ChatGPT-Conversation-Archiver/main/update.ps1"
set "TEMP_UPDATER=%TEMP%\ChatGPT-Conversation-Archiver-update.ps1"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri '%UPDATER_URL%' -OutFile '%TEMP_UPDATER%'"
if errorlevel 1 (
  echo Could not download the updater from GitHub.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP_UPDATER%" -InstallPath "%~dp0"
if errorlevel 1 (
  echo.
  echo Update failed.
  pause
  exit /b 1
)

if exist "%~dp0update.cmd.new" (
  move /y "%~dp0update.cmd.new" "%~dp0update.cmd" >nul
)

echo.
echo Updater finished.
pause
