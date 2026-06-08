import { useEffect } from 'react'

interface Props {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export default function ConfirmDialog({
  title, message, confirmLabel = 'OK', cancelLabel = 'Anuluj',
  danger = false, onConfirm, onCancel,
}: Props) {
  // Zamknij na Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
      if (e.key === 'Enter') onConfirm()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onConfirm, onCancel])

  return (
    <div style={s.overlay} onClick={onCancel}>
      <div style={s.dialog} onClick={(e) => e.stopPropagation()}>
        <div style={s.title}>{title}</div>
        <div style={s.message}>{message}</div>
        <div style={s.buttons}>
          <button style={s.cancelBtn} onClick={onCancel}>{cancelLabel}</button>
          <button style={{ ...s.confirmBtn, background: danger ? '#ef4444' : '#6366f1' }} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 },
  dialog: { background: '#1a1a24', borderRadius: 12, padding: '24px 28px', width: 360, boxShadow: '0 24px 60px rgba(0,0,0,0.6)', border: '1px solid #2a2a3e' },
  title: { color: '#fff', fontWeight: 700, fontSize: 16, marginBottom: 10 },
  message: { color: '#aaa', fontSize: 14, lineHeight: 1.6, marginBottom: 20, whiteSpace: 'pre-line' },
  buttons: { display: 'flex', gap: 10, justifyContent: 'flex-end' },
  cancelBtn: { background: '#252535', border: '1px solid #333', borderRadius: 8, color: '#aaa', cursor: 'pointer', padding: '8px 18px', fontSize: 14 },
  confirmBtn: { border: 'none', borderRadius: 8, color: '#fff', cursor: 'pointer', padding: '8px 18px', fontSize: 14, fontWeight: 600 },
}
