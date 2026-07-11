#!/usr/bin/env node
// Copies the version from APP_VERSION in .env into package.json and tauri.conf.json
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

// Priority: explicit APP_VERSION env (CI/Docker) > .env/.env.example > default.
const version = process.env.APP_VERSION || env.APP_VERSION || '1.0.0'
console.log(`[set-version] Version: ${version}`)

const pkgPath = path.resolve(__dirname, '../package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
pkg.version = version
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

const tauriPath = path.resolve(__dirname, '../src-tauri/tauri.conf.json')
const tauri = JSON.parse(fs.readFileSync(tauriPath, 'utf8'))
tauri.version = version
fs.writeFileSync(tauriPath, JSON.stringify(tauri, null, 2) + '\n')

// Keep the Rust crate version in sync (only the [package] version, which is the
// sole line-start `version = "..."` — dependency versions are inline).
const cargoPath = path.resolve(__dirname, '../src-tauri/Cargo.toml')
const cargo = fs.readFileSync(cargoPath, 'utf8').replace(/^version = "[^"]*"/m, `version = "${version}"`)
fs.writeFileSync(cargoPath, cargo)

console.log(`[set-version] Updated package.json, tauri.conf.json and Cargo.toml`)
