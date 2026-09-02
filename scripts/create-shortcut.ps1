$ErrorActionPreference = "Stop"
$root = Join-Path $PSScriptRoot ".."
$exePath = Join-Path $root "dist\win-unpacked\My Apps.exe"

if (-not (Test-Path $exePath)) {
    Write-Host "My Apps.exe not found. Run build.bat first to package the app."
    exit 1
}

$exePath = (Resolve-Path $exePath).Path
$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "My Apps.lnk"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $exePath
$shortcut.WorkingDirectory = Split-Path $exePath
$shortcut.IconLocation = $exePath
$shortcut.Save()

Write-Host "Desktop shortcut created: $shortcutPath"
