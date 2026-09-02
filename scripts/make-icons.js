// Generates all PNG/ICO icons for My Apps with no external image dependencies.
// The crc32/chunk/drawDot/buildIco machinery below is reused verbatim from
// DesktopApps/MyOutlook/scripts/make-icons.js (pure Node zlib, no deps).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function pngFromRaw(size, raw) {
  const stride = size * 4;
  const withFilter = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    withFilter[y * (stride + 1)] = 0;
    raw.copy(withFilter, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const idat = zlib.deflateSync(withFilter);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function drawDot(size) {
  const raw = Buffer.alloc(size * size * 4);
  const cx = size / 2, cy = size / 2;
  const r = size * 0.42;
  const ringR = size * 0.48;
  const RED = [214, 40, 40];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      let color = [0, 0, 0, 0];
      if (d <= r) {
        color = [RED[0], RED[1], RED[2], 255];
      } else if (d <= ringR) {
        color = [255, 255, 255, 255];
      }
      const idx = (y * size + x) * 4;
      raw[idx] = color[0]; raw[idx + 1] = color[1]; raw[idx + 2] = color[2]; raw[idx + 3] = color[3];
    }
  }
  return pngFromRaw(size, raw);
}

function buildIco(pngBuffer, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // one image

  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size; // width (0 = 256)
  entry[1] = size >= 256 ? 0 : size; // height (0 = 256)
  entry[2] = 0; // color palette
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(pngBuffer.length, 8); // image data size
  entry.writeUInt32LE(header.length + entry.length, 12); // offset

  return Buffer.concat([header, entry, pngBuffer]);
}

// ---- My Apps specific drawing ----

// 3x3 grid "app tiles" icon — represents "many services, one window".
function drawAppIcon(size, bg) {
  const raw = Buffer.alloc(size * size * 4);
  const margin = Math.round(size * 0.14);
  const gap = Math.round(size * 0.07);
  const gridSize = size - margin * 2;
  const cell = (gridSize - gap * 2) / 3;
  const radius = Math.max(1, Math.round(cell * 0.18));

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = bg[0], g = bg[1], b = bg[2], a = 255;
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 3; col++) {
          const cx0 = margin + col * (cell + gap);
          const cy0 = margin + row * (cell + gap);
          const cx1 = cx0 + cell;
          const cy1 = cy0 + cell;
          if (x >= cx0 - 0.5 && x < cx1 + 0.5 && y >= cy0 - 0.5 && y < cy1 + 0.5) {
            // rounded-corner test
            const nx = Math.min(x - cx0, cx1 - x);
            const ny = Math.min(y - cy0, cy1 - y);
            let inside = true;
            if (nx < radius && ny < radius) {
              const dx = radius - nx;
              const dy = radius - ny;
              inside = (dx * dx + dy * dy) <= radius * radius;
            }
            if (inside) {
              // center tile brighter (accent), rest white-on-blue
              if (row === 1 && col === 1) {
                r = 255; g = 255; b = 255;
              } else {
                r = 255; g = 255; b = 255; a = 235;
              }
            }
          }
        }
      }
      const idx = (y * size + x) * 4;
      raw[idx] = r; raw[idx + 1] = g; raw[idx + 2] = b; raw[idx + 3] = a;
    }
  }
  return pngFromRaw(size, raw);
}

// Solid rounded-square background swatch used for tray/overlay compositing.
function drawSwatch(size, bg, ring) {
  const raw = Buffer.alloc(size * size * 4);
  const cx = size / 2, cy = size / 2;
  const r = size * 0.46;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      let color = [0, 0, 0, 0];
      if (d <= r) color = [bg[0], bg[1], bg[2], 255];
      else if (ring && d <= r + Math.max(1, size * 0.05)) color = [255, 255, 255, 255];
      const idx = (y * size + x) * 4;
      raw[idx] = color[0]; raw[idx + 1] = color[1]; raw[idx + 2] = color[2]; raw[idx + 3] = color[3];
    }
  }
  return pngFromRaw(size, raw);
}

// Hand-coded 5x7 bitmap glyph table for 0-9 and '+', 1 = lit pixel.
const GLYPHS = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '11100'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
};

// Draws a red rounded badge with a 5x7 bitmap glyph string (e.g. "9+", "3").
function drawDigitOverlay(size, text) {
  const raw = Buffer.alloc(size * size * 4);
  const RED = [214, 40, 40];
  const cx = size / 2, cy = size / 2;
  const r = size * 0.46;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      let color = [0, 0, 0, 0];
      if (d <= r) color = [RED[0], RED[1], RED[2], 255];
      else if (d <= r + Math.max(1, size * 0.04)) color = [255, 255, 255, 255];
      const idx = (y * size + x) * 4;
      raw[idx] = color[0]; raw[idx + 1] = color[1]; raw[idx + 2] = color[2]; raw[idx + 3] = color[3];
    }
  }

  const glyphs = text.split('').map((ch) => GLYPHS[ch] || GLYPHS['0']);
  const glyphW = 5, glyphH = 7, glyphGap = 1;
  const totalW = glyphs.length * glyphW + (glyphs.length - 1) * glyphGap;
  const scale = Math.max(1, Math.floor((size * 0.62) / Math.max(totalW, glyphH)));
  const pixelW = totalW * scale;
  const pixelH = glyphH * scale;
  const startX = Math.round((size - pixelW) / 2);
  const startY = Math.round((size - pixelH) / 2);

  glyphs.forEach((glyph, gi) => {
    const gx0 = startX + gi * (glyphW + glyphGap) * scale;
    for (let row = 0; row < glyphH; row++) {
      for (let col = 0; col < glyphW; col++) {
        if (glyph[row][col] !== '1') continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const px = gx0 + col * scale + sx;
            const py = startY + row * scale + sy;
            if (px < 0 || py < 0 || px >= size || py >= size) continue;
            const idx = (py * size + px) * 4;
            raw[idx] = 255; raw[idx + 1] = 255; raw[idx + 2] = 255; raw[idx + 3] = 255;
          }
        }
      }
    }
  });

  return pngFromRaw(size, raw);
}

const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });

const BLUE = [59, 130, 246]; // matches --accent in tokens.css

const appIconPng = drawAppIcon(256, BLUE);
fs.writeFileSync(path.join(outDir, 'icon.png'), appIconPng);
fs.writeFileSync(path.join(outDir, 'icon.ico'), buildIco(appIconPng, 256));

fs.writeFileSync(path.join(outDir, 'tray.png'), drawAppIcon(64, BLUE));

// Build tray-unread by drawing the app icon then compositing a red dot badge
// in the top-right corner, done in raw pixel space so no PNG decode is needed.
function drawAppIconWithDot(size, bg) {
  const margin = Math.round(size * 0.14);
  const gap = Math.round(size * 0.07);
  const gridSize = size - margin * 2;
  const cell = (gridSize - gap * 2) / 3;
  const radius = Math.max(1, Math.round(cell * 0.18));
  const raw = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = bg[0], g = bg[1], b = bg[2], a = 255;
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 3; col++) {
          const cx0 = margin + col * (cell + gap);
          const cy0 = margin + row * (cell + gap);
          const cx1 = cx0 + cell;
          const cy1 = cy0 + cell;
          if (x >= cx0 - 0.5 && x < cx1 + 0.5 && y >= cy0 - 0.5 && y < cy1 + 0.5) {
            const nx = Math.min(x - cx0, cx1 - x);
            const ny = Math.min(y - cy0, cy1 - y);
            let inside = true;
            if (nx < radius && ny < radius) {
              const dx = radius - nx;
              const dy = radius - ny;
              inside = (dx * dx + dy * dy) <= radius * radius;
            }
            if (inside) { r = 255; g = 255; b = 255; a = 235; }
          }
        }
      }
      const idx = (y * size + x) * 4;
      raw[idx] = r; raw[idx + 1] = g; raw[idx + 2] = b; raw[idx + 3] = a;
    }
  }

  // corner badge
  const RED = [214, 40, 40];
  const bcx = size * 0.76, bcy = size * 0.24, br = size * 0.28, bring = br + Math.max(1, size * 0.05);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - bcx, y + 0.5 - bcy);
      if (d <= br) {
        const idx = (y * size + x) * 4;
        raw[idx] = RED[0]; raw[idx + 1] = RED[1]; raw[idx + 2] = RED[2]; raw[idx + 3] = 255;
      } else if (d <= bring) {
        const idx = (y * size + x) * 4;
        raw[idx] = 255; raw[idx + 1] = 255; raw[idx + 2] = 255; raw[idx + 3] = 255;
      }
    }
  }
  return pngFromRaw(size, raw);
}

fs.writeFileSync(path.join(outDir, 'tray-unread.png'), drawAppIconWithDot(64, BLUE));
fs.writeFileSync(path.join(outDir, 'badge-dot.png'), drawDot(128));

// Digit overlay icons: 1..9, 9plus, dot — used with BrowserWindow#setOverlayIcon.
const overlayDir = path.join(outDir, 'overlay');
fs.mkdirSync(overlayDir, { recursive: true });
for (let n = 1; n <= 9; n++) {
  fs.writeFileSync(path.join(overlayDir, `${n}.png`), drawDigitOverlay(32, String(n)));
}
fs.writeFileSync(path.join(overlayDir, '9plus.png'), drawDigitOverlay(32, '9+'));
fs.writeFileSync(path.join(overlayDir, 'dot.png'), drawDot(32));

console.log('Icons written to', outDir);
