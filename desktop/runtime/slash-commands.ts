import type { ComposerSlashCommand, ComposerStateRequest } from '../../shared/desktop-contracts.ts'
import { getDesktopWorkingDirectory } from '../../shared/desktop-working-directory.ts'
import { getPersistedSessionPath } from '../../shared/session-paths.ts'
import { getPiModule } from '../pi-module.ts'
import {
  getPiUiBridgeSessionCommands,
  isUnsupportedPiUiBridgeApiError,
  preparePiUiBridgeCommandDiscoverySession,
} from '../runtime-host/pi-ui-bridge-host.ts'
import { discoverHeadlessAgentSessionResources } from './agent-session-extensions.ts'
import { mapPiSessionCommands } from './composer-slash-command-mapping.ts'
import { createComposerSnapshotSession } from './composer-state.ts'
import {
  getCachedRuntimeForSessionPath,
  reloadRuntimeSettingsIfSafe,
  scheduleRuntimeDisposalForRuntime,
} from './runtime-registry.ts'

async function getPiAgentDir() {
  const { getAgentDir } = await getPiModule()
  return getAgentDir()
}

async function mapBridgeCommands(
  agentDir: string,
  session: Parameters<typeof getPiUiBridgeSessionCommands>[0]['session'],
) {
  return mapPiSessionCommands(await getPiUiBridgeSessionCommands({ agentDir, session }))
}

async function discoverFallbackHeadlessResources(
  session: Parameters<typeof getPiUiBridgeSessionCommands>[0]['session'],
) {
  try {
    await discoverHeadlessAgentSessionResources(session)
  } catch (error) {
    console.warn('Pi extension resource discovery failed', error)
  }
}

export async function getComposerSlashCommands(
  request: ComposerStateRequest = {},
): Promise<ComposerSlashCommand[]> {
  const persistedSessionPath = getPersistedSessionPath(request.sessionPath)
  const cachedRuntimePromise = persistedSessionPath
    ? getCachedRuntimeForSessionPath(persistedSessionPath)
    : null

  const agentDir = await getPiAgentDir()

  if (cachedRuntimePromise && persistedSessionPath) {
    const runtime = await cachedRuntimePromise
    if (!runtime.session.isStreaming) {
      await reloadRuntimeSettingsIfSafe(persistedSessionPath)
    }
    scheduleRuntimeDisposalForRuntime(runtime)
    return await mapBridgeCommands(agentDir, runtime.session)
  }

  const snapshot = await createComposerSnapshotSession({
    ...request,
    projectId: request.projectId ?? getDesktopWorkingDirectory(),
    sessionPath: persistedSessionPath,
  })

  try {
    try {
      await preparePiUiBridgeCommandDiscoverySession({ agentDir, session: snapshot.session })
    } catch (error) {
      if (isUnsupportedPiUiBridgeApiError(error)) throw error
      console.warn('Pi extension lifecycle discovery failed', error)
      await discoverFallbackHeadlessResources(snapshot.session)
    }
    return await mapBridgeCommands(agentDir, snapshot.session)
  } finally {
    snapshot.session.dispose()
  }
}
