// Pi UI bridge Howcode adapter. Managed by integrations/howcode/scripts/patch-howcode.mjs.
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { createPendingNativeInteractionRequest } from '../runtime/native-interaction-state.ts'

type RuntimeLike = {
  session: { sessionFile?: string | undefined }
}

type UiInteractionRequest = {
  id: string
  kind: string
  title?: string | undefined
  payload: unknown
  source?: { extension?: string; toolCallId?: string; sessionId?: string } | undefined
}

type UiBridgeHost = {
  supportsInteraction?: (kind: string) => boolean
  requestInteraction?: (request: UiInteractionRequest, signal?: AbortSignal) => Promise<{
    requestId: string
    value?: unknown
    cancelled?: true
    error?: string
  }>
}

type AskUserQuestionsModule = {
  createAskUserQuestionsTool: (options: { host?: UiBridgeHost }) => unknown
}

function createRequestId(kind: string) {
  return `pi_${kind}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function createHowcodePiBridgeHost({
  getRuntime,
  onStateChange,
}: {
  getRuntime: () => RuntimeLike | null
  onStateChange: () => void
}): UiBridgeHost {
  return {
    supportsInteraction: (kind) => kind === 'ask_user_questions',
    requestInteraction: async (request: UiInteractionRequest, signal?: AbortSignal) => {
      const runtime = getRuntime()
      const sessionPath = runtime?.session.sessionFile ?? null
      if (!sessionPath) return { requestId: request.id, cancelled: true }

      const id = request.id || createRequestId(request.kind)
      const response = createPendingNativeInteractionRequest(
        sessionPath,
        { ...request, id },
        signal ? { signal } : {},
      )
      onStateChange()
      const value = await response.finally(onStateChange)
      if (value === null) return { requestId: id, cancelled: true }
      return { requestId: id, value }
    },
  }
}

export async function createPiAskUserQuestionsBridgeTools({
  agentDir,
  getRuntime,
  onStateChange,
}: {
  agentDir: string
  getRuntime: () => RuntimeLike | null
  onStateChange: () => void
}) {
  const toolPath = path.join(agentDir, 'extensions/ask-user-questions/tool.ts')
  const module = (await import(pathToFileURL(toolPath).href)) as AskUserQuestionsModule
  const host = createHowcodePiBridgeHost({ getRuntime, onStateChange })
  return [module.createAskUserQuestionsTool({ host }) as AgentTool]
}
