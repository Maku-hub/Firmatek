import { useEffect, useRef } from 'react'
import { t } from '../../i18n'

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
  title, message, confirmLabel = 'OK', cancelLabel = t('confirm.cancel'),
  danger = false, onConfirm, onCancel,
}: Props) {
  const confirmRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const onCancelRef = useRef(onCancel)
  onCancelRef.current = onCancel

  useEffect(() => {
    // Enter is handled by the focused button itself. For destructive actions
    // focus starts on Cancel, so a stray Enter cannot confirm them.
    ;(danger ? cancelRef : confirmRef).current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancelRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [danger])

  return (
    <div style={s.overlay} onClick={onCancel}>
      <div style={s.dialog} onClick={(e) => e.stopPropagation()}
        role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-message">
        <div id="confirm-title" style={s.title}>{title}</div>
        <div id="confirm-message" style={s.message}>{message}</div>
        <div style={s.buttons}>
          <button ref={cancelRef} style={s.cancelBtn} onClick={onCancel}>{cancelLabel}</button>
          <button ref={confirmRef} style={{ ...s.confirmBtn, background: danger ? '#ef4444' : '#6366f1' }} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 },
  dialog: { background: '#1a1a24', borderRadius: 12, padding: '24px 28px', width: 360, maxWidth: 'calc(100vw - 32px)', boxShadow: '0 24px 60px rgba(0,0,0,0.6)', border: '1px solid #2a2a3e' },
  title: { color: '#fff', fontWeight: 700, fontSize: 16, marginBottom: 10 },
  message: { color: '#aaa', fontSize: 14, lineHeight: 1.6, marginBottom: 20, whiteSpace: 'pre-line', overflowWrap: 'anywhere' },
  buttons: { display: 'flex', gap: 10, justifyContent: 'flex-end' },
  cancelBtn: { background: '#252535', border: '1px solid #333', borderRadius: 8, color: '#aaa', cursor: 'pointer', padding: '8px 18px', fontSize: 14 },
  confirmBtn: { border: 'none', borderRadius: 8, color: '#fff', cursor: 'pointer', padding: '8px 18px', fontSize: 14, fontWeight: 600 },
}
