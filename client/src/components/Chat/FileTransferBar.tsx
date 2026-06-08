interface Props {
  transferId: string
  filename: string
  progress: number
  status: string
  direction: string
  onCancel?: () => void
}

export default function FileTransferBar({ filename, progress, status, direction, onCancel }: Props) {
  const statusLabels: Record<string, string> = {
    connecting: '🔗 Nawiązywanie połączenia P2P…',
    transferring: direction === 'send' ? '⬆ Wysyłanie' : '⬇ Odbieranie',
    done: '✅ Zakończono',
    error: '❌ Błąd transferu',
    incoming: '📨 Przychodzący plik',
    declined: '🚫 Odbiorca odrzucił',
    cancelled: '⛔ Anulowano',
    timeout: '⏱ Brak odpowiedzi – timeout',
  }

  const color = status === 'done' ? '#22c55e'
    : ['error', 'declined', 'cancelled', 'timeout'].includes(status) ? '#ef4444'
    : '#6366f1'

  const showCancel = status === 'connecting' || status === 'transferring'

  return (
    <div style={styles.bar}>
      <div style={styles.info}>
        <span style={styles.name}>{filename}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ ...styles.status, color }}>
            {statusLabels[status] ?? status}
            {status === 'transferring' && ` ${progress}%`}
          </span>
          {showCancel && onCancel && (
            <button style={styles.cancelBtn} onClick={onCancel} title="Anuluj transfer">✕</button>
          )}
        </div>
      </div>
      {(status === 'transferring' || status === 'connecting') && (
        <div style={styles.track}>
          <div style={{ ...styles.fill, width: `${progress}%`, background: color }} />
        </div>
      )}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  bar: { background: '#1a1a2e', borderRadius: 8, padding: '8px 12px', marginBottom: 4 },
  info: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  name: { color: '#ddd', fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, marginRight: 8 },
  status: { fontSize: 12, whiteSpace: 'nowrap' },
  cancelBtn: { background: '#3f1515', border: 'none', color: '#ef4444', cursor: 'pointer', borderRadius: 4, padding: '2px 6px', fontSize: 12, fontWeight: 700, flexShrink: 0 },
  track: { height: 4, background: '#2a2a3e', borderRadius: 2, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 2, transition: 'width 0.3s ease' },
}
