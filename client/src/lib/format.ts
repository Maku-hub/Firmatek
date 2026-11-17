import { getLocale } from '../i18n'

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** "14:05" for today, "3 Mar 14:05" for older messages. */
export function formatMessageTime(iso: string): string {
  const date = new Date(iso)
  const time = date.toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit' })
  if (isSameDay(date, new Date())) return time
  const day = date.toLocaleDateString(getLocale(), {
    day: 'numeric',
    month: 'short',
    year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  })
  return `${day} ${time}`
}
