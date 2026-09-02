$ErrorActionPreference = "Stop"
Set-Location -Path (Join-Path $PSScriptRoot "..")

if (-not (Test-Path "node_modules")) {
    Write-Host "Installing dependencies (first run only)..."
    npm install
}

node scripts/make-icons.js
npm run dist

Write-Host ""
Write-Host "Done. The app is in 'dist\win-unpacked\My Apps.exe'."
Write-Host "Run create-shortcut.bat to add a Desktop icon for it."
