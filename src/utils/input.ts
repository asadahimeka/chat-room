import xss from 'xss'
import filter from './filter'

export const REGEX_HEX_COLOR = /^#(?:[0-9a-fA-F]{3,4}){1,2}$/

export function processInput(source: string, flag?: boolean): string {
  if (flag) source = xss(source)

  return filter(source)
}

export function getCookie(cookieHeader: string | undefined, name: string): string {
  let cookie = `; ${cookieHeader}`
  const parts = cookie.split(`; ${name}=`)
  if (parts.length === 2) {
    try {
      return decodeURIComponent(parts.pop()!.split(';').shift()!)
    } catch {
      return 'wrong_name'
    }
  }
  return ''
}

export function sanitizeColor(value: string | undefined, fallback: string): string {
  return value !== undefined && REGEX_HEX_COLOR.test(value) ? value : fallback
}

export function sanitizeName(value: string): string {
  return value.trim().substring(0, 32)
}

export function sanitizeUid(value: string): string {
  return value.trim().substring(0, 7)
}

export function sanitizeMsg(value: string): string {
  return value.trim().substring(0, 1000)
}

export function genGuestName(): string {
  return `user_${Math.random().toString(36).substr(2, 5)}`
}