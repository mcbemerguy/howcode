import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import { getBundledThemes } from '../bundled-themes.ts'
import { getResolvedPiPackageRoot } from '../pi-module.ts'

type SessionTheme = AgentSession['resourceLoader']['getThemes'] extends () => infer Result
  ? Result extends { themes: Array<infer Theme> }
    ? Theme
    : never
  : never

type PiThemeModule = {
  initTheme(themeName?: string | undefined, enableWatcher?: boolean | undefined): void
  loadThemeFromPath(themePath: string): unknown
  setRegisteredThemes(themes: SessionTheme[]): void
}

let themeModulePromise: Promise<PiThemeModule> | null = null

async function getPiThemeModule() {
  if (!themeModulePromise) {
    const piPackageRoot = await getResolvedPiPackageRoot()
    const themeModulePath = path.join(piPackageRoot, 'dist', 'modes/interactive/theme/theme.js')
    themeModulePromise = import(pathToFileURL(themeModulePath).href) as Promise<PiThemeModule>
  }

  return themeModulePromise
}

export async function applyHeadlessPiTheme(session: AgentSession) {
  const { initTheme, loadThemeFromPath, setRegisteredThemes } = await getPiThemeModule()
  const bundledThemes: SessionTheme[] = []
  for (const theme of getBundledThemes()) {
    try {
      bundledThemes.push(loadThemeFromPath(theme.path) as SessionTheme)
    } catch (error) {
      console.warn(
        `Could not load bundled theme ${theme.name}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  setRegisteredThemes([...bundledThemes, ...session.resourceLoader.getThemes().themes])
  initTheme(session.settingsManager.getTheme(), false)
}
