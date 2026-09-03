'use strict';

const { execFile } = require('child_process');

// Electron's built-in navigator.geolocation asks Google's network location
// webservice for a fix, which needs a paid API key we don't have (see
// GOOGLE_API_KEY in Electron's docs) and always fails with a 403 without one.
// Windows already knows the device's position — it's the same OS location
// stack Edge/WebView2 read from, and the same toggle under Settings > Privacy
// > Location. GeoCoordinateWatcher (part of .NET since Windows 7) reads it
// directly, no key required.
const SCRIPT = `
Add-Type -AssemblyName System.Device
$watcher = New-Object System.Device.Location.GeoCoordinateWatcher
$watcher.Start()
$sw = [Diagnostics.Stopwatch]::StartNew()
while ($watcher.Status -ne 'Ready' -and $watcher.Permission -ne 'Denied' -and $sw.Elapsed.TotalSeconds -lt 10) {
  Start-Sleep -Milliseconds 200
}
if ($watcher.Permission -eq 'Denied') {
  Write-Output 'DENIED'
} elseif ($watcher.Status -ne 'Ready' -or $watcher.Position.Location.IsUnknown) {
  Write-Output 'UNAVAILABLE'
} else {
  $c = $watcher.Position.Location
  Write-Output ("OK|{0}|{1}|{2}" -f $c.Latitude, $c.Longitude, $c.HorizontalAccuracy)
}
$watcher.Stop()
`;

// error.code mirrors the web Geolocation API's PositionError codes, so the
// inject-main-world.js shim can hand it straight to the page's error callback.
function getWindowsLocation() {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      reject(Object.assign(new Error('Not supported on this OS.'), { code: 2 }));
      return;
    }
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
      { timeout: 15000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          reject(Object.assign(new Error('Failed to query Windows Location.'), { code: 2 }));
          return;
        }
        const line = stdout.trim();
        if (line === 'DENIED') {
          reject(Object.assign(new Error('Location is turned off in Windows Settings.'), { code: 1 }));
          return;
        }
        if (line.startsWith('OK|')) {
          const [, lat, lon, acc] = line.split('|');
          resolve({ latitude: parseFloat(lat), longitude: parseFloat(lon), accuracy: parseFloat(acc) || 50 });
          return;
        }
        reject(Object.assign(new Error('Windows could not get a location fix.'), { code: 2 }));
      }
    );
  });
}

module.exports = { getWindowsLocation };
