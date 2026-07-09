/**
 * Generate a 512x512 PNG icon without any native dependencies.
 * Pure Node.js using zlib. Produces a violet→cyan gradient with a white "M".
 */
import zlib from 'node:zlib'
import { writeFileSync } from 'node:fs'

const W = 512, H = 512

// Pixel buffer: RGBA, 4 bytes per pixel.
const pixels = Buffer.alloc(W * H * 4)

/** Linear interpolation. */
const lerp = (a, b, t) => Math.round(a + (b - a) * t)

/** Rounded rectangle check (for the rounded corners). */
function inRoundedRect(x, y, rx, ry, rw, rh, radius) {
  if (x < rx || x >= rx + rw || y < ry || y >= ry + rh) return false
  // Check corners.
  const cx = x - rx, cy = y - ry
  const inCorner = (ccx, ccy) => {
    const dx = ccx < radius ? radius - ccx : (ccx > rw - radius ? ccx - (rw - radius) : 0)
    const dy = ccy < radius ? radius - ccy : (ccy > rh - radius ? ccy - (rh - radius) : 0)
    return dx * dx + dy * dy <= radius * radius
  }
  if (cx < radius && cy < radius && !inCorner(cx, cy)) return false
  if (cx > rw - radius && cy < radius && !inCorner(cx, cy)) return false
  if (cx < radius && cy > rh - radius && !inCorner(cx, cy)) return false
  if (cx > rw - radius && cy > rh - radius && !inCorner(cx, cy)) return false
  return true
}

/** Check if a point is inside the "M" shape (simplified polygon). */
function inM(x, y) {
  // M polygon vertices (matches the SVG path).
  // M: 152,168 L 256,296 L 360,168 L 360,344 L 324,344 L 324,244 L 256,340 L 188,244 L 188,344 L 152,344 Z
  // Use a simple point-in-polygon test.
  const poly = [
    [152, 168], [256, 296], [360, 168], [360, 344],
    [324, 344], [324, 244], [256, 340], [188, 244], [188, 344], [152, 344]
  ]
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1]
    const xj = poly[j][0], yj = poly[j][1]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const idx = (y * W + x) * 4
    // Rounded rect mask: only draw inside the rounded square.
    if (!inRoundedRect(x, y, 0, 0, W, H, 112)) {
      // Transparent.
      pixels[idx] = 0; pixels[idx + 1] = 0; pixels[idx + 2] = 0; pixels[idx + 3] = 0
      continue
    }
    // Gradient: violet #7C3AED (124,58,237) → cyan #0891B2 (8,145,178).
    // Diagonal: t = (x + y) / (W + H).
    const t = (x + y) / (W + H)
    let r = lerp(124, 8, t)
    let g = lerp(58, 145, t)
    let b = lerp(237, 178, t)
    // Glass highlight on top half: overlay white with decreasing opacity.
    if (y < 256) {
      const glassT = 1 - (y / 256) // 1 at top, 0 at middle.
      const glassAlpha = glassT * 0.35
      r = lerp(r, 255, glassAlpha)
      g = lerp(g, 255, glassAlpha)
      b = lerp(b, 255, glassAlpha)
    }
    // White "M" mark.
    if (inM(x, y)) {
      r = 255; g = 255; b = 255
    }
    pixels[idx] = r
    pixels[idx + 1] = g
    pixels[idx + 2] = b
    pixels[idx + 3] = 255
  }
}

// --- Encode PNG manually ---
// PNG = signature + IHDR + IDAT + IEND.
function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1))
  }
  return ~c >>> 0
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32BE(data.length, 0)
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf])
}

const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0)
ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8   // bit depth
ihdr[9] = 6   // color type (RGBA)
ihdr[10] = 0  // compression
ihdr[11] = 0  // filter
ihdr[12] = 0  // interlace

// Raw pixel data with filter byte (0) per scanline.
const raw = Buffer.alloc((W * 4 + 1) * H)
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0 // filter: none
  pixels.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4)
}
const idat = zlib.deflateSync(raw, { level: 9 })

const png = Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0))
])

writeFileSync('build/icon.png', png)
console.log(`Generated build/icon.png (${png.length} bytes)`)
