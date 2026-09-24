@echo off
setlocal
cd /d "%~dp0"

set "SCRIPT=%~dp0install-equicord.ps1"

if not exist "%SCRIPT%" (
    echo [ERROR] Script not found: "%SCRIPT%"
    pause
    exit /b 1
)

echo Starting Equicord + GoLiveBypass Setup...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
echo.
pause
