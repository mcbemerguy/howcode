#!/usr/bin/env node

const childProcess = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const repoRoot = path.resolve(__dirname, '..')

if (!fs.existsSync(path.join(repoRoot, '.git'))) {
  process.exit(0)
}

const localHusky = path.join(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'husky.exe' : 'husky',
)
const command = fs.existsSync(localHusky) ? localHusky : 'husky'
const result = childProcess.spawnSync(command, [], {
  cwd: repoRoot,
  stdio: 'inherit',
})

if (result.error) {
  console.warn(`[howcode] Skipping Husky prepare: ${result.error.message}`)
}
