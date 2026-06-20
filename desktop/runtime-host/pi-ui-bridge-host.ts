// Pi UI bridge Howcode adapter. Managed by integrations/howcode/scripts/patch-howcode.mjs.
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'
import type {
  NativeAskQuestion,
  PiAskUserQuestionsPayload,
  PiAskUserQuestionsQuestion,
  PiAskUserQuestionsResponse,
} from '../../shared/desktop-contracts.ts'
import { getPersistedSessionPath } from '../../shared/session-paths.ts'
import { ensureAskQuestionsExtensionRuntimePath } from '../native-extensions/ask-questions-extension-path.ts'
import { buildComposerState } from '../runtime/composer-state.ts'
import { createPendingNativeAskQuestionsRequest } from '../runtime/native-ask-questions-state.ts'
import { recordPiNotificationEvent } from '../runtime/pi-notification-state.ts'
import type { PiRuntime } from '../runtime/types.ts'
import {
  recordRuntimeWorkflowProgressBridgeEvent,
  subscribeRuntimeWorkflowProgress,
} from '../runtime/workflow-progress-state.ts'
import { publishComposerUpdate } from './live-thread-publisher.ts'
import { invokeMainRequest } from './main-request-client.ts'
import { createNativeAskQuestionsTools } from './native-ask-questions-tool.ts'

type RuntimeLike = {
  cwd?: string | undefined
  session: {
    sessionFile?: string | undefined
    sessionManager?: PiRuntime['session']['sessionManager']
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPiAskUserQuestionsQuestion(value: unknown): value is PiAskUserQuestionsQuestion {
  if (!isRecord(value)) return false
  const question = value as {
    id?: unknown
    question?: unknown
    alternatives?: unknown
  }
  return (
    typeof question.id === 'string' &&
    typeof question.question === 'string' &&
    Array.isArray(question.alternatives) &&
    question.alternatives.every((alternative) => {
      if (!isRecord(alternative)) return false
      const candidate = alternative as {
        text?: unknown
        recommended?: unknown
        isOther?: unknown
        originalIndex?: unknown
      }
      return (
        typeof candidate.text === 'string' &&
        typeof candidate.recommended === 'boolean' &&
        typeof candidate.isOther === 'boolean' &&
        (typeof candidate.originalIndex === 'number' || candidate.originalIndex === null)
      )
    })
  )
}

function toPiAskUserQuestionsPayload(payload: unknown): PiAskUserQuestionsPayload | null {
  if (!isRecord(payload)) return null
  const candidate = payload as { questions?: unknown }
  if (!Array.isArray(candidate.questions)) return null
  return candidate.questions.every(isPiAskUserQuestionsQuestion)
    ? { questions: candidate.questions }
    : null
}

function toNativeAskQuestions(questions: PiAskUserQuestionsQuestion[]): NativeAskQuestion[] {
  return questions.map((question) => ({
    id: question.id,
    question: question.question,
    multiple: false,
    options: question.alternatives
      .filter((alternative) => !alternative.isOther)
      .map((alternative) => ({
        label: alternative.text,
        ...(alternative.recommended ? { description: 'Recommended' } : {}),
      })),
  }))
}

function findSelectedAlternative(question: PiAskUserQuestionsQuestion, answer: string) {
  const normalizedAnswer = answer.trim()
  if (!normalizedAnswer) return null

  const predefinedIndex = question.alternatives.findIndex(
    (alternative) => !alternative.isOther && alternative.text === normalizedAnswer,
  )
  if (predefinedIndex >= 0) return { index: predefinedIndex, answer: normalizedAnswer }

  const otherIndex = question.alternatives.findIndex((alternative) => alternative.isOther)
  return otherIndex >= 0 ? { index: otherIndex, answer: normalizedAnswer } : null
}

function toPiAskUserQuestionsResponse(
  questions: PiAskUserQuestionsQuestion[],
  answers: string[][] | null,
): PiAskUserQuestionsResponse {
  if (!answers) return { status: 'denied' }

  const mappedAnswers: Extract<PiAskUserQuestionsResponse, { status: 'confirmed' }>['answers'] = []
  for (const [index, question] of questions.entries()) {
    const answer = answers[index]?.find((item) => item.trim().length > 0) ?? ''
    const selected = findSelectedAlternative(question, answer)
    if (!selected) return { status: 'denied' }

    const alternative = question.alternatives[selected.index]
    if (!alternative) return { status: 'denied' }
    mappedAnswers.push({
      questionId: question.id,
      question: question.question,
      selectedIndex: selected.index,
      selectedOriginalIndex: alternative.originalIndex,
      answer: selected.answer,
      fromOther: alternative.isOther,
      edited: alternative.isOther || selected.answer !== alternative.text,
    })
  }

  return { status: 'confirmed', answers: mappedAnswers }
}

async function requestAskUserQuestionsInComposer({
  request,
  sessionPath,
  signal,
}: {
  request: UiInteractionRequest
  sessionPath: string
  signal?: AbortSignal
}) {
  const payload = toPiAskUserQuestionsPayload(request.payload)
  if (!payload) {
    return { requestId: request.id, error: 'Invalid ask_user_questions payload.' }
  }

  const answers = createPendingNativeAskQuestionsRequest(
    sessionPath,
    { id: request.id, questions: toNativeAskQuestions(payload.questions) },
    signal ? { signal } : {},
  )
  const value = toPiAskUserQuestionsResponse(payload.questions, await answers)
  return { requestId: request.id, value }
}

function createRuntimeComposerPublisher(
  getRuntime: () => PiRuntime | null,
  onStateChange?: (() => void) | undefined,
) {
  return () => {
    const activeRuntime = getRuntime()
    if (!activeRuntime) return
    onStateChange?.()
    void buildComposerState(activeRuntime).then((composer) => {
      publishComposerUpdate(composer, {
        projectId: activeRuntime.cwd,
        sessionPath: activeRuntime.session.sessionFile,
      })
    })
  }
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
      if (request.kind !== 'ask_user_questions') {
        return { requestId: request.id, error: `Unsupported UI interaction: ${request.kind}` }
      }

      const response = requestAskUserQuestionsInComposer({
        request,
        sessionPath,
        ...(signal ? { signal } : {}),
      })
      onStateChange()
      return await response.finally(onStateChange)
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

async function createPiAskUserQuestionsBridgeTools({
  agentDir,
  host,
}: {
  agentDir: string
  host: UiBridgeHost
}) {
  const toolPath = path.join(agentDir, 'extensions/ask-user-questions/tool.ts')
  const module = (await import(pathToFileURL(toolPath).href)) as AskUserQuestionsModule
  return [module.createAskUserQuestionsTool({ host }) as AgentTool]
}

async function createPiUiBridgeExtensionFactories({
  agentDir,
  host,
}: {
  agentDir: string
  host: UiBridgeHost
}) {
  const forwarderPath = path.join(agentDir, 'ui-bridge/event-forwarder.ts')
  const module = (await import(pathToFileURL(forwarderPath).href)) as UiBridgeEventForwarderModule
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

async function getEnabledNativeExtensionsForRuntime(options: {
  sessionManager?: PiRuntime['session']['sessionManager']
}) {
  const sessionPath = options.sessionManager?.getSessionFile?.() ?? null
  if (sessionPath) {
    const enabled = await invokeMainRequest('getSessionNativeExtensions', { sessionPath })
    if (enabled) return enabled
    const defaultEnabled = await invokeMainRequest('snapshotDefaultNativeExtensions', {})
    await invokeMainRequest('setSessionNativeExtensions', {
      sessionPath,
      enabled: defaultEnabled,
    })
    return defaultEnabled
  }

  return await invokeMainRequest('snapshotDefaultNativeExtensions', {})
}

async function createLegacyAskQuestionsTools({
  defineTool,
  enabledNativeExtensions,
  extensionPath,
  getRuntime,
  onStateChange,
}: Parameters<typeof createNativeAskQuestionsTools>[0] & {
  enabledNativeExtensions: string[]
}) {
  if (!enabledNativeExtensions.includes('askQuestions')) return []
  return await createNativeAskQuestionsTools({
    defineTool,
    extensionPath,
    getRuntime,
    onStateChange,
  })
}

export async function createHowcodePiRuntimeAdapter({
  agentDir,
  defineTool,
  enabledNativeExtensions: enabledNativeExtensionsOverride,
  getRuntime,
  onStateChange,
  sessionManager,
}: {
  agentDir: string
  defineTool: Parameters<typeof createNativeAskQuestionsTools>[0]['defineTool']
  enabledNativeExtensions?: string[] | undefined
  getRuntime: () => PiRuntime | null
  onStateChange?: (() => void) | undefined
  sessionManager?: PiRuntime['session']['sessionManager'] | undefined
}) {
  const publishRuntimeComposerState = createRuntimeComposerPublisher(getRuntime, onStateChange)
  const host = createHowcodePiBridgeHost({ getRuntime, onStateChange: publishRuntimeComposerState })
  const extensionFactories = await createPiUiBridgeExtensionFactories({ agentDir, host })
  const enabledNativeExtensions =
    enabledNativeExtensionsOverride ??
    (await getEnabledNativeExtensionsForRuntime(sessionManager ? { sessionManager } : {}))
  const customTools = enabledNativeExtensions.includes('askQuestions')
    ? [
        ...(await createLegacyAskQuestionsTools({
          enabledNativeExtensions,
          defineTool,
          extensionPath: ensureAskQuestionsExtensionRuntimePath() ?? '',
          getRuntime,
          onStateChange: publishRuntimeComposerState,
        })),
        ...(await createPiAskUserQuestionsBridgeTools({ agentDir, host })),
      ]
    : []

  return {
    customTools,
    enabledNativeExtensions,
    extensionFactories,
    bindRuntime: async (runtime: PiRuntime) => {
      if (!sessionManager) {
        const runtimeKey = getPersistedSessionPath(runtime.session.sessionFile)
        if (runtimeKey) {
          await invokeMainRequest('setSessionNativeExtensions', {
            sessionPath: runtimeKey,
            enabled: enabledNativeExtensions,
          })
        }
      }
      subscribeRuntimeWorkflowProgress(runtime, publishRuntimeComposerState, { agentDir })
    },
  }
}
