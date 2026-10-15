'use strict';

// Updates come from this repo's GitHub Releases.
// - Installed copy (Setup): electron-updater reads latest.yml, downloads the new
//   Setup, checks it and installs it silently.
// - Portable copy (unzipped folder): electron-updater cannot update it, so the zip is
//   downloaded, checked against SHA256SUMS.txt, and a small PowerShell script copies
//   it over the folder after the app closes.

const { app, net } = require('electron');
const { spawn } = require('child_process');
const { createHash } = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = 'sarfraznawaz2005/myapps';
const RELEASES_URL = `https://github.com/${REPO}/releases`;
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;
const CHECKSUM_FILE = 'SHA256SUMS.txt';
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 45 * 1000;
const PORTABLE_DIR = path.join(os.tmpdir(), 'myapps-portable-update');
const EXE_NAME = 'My Apps.exe';

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// True when a is a higher version than b. Unparseable versions are never newer.
function isNewer(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

// Reads "<sha256>  <file name>" lines (sha256sum format) into a Map name -> hex.
function parseChecksums(text) {
  const out = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^([a-fA-F0-9]{64})\s+\*?(.+?)\s*$/.exec(line.trim());
    if (m) out.set(m[2], m[1].toLowerCase());
  }
  return out;
}

// The portable zip of a release, only if it comes from this repo's release files.
function pickPortableAsset(assets, version) {
  const want = `MyApps-${String(version).replace(/^v/, '')}-portable.zip`;
  const a = (assets || []).find((x) => x.name === want);
  return a && String(a.browser_download_url).startsWith(DOWNLOAD_PREFIX) ? a : null;
}

// Single quotes doubled, for text inside a PowerShell single-quoted string.
function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function detectMode() {
  if (!app.isPackaged) return 'dev';
  return fs.existsSync(path.join(path.dirname(process.execPath), 'Uninstall My Apps.exe')) ? 'installed' : 'portable';
}

const state = {
  app: { version: '', mode: 'dev' },
  autoCheck: true,
  checking: false,
  checkedAt: null,
  checkError: null,
  latest: null, // { version, notes, url, assetName, assetBytes }
  available: false,
  download: { phase: 'idle', progress: 0, error: null }, // phase: idle|downloading|verifying|ready|error
};

let ctx = null;
let mode = 'dev';
let autoUpdater = null;
let portableAsset = null;
let portableZip = null;
let timer = null;
let notifiedVersion = null;

function push() {
  const w = ctx && ctx.mainWindow;
  if (w && !w.isDestroyed()) w.webContents.send('shell:update', state);
  return state;
}

function setDownload(patch) {
  state.download = { ...state.download, ...patch };
  push();
}

function configure() {
  if (autoUpdater) return;
  // Loaded here, not at the top, so tests that stub electron never load it.
  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.setFeedURL({ provider: 'github', owner: REPO.split('/')[0], repo: REPO.split('/')[1], releaseType: 'release' });
  autoUpdater.logger = null;
  autoUpdater.on('download-progress', (p) => setDownload({ phase: 'downloading', progress: Math.round(p.percent) }));
}

async function getJson(url) {
  const res = await net.fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': `MyApps/${state.app.version}` } });
  if (!res.ok) throw new Error(res.status === 404 ? 'No release has been published yet.' : `GitHub answered HTTP ${res.status}.`);
  return res.json();
}

async function fetchLatest() {
  const rel = await getJson(LATEST_API);
  const version = String(rel.tag_name || '').replace(/^v/, '');
  portableAsset = pickPortableAsset(rel.assets, version);
  const setup = (rel.assets || []).find((a) => a.name === `MyApps-Setup-${version}.exe`);
  const asset = mode === 'portable' ? portableAsset : setup;
  return {
    version,
    notes: String(rel.body || '').trim(),
    url: rel.html_url || RELEASES_URL,
    assetName: asset ? asset.name : null,
    assetBytes: asset ? asset.size : null,
  };
}

async function checkForUpdate(opts = {}) {
  if (state.checking) return state;
  state.checking = true;
  state.checkError = null;
  push();
  try {
    const latest = await fetchLatest();
    state.latest = latest;
    state.available = !!latest.version && isNewer(latest.version, state.app.version);
    state.checkedAt = new Date().toISOString();
    if (state.available && opts.quiet && notifiedVersion !== latest.version) {
      notifiedVersion = latest.version;
      if (ctx && ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
        ctx.mainWindow.webContents.send('shell:toast', {
          type: 'info',
          message: `My Apps ${latest.version} is available. Open Settings > About to update.`,
        });
      }
    }
  } catch (err) {
    const msg = String((err && err.message) || err);
    state.checkError = /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ERR_INTERNET|ERR_NAME|net::/i.test(msg)
      ? 'No internet connection, or GitHub cannot be reached.'
      : msg.split('\n')[0].slice(0, 300);
  } finally {
    state.checking = false;
  }
  return push();
}

async function downloadUpdate() {
  if (!state.available || !state.latest) throw new Error('There is no update to download. Click Check for Updates first.');
  if (mode === 'dev') throw new Error('Updates install only in the built app, not when running from source.');
  if (state.download.phase === 'downloading' || state.download.phase === 'verifying') return state;
  setDownload({ phase: 'downloading', progress: 0, error: null });
  try {
    if (mode === 'installed') {
      configure();
      // electron-updater needs its own check before it can download.
      await autoUpdater.checkForUpdates();
      await autoUpdater.downloadUpdate();
    } else {
      await downloadPortable();
    }
    setDownload({ phase: 'ready', progress: 100, error: null });
  } catch (err) {
    setDownload({ phase: 'error', error: String((err && err.message) || err).split('\n')[0] });
  }
  return state;
}

async function downloadPortable() {
  const asset = portableAsset;
  if (!asset) throw new Error('This release has no portable zip. Download it from the Releases page.');
  const rel = await getJson(`https://api.github.com/repos/${REPO}/releases/tags/v${state.latest.version}`);
  const sums = (rel.assets || []).find((a) => a.name === CHECKSUM_FILE);
  if (!sums) throw new Error('This release has no checksum file, so the download cannot be checked. Download it from the Releases page.');
  const sumsRes = await net.fetch(sums.browser_download_url);
  if (!sumsRes.ok) throw new Error(`Could not read the checksum file (HTTP ${sumsRes.status}).`);
  const expected = parseChecksums(await sumsRes.text()).get(asset.name);
  if (!expected) throw new Error('The checksum file does not list the portable zip.');

  fs.rmSync(PORTABLE_DIR, { recursive: true, force: true });
  fs.mkdirSync(PORTABLE_DIR, { recursive: true });
  const file = path.join(PORTABLE_DIR, asset.name);
  const res = await net.fetch(asset.browser_download_url);
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}).`);
  const total = Number(res.headers.get('content-length')) || asset.size;
  const hash = createHash('sha256');
  const out = fs.createWriteStream(file);
  let got = 0;
  let lastPct = -1;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      got += value.length;
      if (!out.write(value)) await new Promise((r) => out.once('drain', r));
      const pct = total ? Math.floor((got / total) * 100) : 0;
      if (pct !== lastPct) {
        lastPct = pct;
        setDownload({ progress: pct });
      }
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  setDownload({ phase: 'verifying' });
  if (hash.digest('hex') !== expected) {
    fs.rmSync(file, { force: true });
    throw new Error('The downloaded file does not match its checksum. It was deleted. Try again.');
  }
  portableZip = file;
}

// Closes the app and installs the downloaded update. The app starts again when done.
function installUpdate() {
  if (state.download.phase !== 'ready') throw new Error('Download the update first.');
  if (ctx) ctx.isQuitting = true;
  if (mode === 'installed') {
    // Silent install, then start the app again.
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
    return;
  }
  if (mode === 'portable') {
    installPortable();
    return;
  }
  throw new Error('Updates install only in the built app.');
}

function installPortable() {
  if (!portableZip || !fs.existsSync(portableZip)) throw new Error('The downloaded update is missing. Download it again.');
  const appDir = path.dirname(process.execPath);
  // Never copy over a folder that is not a portable My Apps.
  if (!fs.existsSync(path.join(appDir, 'resources', 'app.asar')) || !fs.existsSync(path.join(appDir, EXE_NAME))) {
    throw new Error(`My Apps cannot find its own files next to ${EXE_NAME}, so it will not update this folder. Download the new zip from the Releases page.`);
  }
  const extract = path.join(PORTABLE_DIR, 'extracted');
  const script = path.join(PORTABLE_DIR, 'apply-update.ps1');
  // Copies new files over the old ones (/E), never deletes anything in the folder.
  const ps = `$ErrorActionPreference = 'Continue'
$host.UI.RawUI.WindowTitle = 'My Apps Update'
Write-Host ''
Write-Host '  My Apps Update' -ForegroundColor Cyan
Write-Host '  [1/3]  Waiting for My Apps to close...' -ForegroundColor Yellow
try { Wait-Process -Id ${process.pid} -Timeout 60 -ErrorAction SilentlyContinue } catch {}
$dir = ${psQuote(appDir.toLowerCase() + '\\')}
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
  $left = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.ToLower().StartsWith($dir) }
  if (-not $left) { break }
  Start-Sleep -Milliseconds 400
}
Write-Host '  [2/3]  Copying the new version...' -ForegroundColor Yellow
Remove-Item -Recurse -Force ${psQuote(extract)} -ErrorAction SilentlyContinue
Expand-Archive -Path ${psQuote(portableZip)} -DestinationPath ${psQuote(extract)} -Force
$src = ${psQuote(extract)}
if (-not (Test-Path (Join-Path $src ${psQuote(EXE_NAME)}))) {
  $sub = Get-ChildItem -Path $src -Directory | Where-Object { Test-Path (Join-Path $_.FullName ${psQuote(EXE_NAME)}) } | Select-Object -First 1
  if ($sub) { $src = $sub.FullName }
}
if (Test-Path (Join-Path $src ${psQuote(EXE_NAME)})) {
  robocopy $src ${psQuote(appDir)} /E /R:3 /W:2 /NFL /NDL /NP /NJH /NJS | Out-Null
  if ($LASTEXITCODE -ge 8) { Write-Host '  ERROR: could not copy the files. Is the folder read-only?' -ForegroundColor Red; Start-Sleep -Seconds 8 }
} else {
  Write-Host '  ERROR: the update zip has no ${EXE_NAME}.' -ForegroundColor Red
  Start-Sleep -Seconds 8
}
Write-Host '  [3/3]  Starting My Apps...' -ForegroundColor Yellow
Start-Process -FilePath ${psQuote(process.execPath)}
Remove-Item -Recurse -Force ${psQuote(extract)} -ErrorAction SilentlyContinue
Remove-Item -Force ${psQuote(portableZip)} -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
`;
  fs.writeFileSync(script, ps, 'utf8');
  // cmd /c start gives the script its own process, so it lives on after the app exits.
  const child = spawn('cmd.exe', ['/c', 'start', '""', 'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  setTimeout(() => app.quit(), 300);
}

function setAutoCheck(on) {
  state.autoCheck = !!on;
  if (ctx && ctx.store) ctx.store.updateSettings({ autoUpdateCheck: state.autoCheck });
  schedule();
  return push();
}

function schedule() {
  if (timer) clearInterval(timer);
  timer = null;
  if (!state.autoCheck || mode === 'dev') return;
  timer = setInterval(() => void checkForUpdate({ quiet: true }), CHECK_EVERY_MS);
  timer.unref();
}

// Checks shortly after start, then every 6 hours.
function startUpdateChecks(appCtx) {
  ctx = appCtx;
  mode = detectMode();
  state.app = { version: app.getVersion(), mode };
  const saved = ctx.store && ctx.store.getState().settings.autoUpdateCheck;
  state.autoCheck = saved !== false;
  schedule();
  if (state.autoCheck && mode !== 'dev') setTimeout(() => void checkForUpdate({ quiet: true }), FIRST_CHECK_MS).unref();
}

function stopUpdateChecks() {
  if (timer) clearInterval(timer);
  timer = null;
}

function getUpdateState() {
  if (!ctx) {
    mode = detectMode();
    state.app = { version: app.getVersion(), mode };
  }
  return state;
}

module.exports = {
  startUpdateChecks,
  stopUpdateChecks,
  checkForUpdate,
  downloadUpdate,
  installUpdate,
  setAutoCheck,
  getUpdateState,
  RELEASES_URL,
  isNewer,
  parseChecksums,
  pickPortableAsset,
  psQuote,
};
