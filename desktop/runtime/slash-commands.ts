import type { ComposerSlashCommand, ComposerStateRequest } from '../../shared/desktop-contracts.ts'
import { getDesktopWorkingDirectory } from '../../shared/desktop-working-directory.ts'
import { getPersistedSessionPath } from '../../shared/session-paths.ts'
import { withHeadlessAgentSessionLifecycle } from './agent-session-extensions.ts'
import { mapSessionCommands } from './composer-slash-command-mapping.ts'
import { createComposerSnapshotSession } from './composer-state.ts'
import {
  getOrCreateRuntimeForSessionPath,
  reloadRuntimeSettingsIfSafe,
  scheduleRuntimeDisposalForRuntime,
} from './runtime-registry.ts'
export async function getComposerSlashCommands(
  request: ComposerStateRequest = {},
): Promise<ComposerSlashCommand[]> {
  const persistedSessionPath = getPersistedSessionPath(request.sessionPath)
  if (persistedSessionPath) {
    const runtime = await getOrCreateRuntimeForSessionPath(persistedSessionPath, {
      suspendDisposal: true,
      settingsCwd: request.composerSessionDir ?? null,
      chatGroupId: request.chatGroupId ?? null,
    })
    if (!runtime.session.isStreaming) {
      await reloadRuntimeSettingsIfSafe(persistedSessionPath)
    }
    scheduleRuntimeDisposalForRuntime(runtime)
    return mapSessionCommands(runtime.session)
  }

  const snapshot = await createComposerSnapshotSession({
    ...request,
    projectId: request.projectId ?? getDesktopWorkingDirectory(),
    sessionPath: persistedSessionPath,
  })

  return await withHeadlessAgentSessionLifecycle(snapshot.session, mapSessionCommands)
}
