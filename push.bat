@echo off
REM Pull, commit with an AI-written message, push. Nothing else.
where pwsh >nul 2>&1
if %errorlevel% == 0 (
    pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0push.ps1" %*
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0push.ps1" %*
)
if errorlevel 1 pause
