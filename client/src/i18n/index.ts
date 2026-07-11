import { messages, type Locale, type MessageKey } from './messages'

const STORAGE_KEY = 'firmatek_locale'
export const LOCALES: Locale[] = ['en', 'pl']

let current: Locale = detectLocale()

function detectLocale(): Locale {
  const saved = (typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY)) as Locale | null
  if (saved && LOCALES.includes(saved)) return saved
  const nav = typeof navigator !== 'undefined' ? navigator.language.slice(0, 2) : 'en'
  return (LOCALES as string[]).includes(nav) ? (nav as Locale) : 'en'
}

export function getLocale(): Locale {
  return current
}

export function setLocale(locale: Locale) {
  current = locale
  try { localStorage.setItem(STORAGE_KEY, locale) } catch { /* ignore */ }
}

// t(key, params?) — looks up the current locale, falls back to English, then to
// the key itself. Supports {placeholder} interpolation.
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const table = messages[current] as Record<string, string>
  const fallback = messages.en as Record<string, string>
  let str = table[key] ?? fallback[key] ?? key
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
    }
  }
  return str
}
