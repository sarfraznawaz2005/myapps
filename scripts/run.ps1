$ErrorActionPreference = "Stop"
Set-Location -Path (Join-Path $PSScriptRoot "..")

if (-not (Test-Path "node_modules")) {
    Write-Host "Installing dependencies (first run only)..."
    npm install
}

if (-not (Test-Path "assets\icon.ico")) {
    Write-Host "Generating icons (first run only)..."
    node scripts/make-icons.js
}

npm start
