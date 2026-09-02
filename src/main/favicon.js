'use strict';

const fs = require('fs');
const path = require('path');
const { app, net, nativeImage, session } = require('electron');

function iconsDir() {
  return path.join(app.getPath('userData'), 'icons');
}

function cachedPath(linkId) {
  return path.join(iconsDir(), `${linkId}.png`);
}

// nativeImage.createFromBuffer only decodes PNG/JPEG — it cannot read .ico at
// all, PNG-wrapped frames included. So for .ico we always parse the container
// ourselves: pick the largest frame, and if it's a raw BMP-style frame (the
// common case for small/medium icons) decode its pixels by hand into a BGRA
// bitmap nativeImage.createFromBitmap() can accept directly.
function parseIcoFrames(buf) {
  if (buf.length < 6 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) return [];
  const count = buf.readUInt16LE(4);
  const frames = [];
  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16;
    if (off + 16 > buf.length) break;
    const width = buf.readUInt8(off) || 256;
    const height = buf.readUInt8(off + 1) || 256;
    const bytesInRes = buf.readUInt32LE(off + 8);
    const imageOffset = buf.readUInt32LE(off + 12);
    if (imageOffset < 0 || imageOffset + bytesInRes > buf.length) continue;
    frames.push({ width, height, data: buf.subarray(imageOffset, imageOffset + bytesInRes) });
  }
  return frames;
}

function isPngFrame(frame) {
  return frame.length > 8 && frame.readUInt32BE(0) === 0x89504e47;
}

// Decodes the raw BITMAPINFOHEADER + pixel data that .ico stores for each
// non-PNG frame. Only handles uncompressed 32bpp (BGRA) frames, which covers
// the vast majority of icons produced in the last ~15 years; anything else
// (paletted 8/4/1-bit legacy icons) is skipped rather than mis-rendered.
function decodeIcoBitmapFrame(frame) {
  if (frame.length < 40) return null;
  const biSize = frame.readUInt32LE(0);
  if (biSize < 40) return null;
  const width = frame.readInt32LE(4);
  const rawHeight = frame.readInt32LE(8);
  const bitCount = frame.readUInt16LE(14);
  const compression = frame.readUInt32LE(16);
  if (compression !== 0 || bitCount !== 32) return null;

  // Stored height covers the XOR color data AND the AND transparency mask
  // stacked together, so the real icon height is half of it.
  const height = Math.abs(rawHeight) / 2;
  if (width <= 0 || height <= 0 || !Number.isInteger(height)) return null;

  const pixelOffset = biSize;
  const rowBytes = width * 4;
  if (frame.length < pixelOffset + rowBytes * height) return null;

  // BMP pixel rows are stored bottom row first; nativeImage.createFromBitmap
  // expects top row first, so flip while copying.
  const out = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const srcStart = pixelOffset + (height - 1 - y) * rowBytes;
    frame.copy(out, y * rowBytes, srcStart, srcStart + rowBytes);
  }
  return { buffer: out, width, height };
}

function decodeIco(buf) {
  const frames = parseIcoFrames(buf);
  if (frames.length === 0) return null;
  frames.sort((a, b) => b.width * b.height - a.width * a.height);

  for (const frame of frames) {
    if (isPngFrame(frame.data)) {
      const img = nativeImage.createFromBuffer(Buffer.from(frame.data));
      if (!img.isEmpty()) return { img, via: `ico-png-frame(${frame.width}x${frame.height})` };
      continue;
    }
    const bmp = decodeIcoBitmapFrame(frame.data);
    if (bmp) {
      const img = nativeImage.createFromBitmap(bmp.buffer, { width: bmp.width, height: bmp.height });
      if (!img.isEmpty()) return { img, via: `ico-bmp-frame(${bmp.width}x${bmp.height})` };
    }
  }
  return null;
}

function isSvg(url) {
  return /\.svg(\?|#|$)/i.test(url) || url.startsWith('data:image/svg');
}

function originFaviconGuess(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/favicon.ico`;
  } catch (_e) {
    return null;
  }
}

function writeCachedImage(linkId, img) {
  fs.mkdirSync(iconsDir(), { recursive: true });
  fs.writeFileSync(cachedPath(linkId), img.resize({ width: 64, height: 64 }).toPNG());
  return cachedPath(linkId);
}

function cacheFaviconDataUrl(linkId, dataUrl) {
  // net.fetch()/session.fetch() cannot load data: URLs, so decode directly.
  try {
    const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(dataUrl);
    if (!match) return null;
    const [, , isBase64, payload] = match;
    const buf = isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8');
    const img = nativeImage.createFromBuffer(buf);
    if (img.isEmpty()) return null;
    return writeCachedImage(linkId, img);
  } catch (_e) {
    return null;
  }
}

async function fetchAndCache(linkId, url, partition) {
  try {
    // Use the link's own (logged-in) session, not the default session — many
    // sites (e.g. Outlook) serve their favicon behind auth, and net.fetch()
    // always issues from the default session regardless of which page asked.
    const ses = partition ? session.fromPartition(partition) : null;
    const res = ses ? await ses.fetch(url) : await net.fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') || '';

    let img = null;
    if (/\bico\b/i.test(contentType) || /\.ico(\?|#|$)/i.test(url)) {
      const decoded = decodeIco(buf);
      if (decoded) img = decoded.img;
    }
    if (!img) {
      const direct = nativeImage.createFromBuffer(buf);
      if (!direct.isEmpty()) img = direct;
    }
    if (!img) {
      const decoded = decodeIco(buf); // e.g. server sent .ico without a proper content-type
      if (decoded) img = decoded.img;
    }

    if (!img || img.isEmpty()) return null;
    return writeCachedImage(linkId, img);
  } catch (_e) {
    return null;
  }
}

// `urls` may be a single favicon URL or the full list Chromium reports for a
// page (icon, apple-touch-icon, mask-icon, etc). We try the most likely-to-
// decode candidates first (nativeImage only understands raster formats, not
// SVG), then fall back to the conventional /favicon.ico at the page's origin.
async function cacheFavicon(linkId, urls, partition) {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  if (list.length === 0) return null;

  const ordered = [...list.filter((u) => !isSvg(u)), ...list.filter((u) => isSvg(u))];
  const originGuess = originFaviconGuess(list[0]);
  if (originGuess && !ordered.includes(originGuess)) ordered.push(originGuess);

  for (const url of ordered) {
    const result = url.startsWith('data:')
      ? cacheFaviconDataUrl(linkId, url)
      : await fetchAndCache(linkId, url, partition); // eslint-disable-line no-await-in-loop
    if (result) return result;
  }
  return null;
}

function getCachedFaviconPath(linkId) {
  const p = cachedPath(linkId);
  return fs.existsSync(p) ? p : null;
}

function removeCachedFavicon(linkId) {
  try { fs.unlinkSync(cachedPath(linkId)); } catch (_e) { /* ignore */ }
}

module.exports = { cacheFavicon, getCachedFaviconPath, removeCachedFavicon, iconsDir };
