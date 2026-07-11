// Disable the browser's default context menu and developer refresh shortcuts.
// Moved out of an inline <script> in index.html so the production CSP can use
// `script-src 'self'` (no 'unsafe-inline').
export function installShortcutGuards() {
  document.addEventListener('contextmenu', (e) => e.preventDefault())
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F5' || (e.ctrlKey && (e.key === 'r' || e.key === 'R'))) {
      e.preventDefault()
    }
  })
}
