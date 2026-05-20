// Pi UI bridge Howcode adapter. Managed by integrations/howcode/scripts/patch-howcode.mjs.
import { getPersistedSessionPath, isLocalSessionPath } from '../../shared/session-paths.ts'

const localDraftSessionPathByPersistedSessionPath = new Map<string, string>()

export function rememberLocalDraftSessionAlias(input: {
  persistedSessionPath?: string | null | undefined
  localDraftSessionPath?: string | null | undefined
}) {
  const persistedSessionPath = getPersistedSessionPath(input.persistedSessionPath)
  const localDraftSessionPath = input.localDraftSessionPath
  if (
    !persistedSessionPath ||
    typeof localDraftSessionPath !== 'string' ||
    !isLocalSessionPath(localDraftSessionPath)
  )
    return
  localDraftSessionPathByPersistedSessionPath.set(persistedSessionPath, localDraftSessionPath)
}

export function getLocalDraftSessionAlias(sessionPath?: string | null | undefined) {
  const persistedSessionPath = getPersistedSessionPath(sessionPath)
  return persistedSessionPath
    ? (localDraftSessionPathByPersistedSessionPath.get(persistedSessionPath) ?? null)
    : null
}
