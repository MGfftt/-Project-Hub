#!/usr/bin/env node
/**
 * Generates `build/icon.ico` and `build/icon.png` from the same three-hub mark
 * the tray uses (`src/main/tray/icon.ts`), so the packaged app has its own icon
 * instead of Electron's default.
 *
 * No image library is used: the mark is drawn analytically into an RGBA buffer
 * with 4x supersampling, encoded as PNG through `node:zlib`, and wrapped in an
 * ICO container. That keeps the dependency count at zero for build-time art.
 *
 *   node scripts/make-icon.mjs
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'build')
const SIZES = [16, 24, 32, 48, 64, 128, 256]
const SS = 4 // supersampling factor per axis

// Geometry lifted from the 32x32 tray viewBox so both marks stay recognisable.
const VIEW = 32
const CENTER = [16, 15.4]
const NODES = [
  [7.5, 8.5],
  [24.5, 9],
  [16, 25]
]

const inRoundedRect = (x, y, size, radius) => {
  const r = radius
  if (x < 0 || y < 0 || x > size || y > size) return false
  const cx = Math.min(Math.max(x, r), size - r)
  const cy = Math.min(Math.max(y, r), size - r)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= r * r || (x >= r && x <= size - r) || (y >= r && y <= size - r)
}

const mix = (a, b, t) => a + (b - a) * t

/** Paints one supersampled sample and returns [r,g,b,a] with a in 0..255. */
const sample = (px, py, size) => {
  const u = px / size
  const v = py / size
  const s = size / VIEW // viewBox units -> pixels
  const at = (p) => [p[0] * s, p[1] * s]

  // Background: rounded square with a diagonal slate gradient.
  if (!inRoundedRect(u, v, 1, 0.22)) return [0, 0, 0, 0]
  const t = Math.min(1, Math.max(0, (u + v) / 2))
  let col = [mix(0x1e, 0x0b, t), mix(0x29, 0x12, t), mix(0x3b, 0x20, t)]

  const [cx, cy] = at(CENTER)
  const stroke = size * 0.055

  // Connecting links.
  for (const n of NODES) {
    const [nx, ny] = at(n)
    const dx = nx - cx
    const dy = ny - cy
    const len2 = dx * dx + dy * dy
    const proj = ((px - cx) * dx + (py - cy) * dy) / len2
    const tc = Math.min(1, Math.max(0, proj))
    const qx = cx + dx * tc
    const qy = cy + dy * tc
    if (Math.hypot(px - qx, py - qy) <= stroke / 2) col = [0x60, 0xa5, 0xfa]
  }

  // Outer nodes.
  for (const n of NODES) {
    const [nx, ny] = at(n)
    if (Math.hypot(px - nx, py - ny) <= size * 0.085) col = [0xe2, 0xe8, 0xf0]
  }

  // Blue core with its white centre dot.
  const dc = Math.hypot(px - cx, py - cy)
  if (dc <= size * 0.17) col = [0x3b, 0x82, 0xf6]
  if (dc <= size * 0.055) col = [0xff, 0xff, 0xff]

  return [col[0], col[1], col[2], 255]
}

/** Renders `size`x`size` RGBA with SS x SS supersampling. */
const render = (size) => {
  const out = Buffer.alloc(size * size * 4)
  const step = 1 / SS
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [sr, sg, sb, sa] = sample(x + (sx + 0.5) * step, y + (sy + 0.5) * step, size)
          const w = sa / 255
          r += sr * w
          g += sg * w
          b += sb * w
          a += sa
        }
      }
      const n = SS * SS
      const alpha = a / n
      const cover = alpha / 255
      const i = (y * size + x) * 4
      // Premultiplied average, then un-premultiplied for straight-alpha PNG.
      out[i] = cover > 0 ? Math.round(r / n / cover) : 0
      out[i + 1] = cover > 0 ? Math.round(g / n / cover) : 0
      out[i + 2] = cover > 0 ? Math.round(b / n / cover) : 0
      out[i + 3] = Math.round(alpha)
    }
  }
  return out
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

const crc32 = (buf) => {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

const encodePng = (rgba, size) => {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/**
 * A 32-bit BMP (DIB) entry.
 *
 * Windows' classic icon APIs — `ExtractIconEx`, `LoadImage`, the shell's icon
 * cache — cannot decode a PNG entry, they only accept a BITMAPINFOHEADER with
 * the bitmap stored bottom-up. GDI+ throws "Requested range extends past the
 * end of the array" on a PNG entry it cannot parse, so an all-PNG ICO renders
 * blank wherever those APIs are used. Only the 256 px slot is PNG, where the
 * format is both blessed and necessary.
 */
const encodeDib = (rgba, size) => {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8) // XOR bitmap plus the AND mask
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(0, 16)
  const xor = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size * 4
    const dst = y * size * 4
    for (let x = 0; x < size; x++) {
      xor[dst + x * 4] = rgba[src + x * 4 + 2]
      xor[dst + x * 4 + 1] = rgba[src + x * 4 + 1]
      xor[dst + x * 4 + 2] = rgba[src + x * 4]
      xor[dst + x * 4 + 3] = rgba[src + x * 4 + 3]
    }
  }
  const maskStride = Math.ceil(size / 32) * 4
  return Buffer.concat([header, xor, Buffer.alloc(maskStride * size)])
}

/** ICO container: one directory entry per size, offsets after the header. */
const encodeIco = (images) => {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  const dir = Buffer.alloc(16 * images.length)
  let offset = header.length + dir.length
  images.forEach(({ size, data }, i) => {
    const e = i * 16
    dir[e] = size >= 256 ? 0 : size
    dir[e + 1] = size >= 256 ? 0 : size
    dir[e + 2] = 0
    dir[e + 3] = 0
    dir.writeUInt16LE(1, e + 4)
    dir.writeUInt16LE(32, e + 6)
    dir.writeUInt32LE(data.length, e + 8)
    dir.writeUInt32LE(offset, e + 12)
    offset += data.length
  })
  return Buffer.concat([header, dir, ...images.map((i) => i.data)])
}

const images = SIZES.map((size) => {
  const rgba = render(size)
  return size >= 256 ? { size, data: encodePng(rgba, size) } : { size, data: encodeDib(rgba, size) }
})
mkdirSync(OUT_DIR, { recursive: true })
const icoPath = join(OUT_DIR, 'icon.ico')
writeFileSync(icoPath, encodeIco(images))
const pngPath = join(OUT_DIR, 'icon.png')
writeFileSync(pngPath, encodePng(render(256), 256))
console.log(
  `make-icon: ${SIZES.join(',')} -> ${icoPath} (${images.reduce((n, i) => n + i.data.length, 0)} bytes) and icon.png`
)
