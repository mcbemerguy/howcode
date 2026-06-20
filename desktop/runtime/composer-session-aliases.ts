// Pi UI bridge Howcode adapter. Managed by integrations/howcode/scripts/patch-howcode.mjs.
import { getPersistedSessionPath, isLocalSessionPath } from '../../shared/session-paths.ts'

const localDraftSessionPathByPersistedSessionPath = new Map<string, string>()
const localDraftSessionPathByRuntime = new WeakMap<object, string>()

function normalizeLocalDraftSessionPath(sessionPath?: string | null | undefined) {
  return typeof sessionPath === 'string' && isLocalSessionPath(sessionPath) ? sessionPath : null
}

export function rememberLocalDraftSessionAlias(input: {
  persistedSessionPath?: string | null | undefined
  localDraftSessionPath?: string | null | undefined
}) {
  const persistedSessionPath = getPersistedSessionPath(input.persistedSessionPath)
  const localDraftSessionPath = normalizeLocalDraftSessionPath(input.localDraftSessionPath)
  if (!(persistedSessionPath && localDraftSessionPath)) return
  localDraftSessionPathByPersistedSessionPath.set(persistedSessionPath, localDraftSessionPath)
}

export function rememberRuntimeLocalDraftSessionAlias(input: {
  runtime?: object | null | undefined
  persistedSessionPath?: string | null | undefined
  localDraftSessionPath?: string | null | undefined
}) {
  const localDraftSessionPath = normalizeLocalDraftSessionPath(input.localDraftSessionPath)
  if (!(input.runtime && localDraftSessionPath)) return
  localDraftSessionPathByRuntime.set(input.runtime, localDraftSessionPath)
  rememberLocalDraftSessionAlias({
    persistedSessionPath: input.persistedSessionPath,
    localDraftSessionPath,
  })
}

export function getLocalDraftSessionAlias(sessionPath?: string | null | undefined) {
  const persistedSessionPath = getPersistedSessionPath(sessionPath)
  return persistedSessionPath
    ? (localDraftSessionPathByPersistedSessionPath.get(persistedSessionPath) ?? null)
    : null
}

export function getRuntimeLocalDraftSessionAlias(runtime?: object | null | undefined) {
  return runtime ? (localDraftSessionPathByRuntime.get(runtime) ?? null) : null
}
