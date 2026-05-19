// Pi UI bridge Howcode adapter. Managed by integrations/howcode/scripts/patch-howcode.mjs.
import type { NativeInteractionRequest } from '../../shared/desktop-contracts.ts'

type PendingInteraction = NativeInteractionRequest & {
  resolve: (response: unknown) => void
}

type RuntimeLike = {
  session: { sessionFile?: string | undefined }
}

const pendingBySessionPath = new Map<string, Map<string, PendingInteraction>>()

function snapshot(pending: PendingInteraction): NativeInteractionRequest {
  return {
    id: pending.id,
    kind: pending.kind,
    ...(pending.title === undefined ? {} : { title: pending.title }),
    payload: pending.payload,
    ...(pending.source === undefined ? {} : { source: pending.source }),
  }
}

function getSessionPending(sessionPath: string) {
  let pending = pendingBySessionPath.get(sessionPath)
  if (!pending) {
    pending = new Map()
    pendingBySessionPath.set(sessionPath, pending)
  }
  return pending
}

export function getNativeInteractionRequests(runtime: RuntimeLike): NativeInteractionRequest[] {
  const sessionPath = runtime.session.sessionFile
  if (!sessionPath) return []
  return [...(pendingBySessionPath.get(sessionPath)?.values() ?? [])].map(snapshot)
}

export function getNativeInteractionRequest(
  runtime: RuntimeLike,
  kind: string,
): NativeInteractionRequest | null {
  return getNativeInteractionRequests(runtime).find((request) => request.kind === kind) ?? null
}

export function createPendingNativeInteractionRequest<TResponse = unknown>(
  sessionPath: string,
  request: NativeInteractionRequest,
  options: { signal?: AbortSignal; supersedeKind?: boolean } = {},
) {
  const pendingForSession = getSessionPending(sessionPath)
  if (options.supersedeKind) {
    for (const [id, pending] of pendingForSession) {
      if (pending.kind !== request.kind) continue
      pendingForSession.delete(id)
      pending.resolve(null)
    }
  }

  let abort: (() => void) | null = null
  const promise = new Promise<TResponse | null>((resolve) => {
    const pending = { ...request, resolve: resolve as (response: unknown) => void }
    abort = () => {
      if (pendingForSession.get(request.id) !== pending) return
      pendingForSession.delete(request.id)
      resolve(null)
    }

    if (options.signal?.aborted) {
      resolve(null)
      return
    }

    pendingForSession.set(request.id, pending)
    options.signal?.addEventListener('abort', abort, { once: true })
  })

  return promise.finally(() => {
    if (abort) options.signal?.removeEventListener('abort', abort)
    if (pendingForSession.get(request.id)?.id === request.id) pendingForSession.delete(request.id)
    if (pendingForSession.size === 0) pendingBySessionPath.delete(sessionPath)
  })
}

export function answerNativeInteraction(
  runtime: RuntimeLike,
  requestId: string,
  response: unknown,
) {
  const sessionPath = runtime.session.sessionFile
  if (!sessionPath) return false
  const pendingForSession = pendingBySessionPath.get(sessionPath)
  const pending = pendingForSession?.get(requestId)
  if (!pending) return false
  pendingForSession?.delete(requestId)
  pending.resolve(response)
  return true
}
