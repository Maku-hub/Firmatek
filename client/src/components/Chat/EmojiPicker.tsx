import { useEffect, useRef } from 'react'

const EMOJIS = [
  ['😀','😂','😅','😍','🥰','😎','🤔','😐','😴','🤯'],
  ['👍','👎','👋','🙏','💪','🤝','👏','🫶','✌️','🤞'],
  ['❤️','🔥','⭐','✅','❌','⚠️','💡','🚀','🎉','🎊'],
  ['📎','📋','📌','🔍','🔒','⚙️','🖥️','💻','📱','🖨️'],
  ['😢','😡','😱','🤣','🥳','😏','🤓','😇','🥺','😤'],
]

interface Props {
  onSelect: (emoji: string) => void
  onClose: () => void
}

export default function EmojiPicker({ onSelect, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    setTimeout(() => document.addEventListener('mousedown', handler), 0)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  return (
    <div ref={ref} style={s.picker}>
      {EMOJIS.map((row, i) => (
        <div key={i} style={s.row}>
          {row.map((emoji) => (
            <button key={emoji} style={s.btn} onClick={() => onSelect(emoji)} title={emoji}>
              {emoji}
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}

const s: Record<string, React.CSSProperties> = {
  picker: { background: '#1a1a2e', border: '1px solid #2a2a3e', borderRadius: 10, padding: 10, boxShadow: '0 8px 32px rgba(0,0,0,0.5)' },
  row: { display: 'flex', gap: 2, marginBottom: 2 },
  btn: { background: 'transparent', border: 'none', fontSize: 20, cursor: 'pointer', padding: '4px 5px', borderRadius: 6, lineHeight: 1 },
}
