#!/usr/bin/env node

const path = require('node:path')
const { rebuild } = require('@electron/rebuild')

async function main() {
  const buildPath = path.resolve(__dirname, '..')
  const { version: electronVersion } = require(
    path.join(buildPath, 'node_modules', 'electron', 'package.json'),
  )
  const platform = process.env.npm_config_platform || process.platform
  const arch = process.env.npm_config_arch || process.arch
  const ignoreModules = []

  if (platform === 'win32' && process.env.HOWCODE_REBUILD_NODE_PTY !== 'true') {
    ignoreModules.push('node-pty')
    console.warn(
      '[howcode] Skipping node-pty Electron rebuild on Windows; packaged prebuilds are runtime-loaded.',
    )
  }

  await rebuild({
    buildPath,
    projectRootPath: buildPath,
    electronVersion,
    platform,
    arch,
    buildFromSource: false,
    mode: 'sequential',
    disablePreGypCopy: true,
    ignoreModules,
  })
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
