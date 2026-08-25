/**
 * Color contrast utilities (WCAG 2.1).
 *
 * Pure functions — no DOM access, unit-testable in Node/Bun. Used by the chat
 * client to keep user-chosen nickname / message colors readable against the
 * active theme background.
 */

export type RGB = [number, number, number]

/**
 * Parses a 3- or 6-digit hex color (with or without leading `#`).
 * Returns null for any malformed input.
 */
export function parseHex(hex: unknown): RGB | null {
  if (typeof hex !== 'string') return null
  let h = hex.trim().replace(/^#/, '')
  if (h.length === 3) {
    h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  }
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ]
}

/** WCAG relative luminance of an sRGB triple (0..255). */
export function relativeLuminance([r, g, b]: RGB): number {
  const lin = (c: number): number => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** WCAG contrast ratio between two colors (1..21). */
export function contrastRatio(a: RGB, b: RGB): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const lighter = Math.max(la, lb)
  const darker = Math.min(la, lb)
  return (lighter + 0.05) / (darker + 0.05)
}

export interface HSL {
  h: number
  s: number
  l: number
}

/** Converts an RGB triple to HSL (h: 0..1, s: 0..1, l: 0..1). */
export function rgbToHsl([r, g, b]: RGB): HSL {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  let h = 0
  let s = 0
  const d = max - min
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    switch (max) {
      case rn:
        h = (gn - bn) / d + (gn < bn ? 6 : 0)
        break
      case gn:
        h = (bn - rn) / d + 2
        break
      default:
        h = (rn - gn) / d + 4
        break
    }
    h /= 6
  }
  return { h, s, l }
}

/** Converts HSL (h/s/l in 0..1) back to a normalized 6-digit `#rrggbb`. */
export function hslToHex(h: number, s: number, l: number): string {
  let r: number
  let g: number
  let b: number
  if (s === 0) {
    r = g = b = l
  } else {
    const hue2rgb = (p: number, q: number, t: number): number => {
      let tt = t
      if (tt < 0) tt += 1
      if (tt > 1) tt -= 1
      if (tt < 1 / 6) return p + (q - p) * 6 * tt
      if (tt < 1 / 2) return q
      if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
      return p
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    r = hue2rgb(p, q, h + 1 / 3)
    g = hue2rgb(p, q, h)
    b = hue2rgb(p, q, h - 1 / 3)
  }
  const toHex = (x: number): string =>
    Math.round(x * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

/**
 * Returns a readable variant of `hex` against `bgHex`.
 *
 * - If the contrast ratio is already ≥ 4.5:1, `hex` is returned unchanged.
 * - Otherwise the hue/saturation are preserved and the HSL lightness is nudged
 *   *away* from the background's lightness (toward black or white) in 2% steps
 *   until the ratio is met or a boundary (0/1) is hit.
 * - If even at the boundary the ratio is still < 4.5:1, `fallback` is returned
 *   (the theme's default text color).
 *
 * Any malformed hex input short-circuits to `fallback`.
 */
export function readableColor(hex: string, bgHex: string, fallback = '#000000'): string {
  const fg = parseHex(hex)
  const bg = parseHex(bgHex)
  if (!fg || !bg) return fallback
  if (contrastRatio(fg, bg) >= 4.5) return hex

  const fgHsl = rgbToHsl(fg)
  const bgL = rgbToHsl(bg).l
  // Move away from the background luminance to maximize the gap.
  const dir = fgHsl.l >= bgL ? 1 : -1

  let l = fgHsl.l
  let last = hex
  // 2% steps; 50 iterations cover the full 0..1 range.
  for (let i = 0; i < 50; i++) {
    const next = l + dir * 0.02
    if (next < 0 || next > 1) break
    l = next
    const cand = hslToHex(fgHsl.h, fgHsl.s, l)
    last = cand
    if (contrastRatio(parseHex(cand)!, bg) >= 4.5) return cand
  }
  return fallback
}
