// Pi UI bridge Howcode adapter. Managed by integrations/howcode/scripts/patch-howcode.mjs.
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'
import { createPendingNativeInteractionRequest } from '../runtime/native-interaction-state.ts'
import { recordPiNotificationEvent } from '../runtime/pi-notification-state.ts'
import { recordRuntimeWorkflowProgressBridgeEvent } from '../runtime/workflow-progress-state.ts'

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

type UiBridgeEvent = {
  id: string
  type: string
  timestamp: string
  payload?: unknown
  source?: { extension?: string; toolCallId?: string; sessionId?: string } | undefined
}

type UiBridgeHost = {
  supportsInteraction?: (kind: string) => boolean
  requestInteraction?: (
    request: UiInteractionRequest,
    signal?: AbortSignal,
  ) => Promise<{
    requestId: string
    value?: unknown
    cancelled?: true
    error?: string
  }>
  emitEvent?: (event: UiBridgeEvent) => void | Promise<void>
}

type AskUserQuestionsModule = {
  createAskUserQuestionsTool: (options: { host?: UiBridgeHost }) => unknown
}

type UiBridgeEventForwarderModule = {
  createUiBridgeEventForwardingExtension: (options: {
    host?: UiBridgeHost
    source?: { extension?: string; toolCallId?: string; sessionId?: string }
    onHostError?: (error: unknown, event: UiBridgeEvent, piEvent: string) => void
  }) => ExtensionFactory
}

function createRequestId(kind: string) {
  return `pi_${kind}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function createHowcodePiBridgeHost({
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
    emitEvent: (event: UiBridgeEvent) => {
      const runtime = getRuntime()
      if (!runtime) return
      const workflowChanged = recordRuntimeWorkflowProgressBridgeEvent(runtime, event)
      const notificationChanged = recordPiNotificationEvent(runtime, event)
      if (workflowChanged || notificationChanged) onStateChange()
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

export async function createPiUiBridgeExtensionFactories({
  agentDir,
  getRuntime,
  onStateChange,
}: {
  agentDir: string
  getRuntime: () => RuntimeLike | null
  onStateChange: () => void
}) {
  const forwarderPath = path.join(agentDir, 'ui-bridge/event-forwarder.ts')
  const module = (await import(pathToFileURL(forwarderPath).href)) as UiBridgeEventForwarderModule
  const host = createHowcodePiBridgeHost({ getRuntime, onStateChange })
  return [
    module.createUiBridgeEventForwardingExtension({
      host,
      source: { extension: 'howcode' },
      onHostError: (error, _event, piEvent) => {
        console.warn(`Pi UI bridge host failed while forwarding ${piEvent}`, error)
      },
    }),
  ]
}
