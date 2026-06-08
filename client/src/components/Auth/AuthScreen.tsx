import { useState, useEffect } from 'react'
import { login, register, setServerURL, getServerURL, getAuthConfig, type AuthConfig } from '../../services/api'
import type { User } from '../../types'

interface Props { onAuth: (user: User) => void }

export default function AuthScreen({ onAuth }: Props) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [serverUrl, setServerUrlState] = useState(getServerURL())
  const [authConfig, setAuthConfig] = useState<AuthConfig | null>(null)
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const url = serverUrl.replace(/\/$/, '')
    fetch(`${url}/api/auth/config`)
      .then((r) => r.json())
      .then((cfg: AuthConfig) => {
        setAuthConfig(cfg)
        if (!cfg.registration_enabled) setMode('login')
      })
      .catch(() => setAuthConfig(null))
  }, [serverUrl])

  const appName = authConfig?.app_name ?? 'Firmatek'
  const showRegister = authConfig?.registration_enabled ?? true
  const isLDAP = authConfig?.ldap_enabled ?? false

  const handleSubmit = async () => {
    setError('')
    if (mode === 'register') {
      if (!displayName.trim()) { setError('Podaj imię i nazwisko'); return }
      if (password !== password2) { setError('Hasła nie są identyczne'); return }
      if (password.length < 6) { setError('Hasło musi mieć co najmniej 6 znaków'); return }
    }
    setLoading(true)
    setServerURL(serverUrl)
    try {
      if (mode === 'register') {
        const regData = await register(username.trim(), displayName.trim(), password)
        onAuth(regData.user)
      } else {
        const data = await login(username.trim(), password)
        onAuth(data.user)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Błąd logowania')
    } finally { setLoading(false) }
  }

  const isRegister = mode === 'register'

  return (
    <div style={s.bg}>
      <div style={s.card}>

        {/* Nagłówek – ikona + nazwa w jednym rzędzie */}
        <div style={s.header}>
          <span style={s.icon}>💬</span>
          <div>
            <div style={s.appName}>{appName}</div>
            <div style={s.ldapBadge}>
              {isLDAP ? '🏢 Active Directory' : 'Komunikator firmowy'}
            </div>
          </div>
        </div>

        {/* Formularz w siatce 2 kolumn dla labeli i inputów */}
        <div style={s.form}>

          <label style={s.label}>Adres serwera</label>
          <input style={s.input} value={serverUrl}
            onChange={(e) => setServerUrlState(e.target.value)}
            onBlur={() => setServerURL(serverUrl)}
            placeholder="http://192.168.1.100:8080" />

          {showRegister && (
            <div style={s.tabs}>
              {(['login', 'register'] as const).map((m) => (
                <button key={m} style={{ ...s.tab, ...(mode === m ? s.tabActive : {}) }}
                  onClick={() => { setMode(m); setError('') }}>
                  {m === 'login' ? 'Logowanie' : 'Rejestracja'}
                </button>
              ))}
            </div>
          )}

          <label style={s.label}>{isLDAP ? 'Login domenowy' : 'Login'}</label>
          <input style={s.input} value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="jan.kowalski" autoComplete="username" />

          {isRegister && <>
            <label style={s.label}>Imię i nazwisko</label>
            <input style={s.input} value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Jan Kowalski" />
          </>}

          <label style={s.label}>Hasło{isLDAP ? ' domenowe' : ''}</label>
          <input style={s.input} type="password" value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            autoComplete={!isRegister ? 'current-password' : 'new-password'}
            onKeyDown={(e) => e.key === 'Enter' && !isRegister && handleSubmit()} />

          {isRegister && <>
            <label style={s.label}>Powtórz hasło</label>
            <input style={s.input} type="password" value={password2}
              onChange={(e) => setPassword2(e.target.value)}
              placeholder="••••••••" autoComplete="new-password"
              onKeyDown={(e) => e.key === 'Enter' && handleSubmit()} />
          </>}
        </div>

        {error && <div style={s.error}>{error}</div>}

        <button style={{ ...s.btn, opacity: loading ? 0.6 : 1 }}
          onClick={handleSubmit} disabled={loading}>
          {loading ? 'Łączenie…' : !isRegister ? 'Zaloguj się' : 'Zarejestruj'}
        </button>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  // Pełny ekran, flex center, overflow pozwala na scroll gdy okno bardzo małe
  bg: {
    width: '100vw',
    height: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#0f0f13',
    overflow: 'auto',
    padding: 16,
  },
  // Karta: max-height żeby nie wychodziła poza ekran, własny scroll jeśli trzeba
  card: {
    background: '#1a1a24',
    borderRadius: 12,
    padding: '20px 24px',
    width: '100%',
    maxWidth: 360,
    maxHeight: 'calc(100vh - 32px)',
    overflowY: 'auto',
    boxShadow: '0 16px 48px rgba(0,0,0,0.5)',
    display: 'flex',
    flexDirection: 'column',
    gap: 0,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    marginBottom: 16,
    flexShrink: 0,
  },
  icon: { fontSize: 32, flexShrink: 0 },
  appName: { color: '#fff', fontSize: 20, fontWeight: 700, lineHeight: 1.2 },
  ldapBadge: { color: '#888', fontSize: 11, marginTop: 2 },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: 0,
  },
  tabs: {
    display: 'flex',
    margin: '10px 0 6px',
    borderRadius: 7,
    overflow: 'hidden',
    background: '#252535',
    flexShrink: 0,
  },
  tab: {
    flex: 1, padding: '6px 0', border: 'none', cursor: 'pointer',
    background: 'transparent', color: '#888', fontSize: 13,
  },
  tabActive: { background: '#6366f1', color: '#fff' },
  label: {
    color: '#999', fontSize: 11, marginTop: 10, marginBottom: 3,
  },
  input: {
    background: '#252535', border: '1px solid #333', borderRadius: 7,
    padding: '8px 11px', color: '#fff', fontSize: 13, outline: 'none',
    width: '100%',
  },
  error: {
    background: '#3f1515', color: '#ff6b6b', borderRadius: 7,
    padding: '7px 11px', fontSize: 12, marginTop: 8, flexShrink: 0,
  },
  btn: {
    marginTop: 14, padding: '10px 0', background: '#6366f1',
    color: '#fff', border: 'none', borderRadius: 7,
    fontSize: 14, fontWeight: 600, cursor: 'pointer', flexShrink: 0,
  },
}
