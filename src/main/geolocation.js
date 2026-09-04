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

// Callers (watchPosition fires every 30s per link, and every link with
// location on shares the same OS-level fix) used to each spawn their own
// powershell.exe + reload the System.Device assembly, so a couple of tabs
// left open for a while could pile up several of these at once and peg the
// CPU. A desktop's position essentially never changes, so one fix is good
// for a full hour; and any callers that land while a fetch is already
// in flight just await that same fetch instead of starting another.
const CACHE_TTL_MS = 60 * 60 * 1000;
let cached = null; // { coords, ts }
let inFlight = null;

// error.code mirrors the web Geolocation API's PositionError codes, so the
// inject-main-world.js shim can hand it straight to the page's error callback.
function getWindowsLocation() {
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return Promise.resolve({ ...cached.coords, fromCache: true });
  }
  if (inFlight) return inFlight;

  inFlight = new Promise((resolve, reject) => {
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
          const coords = { latitude: parseFloat(lat), longitude: parseFloat(lon), accuracy: parseFloat(acc) || 50 };
          cached = { coords, ts: Date.now() };
          resolve({ ...coords, fromCache: false });
          return;
        }
        reject(Object.assign(new Error('Windows could not get a location fix.'), { code: 2 }));
      }
    );
  }).finally(() => { inFlight = null; });

  return inFlight;
}

module.exports = { getWindowsLocation };
