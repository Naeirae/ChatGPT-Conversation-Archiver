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

set "TEMP_UPDATER=%TEMP%\ChatGPT-Conversation-Archiver-update.ps1"
set "UPDATER_LOG=%~dp0updater-last.log"

echo [1/2] Getting updater from GitHub...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $u='https://api.github.com/repos/Naeirae/ChatGPT-Conversation-Archiver/contents/update.ps1?ref=main'; $h=@{'User-Agent'='ChatGPT-Conversation-Archiver-Updater'; 'Accept'='application/vnd.github.raw+json'; 'X-GitHub-Api-Version'='2022-11-28'}; try { Invoke-WebRequest -Uri $u -Headers $h -OutFile '%TEMP_UPDATER%' -UseBasicParsing -TimeoutSec 20 -MaximumRedirection 5; Write-Host 'Updater downloaded.' } catch { Write-Host ('ERROR: ' + $_.Exception.Message); exit 1 }"
if errorlevel 1 (
  echo.
  echo Could not get the updater from GitHub.
  echo The request is limited by a timeout, so it will not hang indefinitely.
  pause
  exit /b 1
)

echo [2/2] Running updater...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP_UPDATER%" -InstallPath "%~dp0" > "%UPDATER_LOG%" 2>&1
set "RC=%ERRORLEVEL%"

if exist "%UPDATER_LOG%" (
  type "%UPDATER_LOG%"
) else (
  echo ERROR: updater log was not created.
)

echo.
if not "%RC%"=="0" (
  echo Update failed. Error code %RC%.
  echo Details were written to:
  echo %UPDATER_LOG%
  pause
  exit /b %RC%
)

echo Updater finished.
echo Details were written to:
echo %UPDATER_LOG%
pause
exit /b 0
