#!/usr/bin/env node
// Przepisuje wersję z APP_VERSION w .env do package.json i tauri.conf.json
const fs = require('fs')
const path = require('path')

function parseEnv(filePath) {
  if (!fs.existsSync(filePath)) return {}
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .reduce((acc, line) => {
      const m = line.match(/^([^#=\s][^=]*)=(.*)$/)
      if (m) acc[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '')
      return acc
    }, {})
}

const root = path.resolve(__dirname, '../..')
const env = {
  ...parseEnv(path.join(root, '.env.example')),
  ...parseEnv(path.join(root, '.env')),
}

const version = env.APP_VERSION || '1.0.0'
console.log(`[set-version] Wersja: ${version}`)

const pkgPath = path.resolve(__dirname, '../package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
pkg.version = version
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

const tauriPath = path.resolve(__dirname, '../src-tauri/tauri.conf.json')
const tauri = JSON.parse(fs.readFileSync(tauriPath, 'utf8'))
tauri.version = version
fs.writeFileSync(tauriPath, JSON.stringify(tauri, null, 2) + '\n')

console.log(`[set-version] Zaktualizowano package.json i tauri.conf.json`)
