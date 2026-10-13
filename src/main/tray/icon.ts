/**
 * Tray icon, drawn in code.
 *
 * Rendering an SVG through Chromium's own image pipeline means the app ships no
 * binary assets at all (§5 keeps icons generated), while still getting crisp
 * anti-aliased edges at every DPI. The glyph is the app's own mark: three child
 * nodes joined to one hub, which is literally what the product does.
 */

import { nativeImage, type NativeImage } from 'electron'
import { renderAppIconPng, renderTrayIconPng } from '../icon/render'

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
 * `nativeImage.createFromDataURL` decodes PNG only — Electron hands the payload
 * to `gfx::Image::CreateFrom1xPNGBytes` and ignores the declared MIME type — so
 * feeding it the SVG above produced an empty image and the tray showed a blank
 * square. The mark is rasterised here instead (see `icon/render.ts`).
 *
 * A 2× representation is attached so the icon stays sharp on a HiDPI tray; if
 * the platform rejects it the 16 px buffer on its own is still correct.
 */
export function createTrayIcon(dark = false): NativeImage {
  try {
    const image = nativeImage.createFromBuffer(renderTrayIconPng(16, dark))
    if (!image.isEmpty()) {
      try {
        image.addRepresentation({
          scaleFactor: 2,
          width: 32,
          height: 32,
          buffer: renderTrayIconPng(32, dark)
        })
      } catch {
        /* a single representation is enough */
      }
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
 * The app icon as an image the window can carry.
 *
 * Windows takes the taskbar and Task Manager icons from the executable, which
 * the packer stamps from `build/icon.ico`; this covers development, where the
 * running executable is Electron's own.
 */
export function createAppIcon(): NativeImage {
  try {
    const image = nativeImage.createFromBuffer(renderAppIconPng(256))
    if (!image.isEmpty()) {
      try {
        image.addRepresentation({ scaleFactor: 2, width: 512, height: 512, buffer: renderAppIconPng(512) })
      } catch {
        /* a single representation is enough */
      }
      return image
    }
  } catch {
    /* fall through */
  }
  return nativeImage.createEmpty()
}

/**
 * The same mark at a larger size, used by the renderer's empty states and by
 * `app.setAboutPanelOptions` on macOS.
 */
export function appMarkSvg(size = 128): string {
  return trayIconSvg(false).replace(/width="32" height="32"/, `width="${size}" height="${size}"`)
}
