import { writeFileSync } from 'node:fs'

const colors = {
  red: [0xd7, 0x28, 0x2f],
  blue: [0x1c, 0x44, 0xe0],
  yellow: [0xff, 0xd5, 0x00],
  black: [0x1a, 0x1a, 0x1a],
  white: [0xf5, 0xf2, 0xec],
  surface: [0xec, 0xe9, 0xe3],
  dim: [0x4a, 0x4a, 0x4a]
}

function writeBmp(path, width, height, paint) {
  const rowSize = Math.ceil((width * 3) / 4) * 4
  const pixelDataSize = rowSize * height
  const fileSize = 54 + pixelDataSize
  const buffer = Buffer.alloc(fileSize)

  buffer.write('BM', 0, 'ascii')
  buffer.writeUInt32LE(fileSize, 2)
  buffer.writeUInt32LE(54, 10)
  buffer.writeUInt32LE(40, 14)
  buffer.writeInt32LE(width, 18)
  buffer.writeInt32LE(height, 22)
  buffer.writeUInt16LE(1, 26)
  buffer.writeUInt16LE(24, 28)
  buffer.writeUInt32LE(0, 30)
  buffer.writeUInt32LE(pixelDataSize, 34)
  buffer.writeInt32LE(2835, 38)
  buffer.writeInt32LE(2835, 42)

  for (let y = 0; y < height; y++) {
    const outY = height - 1 - y
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y, width, height)
      const offset = 54 + outY * rowSize + x * 3
      buffer[offset] = b
      buffer[offset + 1] = g
      buffer[offset + 2] = r
    }
  }

  writeFileSync(path, buffer)
  console.log(`Generated ${path} (${width}x${height})`)
}

function inRect(x, y, rx, ry, rw, rh) {
  return x >= rx && x < rx + rw && y >= ry && y < ry + rh
}

function drawGrid(x, y, w, h) {
  const line = Math.max(4, Math.round(w * 0.065))
  const left = Math.round(w * 0.43)
  const top = Math.round(h * 0.34)
  const lower = Math.round(h * 0.72)

  if (x < line || y < line || x >= w - line || y >= h - line) return colors.black
  if (x >= left && x < left + line) return colors.black
  if (y >= top && y < top + line && x < left + line) return colors.black
  if (y >= lower && y < lower + line) return colors.black
  if (x < left && y < top) return colors.red
  if (x < left && y >= lower) return colors.blue
  if (x >= left + line && y >= lower) return colors.yellow
  return colors.white
}

writeBmp('build/installerSidebar.bmp', 164, 314, (x, y, w, h) => {
  return drawGrid(x, y, w, h)
})

writeBmp('build/uninstallerSidebar.bmp', 164, 314, (x, y, w, h) => {
  const base = drawGrid(x, y, w, h)
  if (base === colors.red) return colors.blue
  if (base === colors.blue) return colors.red
  return base
})

writeBmp('build/installerHeader.bmp', 150, 57, (x, y, w, h) => {
  const line = 4
  if (y >= h - line) return colors.black
  if (x < line || y < line || x >= w - line) return colors.black
  if (inRect(x, y, 0, 0, 48, 23)) return colors.red
  if (inRect(x, y, 0, 38, 48, 19)) return colors.blue
  if (inRect(x, y, 105, 38, 45, 19)) return colors.yellow
  if (inRect(x, y, 48, 0, line, h)) return colors.black
  if (inRect(x, y, 0, 23, 52, line)) return colors.black
  if (inRect(x, y, 0, 38, w, line)) return colors.black
  if (inRect(x, y, 62, 14, 54, 6)) return colors.black
  if (inRect(x, y, 62, 26, 72, 6)) return colors.black
  return colors.white
})
