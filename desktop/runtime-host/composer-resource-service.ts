import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { ComposerStateRequest } from '../../shared/desktop-contracts.ts'
import { getDesktopWorkingDirectory } from '../../shared/desktop-working-directory.ts'
import { getPersistedSessionPath } from '../../shared/session-paths.ts'
import { getPiModule } from '../pi-module.ts'
import { discoverHeadlessAgentSessionResources } from '../runtime/agent-session-extensions.ts'
import { mapPiSessionCommands } from '../runtime/composer-slash-command-mapping.ts'
import { createComposerSnapshotSession } from '../runtime/composer-state.ts'
import {
  getOrCreateRuntimeForSessionPath,
  reloadRuntimeSettingsIfSafe,
  scheduleRuntimeDisposal,
} from './live-runtime-registry.ts'
import {
  getPiUiBridgeSessionCommands,
  isUnsupportedPiUiBridgeApiError,
  preparePiUiBridgeCommandDiscoverySession,
} from './pi-ui-bridge-host.ts'

type SessionResourceMapper<T> = (session: AgentSession) => T | Promise<T>

async function getPiAgentDir() {
  const { getAgentDir } = await getPiModule()
  return getAgentDir()
}

async function discoverFallbackHeadlessResources(session: AgentSession) {
  try {
    await discoverHeadlessAgentSessionResources(session)
  } catch (error) {
    console.warn('Pi extension resource discovery failed', error)
  }
}

export async function getComposerSessionResources<T>(
  request: ComposerStateRequest = {},
  mapResources: SessionResourceMapper<T>,
) {
  const persistedSessionPath = getPersistedSessionPath(request.sessionPath)
  if (persistedSessionPath) {
    const runtime = await getOrCreateRuntimeForSessionPath(persistedSessionPath, {
      suspendDisposal: true,
      settingsCwd: request.composerSessionDir ?? null,
      chatGroupId: request.chatGroupId ?? null,
    })
    await reloadRuntimeSettingsIfSafe(persistedSessionPath)
    scheduleRuntimeDisposal(persistedSessionPath)
    return await mapResources(runtime.session)
  }

  const snapshot = await createComposerSnapshotSession({
    ...request,
    projectId: request.projectId ?? getDesktopWorkingDirectory(),
    sessionPath: persistedSessionPath,
  })

  try {
    const agentDir = await getPiAgentDir()
    try {
      await preparePiUiBridgeCommandDiscoverySession({ agentDir, session: snapshot.session })
    } catch (error) {
      if (isUnsupportedPiUiBridgeApiError(error)) throw error
      console.warn('Pi extension lifecycle discovery failed', error)
      await discoverFallbackHeadlessResources(snapshot.session)
    }
    return await mapResources(snapshot.session)
  } finally {
    snapshot.session.dispose()
  }
}

export async function getComposerSessionSlashCommands(request: ComposerStateRequest = {}) {
  const agentDir = await getPiAgentDir()
  return await getComposerSessionResources(request, async (session) =>
    mapPiSessionCommands(await getPiUiBridgeSessionCommands({ agentDir, session })),
  )
}
