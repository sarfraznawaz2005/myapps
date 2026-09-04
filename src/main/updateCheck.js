'use strict';

const https = require('https');
const { app } = require('electron');

const REPO = 'sarfraznawaz2005/myapps';

function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const req = https.get(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      { headers: { 'User-Agent': 'MyApps-UpdateCheck' } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`GitHub API returned ${res.statusCode}`));
          return;
        }
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('Update check timed out')));
  });
}

// Plain numeric compare — good enough for our own vMAJOR.MINOR.PATCH release
// tags, no pre-release/build metadata to worry about.
function isNewer(latest, current) {
  const a = latest.split('.').map((n) => parseInt(n, 10) || 0);
  const b = current.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

async function checkForUpdate() {
  const currentVersion = app.getVersion();
  try {
    const release = await fetchLatestRelease();
    const latestVersion = (release.tag_name || '').replace(/^v/, '');
    return {
      ok: true,
      currentVersion,
      latestVersion: latestVersion || null,
      hasUpdate: !!latestVersion && isNewer(latestVersion, currentVersion),
      url: release.html_url || `https://github.com/${REPO}/releases/latest`,
    };
  } catch (e) {
    return { ok: false, currentVersion, error: String((e && e.message) || e) };
  }
}

module.exports = { checkForUpdate };
