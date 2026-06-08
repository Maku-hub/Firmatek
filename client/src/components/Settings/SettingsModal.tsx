import { useState, useEffect } from 'react'
import { enable as enableAutostart, disable as disableAutostart, isEnabled as isAutostartEnabled } from '@tauri-apps/plugin-autostart'

interface Settings {
  uiScale: number
  sendOnEnter: boolean
  notifSound: boolean
}

const DEFAULT: Settings = { uiScale: 100, sendOnEnter: true, notifSound: true }
const STORAGE_KEY = 'firmatek_settings'

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? { ...DEFAULT, ...JSON.parse(raw) } : DEFAULT
  } catch { return DEFAULT }
}

function saveSettings(s: Settings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
}

// Skaluje tylko wrapper głównej aplikacji (nie ekran logowania)
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

  // Preferuj CSS zoom – zachowuje layout, scrollbary i interaktywność
  // (działa w Chromium/WebView2/WebKitGTK, czyli we wszystkich środowiskach Tauri)
  if ('zoom' in document.documentElement.style) {
    ;(wrapper.style as any).zoom = pct
    wrapper.style.width = '100%'
    wrapper.style.height = '100%'
  } else {
    // Fallback: transform scale (Firefox itp.)
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

  // Pobierz aktualny stan autostartu
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
    } catch { /* plugin niedostępny */ }
  }

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setSettings((prev) => ({ ...prev, [key]: value }))

  return (
    <div style={s.overlay} onClick={onClose}>
      <div style={s.modal} onClick={(e) => e.stopPropagation()}>
        <div style={s.header}>
          <span style={s.title}>⚙️ Ustawienia</span>
          <button style={s.closeBtn} onClick={onClose}>✕</button>
        </div>

        <section style={s.section}>
          <div style={s.sectionTitle}>WYGLĄD</div>
          <div style={s.row}>
            <span style={s.label}>Skala interfejsu</span>
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
            Skalowanie powiększa wszystkie elementy (do użytku przez osoby niedowidzące)
          </div>
        </section>

        <section style={s.section}>
          <div style={s.sectionTitle}>KLAWIATURA</div>
          <label style={s.checkRow}>
            <input type="radio" checked={settings.sendOnEnter}
              onChange={() => update('sendOnEnter', true)} />
            <div>
              <div style={s.label}>Enter = wyślij wiadomość</div>
              <div style={s.hint}>Shift+Enter = nowa linia</div>
            </div>
          </label>
          <label style={{ ...s.checkRow, marginTop: 8 }}>
            <input type="radio" checked={!settings.sendOnEnter}
              onChange={() => update('sendOnEnter', false)} />
            <div>
              <div style={s.label}>Ctrl+Enter = wyślij wiadomość</div>
              <div style={s.hint}>Enter = nowa linia</div>
            </div>
          </label>
        </section>

        <section style={s.section}>
          <div style={s.sectionTitle}>POWIADOMIENIA</div>
          <label style={s.checkRow}>
            <input type="checkbox" checked={settings.notifSound}
              onChange={(e) => update('notifSound', e.target.checked)} />
            <span style={s.label}>Dźwięk przy nowej wiadomości</span>
          </label>
        </section>

        <section style={s.section}>
          <div style={s.sectionTitle}>SYSTEM</div>
          <label style={s.checkRow}>
            <input type="checkbox" checked={autostart} disabled={autostartLoading}
              onChange={toggleAutostart} />
            <div>
              <div style={s.label}>Uruchamiaj przy starcie systemu</div>
              <div style={s.hint}>Aplikacja uruchomi się automatycznie po zalogowaniu do systemu</div>
            </div>
          </label>
        </section>

        <div style={s.footer}>
          <button style={s.resetBtn} onClick={() => setSettings(DEFAULT)}>Przywróć domyślne</button>
          <button style={s.doneBtn} onClick={onClose}>Gotowe</button>
        </div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
  modal: { background: '#1a1a24', borderRadius: 14, width: 420, maxHeight: 'calc(100vh - 40px)', overflowY: 'auto', boxShadow: '0 24px 60px rgba(0,0,0,0.6)', border: '1px solid #2a2a3e', overflow: 'hidden' },
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
