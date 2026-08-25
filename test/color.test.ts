import { describe, expect, test } from 'bun:test'
import {
  contrastRatio,
  hslToHex,
  parseHex,
  readableColor,
  rgbToHsl,
} from '../src/utils/color'

describe('parseHex', () => {
  test('parses 6-digit hex with leading #', () => {
    expect(parseHex('#ff0000')).toEqual([255, 0, 0])
  })
  test('parses 6-digit hex without #', () => {
    expect(parseHex('00ff00')).toEqual([0, 255, 0])
  })
  test('parses 3-digit hex by expansion', () => {
    expect(parseHex('#abc')).toEqual([0xaa, 0xbb, 0xcc])
  })
  test('returns null for malformed input', () => {
    expect(parseHex('#xyz')).toBeNull()
    expect(parseHex('#12')).toBeNull()
    expect(parseHex('nope')).toBeNull()
    expect(parseHex(123 as unknown)).toBeNull()
  })
})

describe('contrastRatio', () => {
  test('black on white is maximal (~21:1)', () => {
    expect(contrastRatio(parseHex('#000000')!, parseHex('#ffffff')!)).toBeCloseTo(21, 0)
  })
  test('identical colors have ratio 1', () => {
    expect(contrastRatio(parseHex('#777777')!, parseHex('#777777')!)).toBeCloseTo(1, 5)
  })
})

describe('rgbToHsl / hslToHex round-trip', () => {
  test('white round-trips', () => {
    const hsl = rgbToHsl(parseHex('#ffffff')!)
    expect(hsl.l).toBeCloseTo(1, 5)
    expect(hslToHex(hsl.h, hsl.s, hsl.l)).toBe('#ffffff')
  })
  test('black round-trips', () => {
    const hsl = rgbToHsl(parseHex('#000000')!)
    expect(hsl.l).toBeCloseTo(0, 5)
    expect(hslToHex(hsl.h, hsl.s, hsl.l)).toBe('#000000')
  })
})

describe('readableColor', () => {
  test('returns the input unchanged when contrast already meets WCAG AA', () => {
    // Pure black on pure white → 21:1, well above 4.5:1.
    expect(readableColor('#000000', '#ffffff')).toBe('#000000')
  })

  test('returns a 3-digit input unchanged when contrast is sufficient', () => {
    expect(readableColor('#000', '#fff')).toBe('#000')
  })

  test('lightens a dark color on a dark background until readable', () => {
    const bg = '#000000'
    const fg = '#333333' // dark gray on black — low contrast
    const out = readableColor(fg, bg)
    expect(out).not.toBe(fg)
    // Result must actually be readable now.
    expect(contrastRatio(parseHex(out)!, parseHex(bg)!)).toBeGreaterThanOrEqual(4.5)
    // And it was lightened (higher luminance than the input).
    expect(rgbToHsl(parseHex(out)!).l).toBeGreaterThan(rgbToHsl(parseHex(fg)!).l)
  })

  test('darkens a light color on a light background until readable', () => {
    const bg = '#ffffff'
    const fg = '#eeeeee' // near-white on white — low contrast
    const out = readableColor(fg, bg)
    expect(out).not.toBe(fg)
    expect(contrastRatio(parseHex(out)!, parseHex(bg)!)).toBeGreaterThanOrEqual(4.5)
    expect(rgbToHsl(parseHex(out)!).l).toBeLessThan(rgbToHsl(parseHex(fg)!).l)
  })

  test('returns the fallback for a malformed foreground color', () => {
    expect(readableColor('not-a-color', '#ffffff', '#123456')).toBe('#123456')
  })

  test('returns the fallback when the background color is malformed', () => {
    expect(readableColor('#000000', 'notacolor', '#abcdef')).toBe('#abcdef')
  })

  test('uses the default fallback (#000000) when none is supplied', () => {
    expect(readableColor('garbage', '#fff')).toBe('#000000')
  })

  test('preserves hue while adjusting lightness (same hue bucket)', () => {
    // A saturated blue that is too dark on black should stay blue, just lighter.
    const bg = '#000000'
    const fg = '#000080' // dark blue
    const out = readableColor(fg, bg)
    const hsl = rgbToHsl(parseHex(out)!)
    // Blue hue is around 240° (0.667 in 0..1). Allow a small shift tolerance.
    expect(hsl.h).toBeCloseTo(240 / 360, 1)
  })
})
