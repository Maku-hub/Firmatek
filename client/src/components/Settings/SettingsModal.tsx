import { useState, useEffect } from 'react'
import { enable as enableAutostart, disable as disableAutostart, isEnabled as isAutostartEnabled } from '@tauri-apps/plugin-autostart'
import { t, getLocale, setLocale, LOCALES } from '../../i18n'

interface Settings {
  uiScale: number
  sendOnEnter: boolean
  notifSound: boolean
}

const DEFAULT: Settings = { uiScale: 100, sendOnEnter: true, notifSound: true }
const STORAGE_KEY = 'firmatek_settings'

export function loadSettings(): Settings {
  if (cached) return cached
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    cached = raw ? { ...DEFAULT, ...JSON.parse(raw) } : DEFAULT
  } catch {
    cached = DEFAULT
  }
  return cached!
}

// Read on every keystroke in the chat input, so keep a parsed copy around.
let cached: Settings | null = null

function saveSettings(s: Settings) {
  cached = s
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)) } catch { /* storage full or disabled */ }
}

// Scales only the main app wrapper (not the login screen)
export function applyScale(scale: number) {
  const wrapper = document.getElementById('app-wrapper')
  if (!wrapper) return
  const pct = scale / 100

  // Reset
  wrapper.style.transform = ''
  wrapper.style.width = ''
  wrapper.style.height = ''
  wrapper.style.transformOrigin = ''
  wrapper.style.overflow = ''
  ;(wrapper.style as any).zoom = ''

  if (pct === 1) {
    wrapper.style.width = '100%'
    wrapper.style.height = '100%'
    return
  }

  // Prefer CSS zoom – preserves layout, scrollbars and interactivity
  // (works in Chromium/WebView2/WebKitGTK, i.e. across all Tauri environments)
  if ('zoom' in document.documentElement.style) {
    ;(wrapper.style as any).zoom = pct
    wrapper.style.width = '100%'
    wrapper.style.height = '100%'
  } else {
    // Fallback: transform scale (Firefox, etc.)
    wrapper.style.transformOrigin = 'top left'
    wrapper.style.transform = `scale(${pct})`
    wrapper.style.width = `${100 / pct}%`
    wrapper.style.height = `${100 / pct}%`
    wrapper.style.overflow = 'hidden'
  }
}

interface Props { onClose: () => void }

export default function SettingsModal({ onClose }: Props) {
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [autostart, setAutostart] = useState(false)
  const [autostartLoading, setAutostartLoading] = useState(true)

  useEffect(() => {
    applyScale(settings.uiScale)
    saveSettings(settings)
  }, [settings])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    isAutostartEnabled()
      .then(setAutostart)
      .catch(() => {})
      .finally(() => setAutostartLoading(false))
  }, [])

  const toggleAutostart = async () => {
    try {
      if (autostart) { await disableAutostart() } else { await enableAutostart() }
      setAutostart(!autostart)
    } catch { /* plugin unavailable */ }
  }

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setSettings((prev) => ({ ...prev, [key]: value }))

  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={s.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={t('settings.title')}>
        <div style={s.header}>
          <span style={s.title}>{t('settings.title')}</span>
          <button style={s.closeBtn} onClick={onClose} aria-label={t('settings.done')}>✕</button>
        </div>

        <section style={s.section}>
          <div style={s.sectionTitle}>{t('settings.appearance')}</div>
          <div style={s.row}>
            <span style={s.label}>{t('settings.uiScale')}</span>
            <span style={s.value}>{settings.uiScale}%</span>
          </div>
          <input type="range" min={75} max={200} step={25}
            value={settings.uiScale}
            onChange={(e) => update('uiScale', Number(e.target.value))}
            style={s.slider} />
          <div style={s.scaleMarks}>
            {[75, 100, 125, 150, 175, 200].map((v) => (
              <span key={v}
                style={{ ...s.mark, color: settings.uiScale === v ? '#6366f1' : '#555', fontWeight: settings.uiScale === v ? 700 : 400 }}
                onClick={() => update('uiScale', v)}>
                {v}%
              </span>
            ))}
          </div>
          <div style={{ color: '#555', fontSize: 11, marginTop: 8 }}>
            {t('settings.scaleHint')}
          </div>
        </section>

        <section style={s.section}>
          <div style={s.sectionTitle}>{t('settings.keyboard')}</div>
          <label style={s.checkRow}>
            <input type="radio" checked={settings.sendOnEnter}
              onChange={() => update('sendOnEnter', true)} />
            <div>
              <div style={s.label}>{t('settings.enterSend')}</div>
              <div style={s.hint}>{t('settings.shiftEnterNewline')}</div>
            </div>
          </label>
          <label style={{ ...s.checkRow, marginTop: 8 }}>
            <input type="radio" checked={!settings.sendOnEnter}
              onChange={() => update('sendOnEnter', false)} />
            <div>
              <div style={s.label}>{t('settings.ctrlEnterSend')}</div>
              <div style={s.hint}>{t('settings.enterNewline')}</div>
            </div>
          </label>
        </section>

        <section style={s.section}>
          <div style={s.sectionTitle}>{t('settings.notifications')}</div>
          <label style={s.checkRow}>
            <input type="checkbox" checked={settings.notifSound}
              onChange={(e) => update('notifSound', e.target.checked)} />
            <span style={s.label}>{t('settings.soundNewMessage')}</span>
          </label>
        </section>

        <section style={s.section}>
          <div style={s.sectionTitle}>{t('settings.system')}</div>
          <label style={s.checkRow}>
            <input type="checkbox" checked={autostart} disabled={autostartLoading}
              onChange={toggleAutostart} />
            <div>
              <div style={s.label}>{t('settings.launchStartup')}</div>
              <div style={s.hint}>{t('settings.launchHint')}</div>
            </div>
          </label>
        </section>

        <section style={s.section}>
          <div style={s.sectionTitle}>{t('settings.language')}</div>
          <select
            style={{ ...s.label, background: '#252535', border: '1px solid #333', borderRadius: 6, padding: '6px 10px' }}
            value={getLocale()}
            onChange={(e) => { setLocale(e.target.value as typeof LOCALES[number]); window.location.reload() }}>
            {LOCALES.map((l) => (
              <option key={l} value={l}>{l === 'en' ? 'English' : 'Polski'}</option>
            ))}
          </select>
        </section>

        <div style={s.footer}>
          <button style={s.resetBtn} onClick={() => setSettings(DEFAULT)}>{t('settings.restoreDefaults')}</button>
          <button style={s.doneBtn} onClick={onClose}>{t('settings.done')}</button>
        </div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
  modal: { background: '#1a1a24', borderRadius: 14, width: 420, maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 40px)', overflowY: 'auto', boxShadow: '0 24px 60px rgba(0,0,0,0.6)', border: '1px solid #2a2a3e' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '18px 22px', borderBottom: '1px solid #2a2a3e' },
  title: { color: '#fff', fontWeight: 700, fontSize: 15 },
  closeBtn: { background: 'transparent', border: 'none', color: '#666', cursor: 'pointer', fontSize: 16 },
  section: { padding: '16px 22px', borderBottom: '1px solid #1e1e30' },
  sectionTitle: { color: '#555', fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', marginBottom: 12 },
  row: { display: 'flex', justifyContent: 'space-between', marginBottom: 6 },
  label: { color: '#ccc', fontSize: 14 },
  value: { color: '#6366f1', fontWeight: 700, fontSize: 14 },
  hint: { color: '#666', fontSize: 12, marginTop: 2 },
  slider: { width: '100%', accentColor: '#6366f1', cursor: 'pointer' },
  scaleMarks: { display: 'flex', justifyContent: 'space-between', marginTop: 4 },
  mark: { fontSize: 11, cursor: 'pointer', userSelect: 'none' },
  checkRow: { display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', padding: '4px 0' },
  footer: { display: 'flex', justifyContent: 'space-between', padding: '16px 22px' },
  resetBtn: { background: 'transparent', border: '1px solid #333', borderRadius: 8, color: '#888', cursor: 'pointer', padding: '8px 16px', fontSize: 13 },
  doneBtn: { background: '#6366f1', border: 'none', borderRadius: 8, color: '#fff', cursor: 'pointer', padding: '8px 20px', fontSize: 13, fontWeight: 600 },
}
