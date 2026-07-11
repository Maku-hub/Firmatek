import { useState, useRef, useEffect } from 'react'
import { searchMessages, type SearchResult } from '../../services/api'
import { useStore } from '../../store'
import { dmPartnerId } from '../../lib/dm'
import { t } from '../../i18n'

interface Props {
  onClose: () => void
  onGoToMessage: (channelId: string, messageId?: string) => void
}

export default function SearchPanel({ onClose, onGoToMessage }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const { users, currentUser } = useStore()
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [])

  const doSearch = (q: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!q.trim()) { setResults([]); setSearched(false); return }
    debounceRef.current = setTimeout(async () => {
      setLoading(true)
      try {
        const res = await searchMessages(q.trim())
        setResults(res)
        setSearched(true)
      } catch {
        setResults([])
      } finally {
        setLoading(false)
      }
    }, 300)
  }

  const handleChange = (val: string) => {
    setQuery(val)
    doSearch(val)
  }

  const getDMName = (r: SearchResult): string => {
    if (!r.is_direct) return `# ${r.channel_name}`
    const otherId = dmPartnerId(r.channel_name, currentUser?.id ?? '')
    return `👤 ${(otherId && users[otherId]?.display_name) || t('search.dm')}`
  }

  const highlight = (text: string, q: string): React.ReactNode => {
    if (!q.trim()) return text
    const truncated = text.length > 200 ? text.slice(0, 200) + '…' : text
    const needle = q.trim().toLowerCase()
    // Split on the (case-insensitively) matched term. The capture group keeps
    // the matched substrings in the array; compare by value rather than reusing
    // a stateful /g regex with .test() (whose lastIndex advances between calls).
    const regex = new RegExp(`(${q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
    const parts = truncated.split(regex)
    return parts.map((part, i) =>
      part.toLowerCase() === needle
        ? <mark key={i} style={s.highlight}>{part}</mark>
        : <span key={i}>{part}</span>
    )
  }

  return (
    <div style={s.panel}>
      <div style={s.header}>
        <span style={s.icon}>🔍</span>
        <input
          ref={inputRef}
          style={s.input}
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          placeholder={t('search.placeholder')}
          onKeyDown={(e) => e.key === 'Escape' && onClose()}
        />
        <button style={s.closeBtn} onClick={onClose}>✕</button>
      </div>

      <div style={s.results}>
        {loading && <div style={s.info}>{t('search.searching')}</div>}

        {!loading && searched && results.length === 0 && (
          <div style={s.info}>{t('search.noResults', { query })}</div>
        )}

        {results.map((r) => (
          <div
            key={r.id}
            style={s.resultItem}
            role="button"
            tabIndex={0}
            onClick={() => onGoToMessage(r.channel_id, r.id)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onGoToMessage(r.channel_id, r.id) } }}
          >
            <div style={s.resultHeader}>
              <span style={s.senderName}>{r.sender?.display_name ?? t('search.unknown')}</span>
              <span style={s.channelBadge}>{getDMName(r)}</span>
              <span style={s.timestamp}>
                {new Date(r.created_at).toLocaleDateString('pl', { day: 'numeric', month: 'short' })}{' '}
                {new Date(r.created_at).toLocaleTimeString('pl', { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
            <div style={s.resultContent}>
              {highlight(r.content, query)}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  panel: {
    position: 'absolute', top: 0, right: 0, bottom: 0,
    width: 380, maxWidth: '100%',
    background: '#13131c', borderLeft: '1px solid #1e1e2e',
    display: 'flex', flexDirection: 'column', zIndex: 50,
    boxShadow: '-4px 0 20px rgba(0,0,0,0.4)',
  },
  header: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '12px 14px', borderBottom: '1px solid #1e1e2e',
  },
  icon: { fontSize: 16, flexShrink: 0 },
  input: {
    flex: 1, background: '#1a1a2e', border: '1px solid #2a2a3e',
    borderRadius: 8, padding: '8px 12px', color: '#fff',
    fontSize: 14, outline: 'none',
  },
  closeBtn: {
    background: 'transparent', border: 'none', color: '#666',
    cursor: 'pointer', fontSize: 16, padding: '4px 6px',
  },
  results: {
    flex: 1, overflowY: 'auto', padding: '8px 0',
  },
  info: {
    color: '#555', fontSize: 13, textAlign: 'center', padding: '24px 16px',
  },
  resultItem: {
    padding: '10px 14px', cursor: 'pointer', borderBottom: '1px solid #1a1a28',
    transition: 'background 0.15s',
  },
  resultHeader: {
    display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4,
  },
  senderName: {
    color: '#ccc', fontSize: 12, fontWeight: 600,
  },
  channelBadge: {
    color: '#6366f1', fontSize: 11, background: '#6366f115',
    padding: '1px 6px', borderRadius: 4,
  },
  timestamp: {
    color: '#444', fontSize: 11, marginLeft: 'auto',
  },
  resultContent: {
    color: '#999', fontSize: 13, lineHeight: 1.5,
    overflow: 'hidden', display: '-webkit-box',
    WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' as never,
  },
  highlight: {
    background: '#6366f140', color: '#c4b5fd',
    borderRadius: 2, padding: '0 1px',
  },
}
