'use strict';

// DISPOSABLE smoke test for ad blocking. Delete after use.
// Run:  npx electron scripts/adblock-smoke.js
// Needs internet once (downloads the filter lists). It loads a local page that
// asks for a known ad URL and a harmless local file, with blocking ON then OFF.

const http = require('http');
const { app, BrowserWindow, session } = require('electron');
const adblock = require('../src/main/adblock');

const warnings = [];
const origWarn = console.warn;
console.warn = (...a) => { if (String(a[0]).includes('[adblock]')) warnings.push(a.join(' ')); origWarn(...a); };

const AD_URL = 'https://googleads.g.doubleclick.net/pagead/id';

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/ok.png') {
      res.writeHead(200, { 'Content-Type': 'image/gif' });
      return res.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'));
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<img src="/ok.png"><img src="${AD_URL}"><script src="${AD_URL}.js"></script>`);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Load the page in a fresh session and report which requests were blocked.
async function runCase(name, enabled, port) {
  const ses = session.fromPartition(`smoke-${name}`);
  adblock.setEnabled(ses, enabled);
  await adblock.whenReady();
  adblock.setEnabled(ses, enabled); // lists are loaded now; apply for real

  const blocked = [];
  ses.webRequest.onErrorOccurred((d) => {
    if (d.error === 'net::ERR_BLOCKED_BY_CLIENT') blocked.push(d.url);
  });
  const win = new BrowserWindow({ show: false, webPreferences: { session: ses } });
  await win.loadURL(`http://127.0.0.1:${port}/`).catch(() => {});
  await new Promise((r) => setTimeout(r, 4000));
  win.destroy();
  return blocked;
}

app.on('window-all-closed', () => {}); // keep running between test cases
app.whenReady().then(async () => {
  const server = await startServer();
  const { port } = server.address();
  let ok = true;
  try {
    const on = await runCase('on', true, port);
    const on2 = await runCase('on2', true, port); // a SECOND session must also block
    const off = await runCase('off', false, port);
    const on3 = await runCase('on3', true, port); // still blocks after another session was switched off
    const adBlockedOn = on.some((u) => u.includes('doubleclick.net'));
    const localBlockedOn = on.some((u) => u.includes('127.0.0.1'));
    const adBlockedOff = off.some((u) => u.includes('doubleclick.net'));
    const report = (label, pass) => { require('fs').appendFileSync(require('path').join(__dirname, 'adblock-smoke.out.txt'), (pass ? 'PASS ' : 'FAIL ') + label + '\n'); console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`); if (!pass) ok = false; };
    report('blocking ON  blocks the ad URL', adBlockedOn);
    report('blocking ON  keeps the local file', !localBlockedOn);
    report('2nd session with blocking ON also blocks the ad URL', on2.some((u) => u.includes('doubleclick.net')));
    report('session added after one was switched off still blocks', on3.some((u) => u.includes('doubleclick.net')));
    report('no "could not update session" warnings', warnings.length === 0);
    report('blocking OFF does not block the ad URL', !adBlockedOff);
  } catch (e) {
    console.log('FAIL  error:', e && e.message);
    ok = false;
  }
  server.close();
  console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');
  app.exit(ok ? 0 : 1);
});
