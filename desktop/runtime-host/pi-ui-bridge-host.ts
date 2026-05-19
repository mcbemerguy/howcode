// Pi UI bridge Howcode adapter. Managed by integrations/howcode/scripts/patch-howcode.mjs.
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { NativeAskQuestion } from '../../shared/desktop-contracts.ts'
import { createPendingNativeInteractionRequest } from '../runtime/native-interaction-state.ts'
import { createPendingNativeAskQuestionsRequest } from '../runtime/native-ask-questions-state.ts'

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

type PreparedAlternative = {
  text: string
  recommended: boolean
  isOther: boolean
  originalIndex: number | null
}

type PreparedQuestion = {
  id: string
  question: string
  alternatives: PreparedAlternative[]
}

type AskUserQuestionsPayload = {
  questions: PreparedQuestion[]
}

function createRequestId(kind: string) {
  return `pi_${kind}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAskUserQuestionsPayload(value: unknown): value is AskUserQuestionsPayload {
  return isRecord(value) && Array.isArray(value['questions'])
}

function toNativeAskQuestions(questions: PreparedQuestion[]): NativeAskQuestion[] {
  return questions.map((question) => ({
    id: question.id,
    question: question.question,
    options: question.alternatives
      .filter((alternative) => !alternative.isOther)
      .map((alternative) => ({ label: alternative.text })),
  }))
}

function toAskUserQuestionsResponse(questions: PreparedQuestion[], answers: string[][] | null) {
  if (!answers || answers.length !== questions.length) return { status: 'denied' }
  if (answers.some((answer) => !answer[0]?.trim())) return { status: 'denied' }
  if (questions.some((question) => question.alternatives.length === 0)) return { status: 'denied' }
  return {
    status: 'confirmed',
    answers: questions.map((question, index) => {
      const answer = answers[index]?.[0]?.trim() ?? ''
      const selected = question.alternatives.find((alternative) => !alternative.isOther && alternative.text === answer)
      const fallback = question.alternatives.find((alternative) => alternative.isOther) ?? question.alternatives[0]!
      const alternative = selected ?? fallback
      const selectedIndex = question.alternatives.indexOf(alternative)
      return {
        questionId: question.id,
        question: question.question,
        selectedIndex,
        selectedOriginalIndex: alternative.originalIndex,
        answer: answer || alternative.text,
        fromOther: alternative.isOther,
        edited: alternative.isOther || (answer || alternative.text) !== alternative.text,
      }
    }),
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

      const id = request.id || createRequestId(request.kind)
      if (request.kind === 'ask_user_questions' && isAskUserQuestionsPayload(request.payload)) {
        const answers = createPendingNativeAskQuestionsRequest(
          sessionPath,
          { id, questions: toNativeAskQuestions(request.payload.questions) },
          signal ? { signal } : {},
        )
        onStateChange()
        const value = await answers.finally(onStateChange)
        return { requestId: id, value: toAskUserQuestionsResponse(request.payload.questions, value) }
      }

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
