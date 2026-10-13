/**
 * Tray icon, drawn in code.
 *
 * Rendering an SVG through Chromium's own image pipeline means the app ships no
 * binary assets at all (§5 keeps icons generated), while still getting crisp
 * anti-aliased edges at every DPI. The glyph is the app's own mark: three child
 * nodes joined to one hub, which is literally what the product does.
 */

import { nativeImage, type NativeImage } from 'electron'

const ACCENT = '#3b82f6'
const CORE_DARK = '#e8eef8'
const CORE_LIGHT = '#1e293b'
const LINK_DARK = '#8ea9cc'
const LINK_LIGHT = '#64748b'

/** SVG source for the tray mark. `size` is the nominal square edge in px. */
export function trayIconSvg(dark = false): string {
  const core = dark ? CORE_DARK : CORE_LIGHT
  const link = dark ? LINK_DARK : LINK_LIGHT
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <g fill="none" stroke="${link}" stroke-width="2.6" stroke-linecap="round">
    <path d="M16 16 L7.5 8.5"/>
    <path d="M16 16 L24.5 9"/>
    <path d="M16 16 L16 25"/>
  </g>
  <g fill="${core}">
    <circle cx="7.5" cy="8.5" r="3.1"/>
    <circle cx="24.5" cy="9" r="3.1"/>
    <circle cx="16" cy="25" r="3.1"/>
  </g>
  <circle cx="16" cy="15.4" r="5.4" fill="${ACCENT}"/>
  <circle cx="16" cy="15.4" r="2.1" fill="${dark ? '#0b1220' : '#ffffff'}" opacity="0.92"/>
</svg>`
}

/**
 * Build the tray `NativeImage`.
 *
 * `createFromDataURL` is synchronous and cannot fail on a malformed string (it
 * yields an empty image), so the size is asserted and a 1×1 fallback keeps
 * `new Tray(...)` from throwing on an exotic platform.
 */
export function createTrayIcon(dark = false): NativeImage {
  try {
    const image = nativeImage.createFromDataURL(
      `data:image/svg+xml;base64,${Buffer.from(trayIconSvg(dark), 'utf8').toString('base64')}`
    )
    if (!image.isEmpty()) {
      const sized = image.resize({ width: 16, height: 16 })
      if (!sized.isEmpty()) return sized
      return image
    }
  } catch {
    /* fall through to the placeholder below */
  }
  return nativeImage.createFromDataURL(
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  )
}

/**
 * The same mark at a larger size, used by the renderer's empty states and by
 * `app.setAboutPanelOptions` on macOS.
 */
export function appMarkSvg(size = 128): string {
  return trayIconSvg(false).replace(/width="32" height="32"/, `width="${size}" height="${size}"`)
}
