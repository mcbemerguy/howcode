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
import { createPendingNativeAskQuestionsRequest } from '../runtime/native-ask-questions-state.ts'
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
