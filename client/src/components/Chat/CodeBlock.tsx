import { useEffect, useState } from 'react'
import { createHighlighter } from 'shiki'
import { t } from '../../i18n'

interface Props {
  code: string
  language: string
  filename?: string
}

let highlighterPromise: ReturnType<typeof createHighlighter> | null = null

function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ['one-dark-pro'],
      langs: [
        'typescript', 'javascript', 'python', 'go', 'rust', 'java',
        'csharp', 'cpp', 'sql', 'bash', 'json', 'yaml', 'html', 'css',
      ],
    })
  }
  return highlighterPromise
}

export default function CodeBlock({ code, language, filename }: Props) {
  const [html, setHtml] = useState<string>('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    getHighlighter().then((hl) => {
      if (cancelled) return
      try {
        const result = hl.codeToHtml(code, { lang: language, theme: 'one-dark-pro' })
        setHtml(result)
      } catch {
        // fallback if the language is unsupported
        setHtml(`<pre style="color:#abb2bf;background:#282c34;padding:16px;border-radius:8px;overflow-x:auto"><code>${escapeHtml(code)}</code></pre>`)
      }
    })
    return () => { cancelled = true }
  }, [code, language])

  const handleCopy = () => {
    navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div style={styles.wrapper}>
      <div style={styles.header}>
        <span style={styles.lang}>{filename ?? language}</span>
        <button style={styles.copyBtn} onClick={handleCopy}>
          {copied ? t('code.copied') : t('code.copy')}
        </button>
      </div>
      {html ? (
        <div
          dangerouslySetInnerHTML={{ __html: html }}
          style={styles.code}
        />
      ) : (
        <pre style={styles.fallback}>{code}</pre>
      )}
    </div>
  )
}

function escapeHtml(str: string) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    borderRadius: 8, overflow: 'hidden',
    border: '1px solid #2a2a3e', marginTop: 4,
  },
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    background: '#1a1a2e', padding: '6px 12px',
  },
  lang: { color: '#888', fontSize: 11, fontFamily: 'monospace' },
  copyBtn: {
    background: 'transparent', border: 'none', color: '#888',
    cursor: 'pointer', fontSize: 11, transition: 'color 0.2s',
  },
  code: {
    maxHeight: 400, overflowY: 'auto', overflowX: 'auto',
    fontSize: 13,
  },
  fallback: {
    background: '#1a1a2e', color: '#abb2bf', padding: 16,
    margin: 0, fontSize: 13, overflow: 'auto', maxHeight: 400,
  },
}
