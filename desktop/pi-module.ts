// Pi UI bridge Howcode adapter. Managed by integrations/howcode/scripts/patch-howcode.mjs.
export type PiModule = typeof import('@earendil-works/pi-coding-agent')

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { normalizeOptionalSettingsPath } from './app-settings/path-normalization.ts'
import { loadAppSettings } from './app-settings/readers.ts'

type PiModuleResolution = {
  module: PiModule
  packageRoot: string
  version: string | null
  source: 'configured-agent-dir' | 'bundled'
}

const piCodingAgentDirEnvKey = 'PI_CODING_AGENT_DIR'
const piPackageRelativePath = path.join('node_modules', '@earendil-works', 'pi-coding-agent')
const requiredPiModuleExports = {
  AuthStorage: 'function',
  DefaultPackageManager: 'function',
  DefaultResourceLoader: 'function',
  ModelRegistry: 'function',
  SessionManager: 'function',
  SettingsManager: 'function',
  createAgentSession: 'function',
  createExtensionRuntime: 'function',
  createLsToolDefinition: 'function',
  createReadToolDefinition: 'function',
  defineTool: 'function',
  getAgentDir: 'function',
} as const

let piModuleResolutionPromise: Promise<PiModuleResolution> | undefined

function setProcessEnvironmentVariable(name: string, value: string) {
  process.env[name] = value
}

function applyCustomPiDirectoryEnvironment() {
  const environmentPiDirectory = normalizeOptionalSettingsPath(process.env[piCodingAgentDirEnvKey])
  if (environmentPiDirectory) return environmentPiDirectory

  const customPiDirectory = normalizeOptionalSettingsPath(loadAppSettings().customPiDirectory)
  if (customPiDirectory) setProcessEnvironmentVariable(piCodingAgentDirEnvKey, customPiDirectory)
  return customPiDirectory
}

function packageManifestPath(packageRoot: string) {
  return path.join(packageRoot, 'package.json')
}

function packageEntryPath(packageRoot: string) {
  return path.join(packageRoot, 'dist', 'index.js')
}

function readPackageVersion(packageRoot: string) {
  try {
    const parsed = JSON.parse(fs.readFileSync(packageManifestPath(packageRoot), 'utf8')) as {
      version?: unknown
    }
    return typeof parsed.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

function validatePiModule(module: unknown, packageRoot: string) {
  if (!module || typeof module !== 'object') {
    throw new Error(`Pi package did not load an object module from ${packageRoot}`)
  }

  const exports = module as Record<string, unknown>
  const invalid = Object.entries(requiredPiModuleExports).flatMap(([name, expectedType]) => {
    const actual = exports[name]
    return typeof actual === expectedType ? [] : [`${name} (${typeof actual})`]
  })
  if (invalid.length > 0) {
    throw new Error(
      `Pi package at ${packageRoot} is missing required exports or has incompatible export types: ${invalid.join(', ')}`,
    )
  }
}

async function importPiPackageFromRoot(packageRoot: string) {
  const entryPath = packageEntryPath(packageRoot)
  if (!fs.existsSync(entryPath)) {
    throw new Error(`Pi package entrypoint not found: ${entryPath}`)
  }
  const module = (await import(pathToFileURL(entryPath).href)) as PiModule
  validatePiModule(module, packageRoot)
  return module
}

async function resolveBundledPiPackageRoot() {
  const entryUrl = await import.meta.resolve('@earendil-works/pi-coding-agent')
  const entryPath = fileURLToPath(entryUrl)
  return path.resolve(path.dirname(entryPath), '..')
}

async function resolvePiModule(): Promise<PiModuleResolution> {
  const configuredAgentDir = applyCustomPiDirectoryEnvironment()
  if (configuredAgentDir) {
    const configuredPackageRoot = path.join(configuredAgentDir, piPackageRelativePath)
    if (fs.existsSync(packageManifestPath(configuredPackageRoot))) {
      const module = await importPiPackageFromRoot(configuredPackageRoot)
      return {
        module,
        packageRoot: configuredPackageRoot,
        version: readPackageVersion(configuredPackageRoot),
        source: 'configured-agent-dir',
      }
    }

    console.warn(
      `Configured Pi directory has no local @earendil-works/pi-coding-agent package at ${configuredPackageRoot}; using Howcode's bundled Pi package.`,
    )
  }

  const bundledPackageRoot = await resolveBundledPiPackageRoot()
  const module = (await import('@earendil-works/pi-coding-agent')) as PiModule
  validatePiModule(module, bundledPackageRoot)
  return {
    module,
    packageRoot: bundledPackageRoot,
    version: readPackageVersion(bundledPackageRoot),
    source: 'bundled',
  }
}

export async function getPiModuleResolution() {
  if (!piModuleResolutionPromise) piModuleResolutionPromise = resolvePiModule()
  const { packageRoot, source, version } = await piModuleResolutionPromise
  return { packageRoot, source, version }
}

export async function getResolvedPiPackageRoot() {
  return (await getPiModuleResolution()).packageRoot
}

export async function getPiModule() {
  if (!piModuleResolutionPromise) piModuleResolutionPromise = resolvePiModule()
  return (await piModuleResolutionPromise).module
}
