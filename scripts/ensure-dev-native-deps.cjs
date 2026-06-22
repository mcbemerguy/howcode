#!/usr/bin/env node
const { spawnSync } = require('node:child_process')

const nativePackages = ['better-sqlite3', 'node-pty']

const validationScripts = {
  'better-sqlite3': `
    const loaded = require('better-sqlite3')
    const Database = loaded.default || loaded
    const database = new Database(':memory:')
    database.prepare('select 1').get()
    database.close()
  `,
  'node-pty': `
    require('node-pty')
  `,
}

function getLoadError(packageName) {
  const result = spawnSync(process.execPath, ['-e', validationScripts[packageName]], {
    encoding: 'utf8',
  })

  if (result.status === 0 && !result.error && !result.signal) {
    return null
  }

  const details = [
    result.error?.message,
    result.signal ? `terminated by ${result.signal}` : '',
    result.stderr?.trim(),
    result.stdout?.trim(),
  ]
    .filter(Boolean)
    .join('\n')

  return new Error(details || `${packageName} exited with status ${result.status ?? 'unknown'}`)
}

function getFailingPackages() {
  return nativePackages
    .map((packageName) => ({ packageName, error: getLoadError(packageName) }))
    .filter(({ error }) => error)
}

function rebuildNativePackages(packageNames) {
  const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const env = { ...process.env }
  delete env.npm_config_runtime
  delete env.npm_config_target
  delete env.npm_config_disturl
  delete env.npm_config_target_arch
  delete env.npm_config_target_platform

  console.warn(
    `[howcode] Rebuilding native dev dependencies for Node ${process.version} ABI ${process.versions.modules}: ${packageNames.join(', ')}`,
  )

  const result = spawnSync(npmExecutable, ['rebuild', ...packageNames], {
    stdio: 'inherit',
    env,
  })

  if (result.error) {
    console.error(`[howcode] Failed to run ${npmExecutable} rebuild: ${result.error.message}`)
    process.exit(1)
  }
  if (result.signal) {
    console.error(`[howcode] Native dependency rebuild was terminated by ${result.signal}.`)
    process.exit(1)
  }
  if (result.status !== 0) {
    process.exit(result.status || 1)
  }
}

let failingPackages = getFailingPackages()
if (failingPackages.length === 0) {
  process.exit(0)
}

for (const { packageName, error } of failingPackages) {
  console.warn(
    `[howcode] ${packageName} does not load under Node ${process.version}: ${error.message}`,
  )
}

rebuildNativePackages(failingPackages.map(({ packageName }) => packageName))

failingPackages = getFailingPackages()
if (failingPackages.length === 0) {
  process.exit(0)
}

for (const { packageName, error } of failingPackages) {
  console.error(`[howcode] ${packageName} still does not load after rebuild: ${error.message}`)
}
process.exit(1)
