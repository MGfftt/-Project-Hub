/**
 * The app mark, rasterised in code.
 *
 * Everything here is pure: no Electron, no filesystem, no binary assets. It
 * exists because `nativeImage.createFromDataURL` decodes **PNG only** — it hands
 * the payload to `gfx::Image::CreateFrom1xPNGBytes` and ignores the declared
 * MIME type — so an SVG data URL silently yields an empty image. The tray used
 * to do exactly that and showed up as a blank square.
 *
 * Coverage is computed analytically (one sample per pixel against the shape's
 * signed distance), which is what makes a 16 px tray icon legible without
 * supersampling the whole canvas.
 */

import { deflateSync } from 'node:zlib'

/** The mark is authored in a 32-unit square and scaled to the requested size. */
const VIEW = 32

interface Rgb {
  r: number
  g: number
  b: number
}

interface MarkPalette {
  link: Rgb
  node: Rgb
  core: Rgb
  dot: Rgb
}

/** Tray marks sit on the OS-tinted tray background, so they follow the theme. */
const TRAY_LIGHT: MarkPalette = {
  link: hex('#64748b'),
  node: hex('#1e293b'),
  core: hex('#3b82f6'),
  dot: hex('#ffffff')
}
const TRAY_DARK: MarkPalette = {
  link: hex('#8ea9cc'),
  node: hex('#e8eef8'),
  core: hex('#3b82f6'),
  dot: hex('#0b1220')
}
/** The app icon has its own dark card behind it, so the links can be bright. */
const APP_PALETTE: MarkPalette = {
  link: hex('#60a5fa'),
  node: hex('#e2e8f0'),
  core: hex('#3b82f6'),
  dot: hex('#ffffff')
}

const CARD_TOP = hex('#1e293b')
const CARD_BOTTOM = hex('#0b1220')

function hex(value: string): Rgb {
  const n = Number.parseInt(value.slice(1), 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

/** Anti-aliased coverage of a disc: 1 inside, 0 outside, smooth across an edge. */
function circleCoverage(px: number, py: number, cx: number, cy: number, r: number): number {
  return clamp01(r - Math.hypot(px - cx, py - cy) + 0.5)
}

/** Coverage of a round-capped stroke between two points. */
function strokeCoverage(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  half: number
): number {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy || 1
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2))
  return clamp01(half - Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) + 0.5)
}

function roundRectCoverage(px: number, py: number, w: number, h: number, r: number): number {
  if (px < -1 || py < -1 || px > w + 1 || py > h + 1) return 0
  const cx = Math.min(Math.max(px, r), w - r)
  const cy = Math.min(Math.max(py, r), h - r)
  return clamp01(r - Math.hypot(px - cx, py - cy) + 0.5)
}

/** Source-over composite of a straight (non-premultiplied) colour. */
function blend(data: Uint8ClampedArray, i: number, c: Rgb, alpha: number): void {
  if (alpha <= 0) return
  const da = data[i + 3] / 255
  const out = alpha + da * (1 - alpha)
  if (out <= 0) return
  data[i] = (c.r * alpha + data[i] * da * (1 - alpha)) / out
  data[i + 1] = (c.g * alpha + data[i + 1] * da * (1 - alpha)) / out
  data[i + 2] = (c.b * alpha + data[i + 2] * da * (1 - alpha)) / out
  data[i + 3] = out * 255
}

function drawMark(
  data: Uint8ClampedArray,
  size: number,
  palette: MarkPalette,
  zoom = 1
): void {
  const s = (size / VIEW) * zoom
  const pad = (size - VIEW * s) / 2
  const at = (v: number): number => pad + v * s
  const core = { x: at(16), y: at(15.4), r: 5.4 * s }
  const nodes = [
    { x: at(7.5), y: at(8.5) },
    { x: at(24.5), y: at(9) },
    { x: at(16), y: at(25) }
  ]
  const nodeR = 3.1 * s
  const linkHalf = (2.6 * s) / 2
  const dotR = 2.1 * s

  for (let y = 0; y < size; y += 1) {
    const py = y + 0.5
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5
      const i = (y * size + x) * 4
      for (const n of nodes) {
        blend(data, i, palette.link, strokeCoverage(px, py, core.x, core.y, n.x, n.y, linkHalf))
      }
      for (const n of nodes) blend(data, i, palette.node, circleCoverage(px, py, n.x, n.y, nodeR))
      blend(data, i, palette.core, circleCoverage(px, py, core.x, core.y, core.r))
      blend(data, i, palette.dot, circleCoverage(px, py, core.x, core.y, dotR) * 0.92)
    }
  }
}

function cardBackground(data: Uint8ClampedArray, size: number): void {
  const radius = size * 0.22
  for (let y = 0; y < size; y += 1) {
    const t = size <= 1 ? 0 : y / (size - 1)
    const c: Rgb = {
      r: CARD_TOP.r + (CARD_BOTTOM.r - CARD_TOP.r) * t,
      g: CARD_TOP.g + (CARD_BOTTOM.g - CARD_TOP.g) * t,
      b: CARD_TOP.b + (CARD_BOTTOM.b - CARD_TOP.b) * t
    }
    for (let x = 0; x < size; x += 1) {
      const cov = roundRectCoverage(x + 0.5, y + 0.5, size, size, radius)
      if (cov > 0) blend(data, (y * size + x) * 4, c, cov)
    }
  }
}

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(type, 4, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
  return Buffer.concat([head, body, crc])
}

function encodePng(size: number, rgba: Uint8ClampedArray): Buffer {
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0 // filter: none
    Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/** Transparent-background tray mark. `dark` follows the desktop theme. */
export function renderTrayIconPng(size: number, dark = false): Buffer {
  const px = Math.max(4, Math.round(size))
  const data = new Uint8ClampedArray(px * px * 4)
  drawMark(data, px, dark ? TRAY_DARK : TRAY_LIGHT)
  return encodePng(px, data)
}

/** The rounded-square app icon: window icon, and the source of `build/icon.png`. */
export function renderAppIconPng(size: number): Buffer {
  const px = Math.max(16, Math.round(size))
  const data = new Uint8ClampedArray(px * px * 4)
  cardBackground(data, px)
  // Inset so the outer nodes do not touch the rounded corners.
  drawMark(data, px, APP_PALETTE, 0.86)
  return encodePng(px, data)
}
