import { useEffect, useState } from 'react'
import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { t } from '../../i18n'

interface Props {
  code: string
  language: string
  filename?: string
}

let highlighterPromise: Promise<HighlighterCore> | null = null

// Importing from 'shiki' directly would bundle every grammar it ships
// (~250 languages, 9 MB). Only the languages offered in the composer are
// loaded here.
function getHighlighter() {
  highlighterPromise ??= createHighlighterCore({
    themes: [import('shiki/themes/one-dark-pro.mjs')],
    langs: [
      import('shiki/langs/typescript.mjs'),
      import('shiki/langs/javascript.mjs'),
      import('shiki/langs/python.mjs'),
      import('shiki/langs/go.mjs'),
      import('shiki/langs/rust.mjs'),
      import('shiki/langs/java.mjs'),
      import('shiki/langs/csharp.mjs'),
      import('shiki/langs/cpp.mjs'),
      import('shiki/langs/sql.mjs'),
      import('shiki/langs/bash.mjs'),
      import('shiki/langs/json.mjs'),
      import('shiki/langs/yaml.mjs'),
      import('shiki/langs/html.mjs'),
      import('shiki/langs/css.mjs'),
    ],
    loadWasm: import('shiki/wasm'),
  })
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
    }).catch(() => { /* keep the plain <pre> fallback */ })
    return () => { cancelled = true }
  }, [code, language])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  const handleCopy = () => {
    navigator.clipboard.writeText(code).then(() => setCopied(true), () => {})
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
    .replace(/"/g, '&quot;')
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
