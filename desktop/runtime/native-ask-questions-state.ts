import type { NativeAskQuestionsRequest } from '../../shared/desktop-contracts.ts'
import {
  answerNativeInteraction,
  createPendingNativeInteractionRequest,
  getNativeInteractionRequest,
} from './native-interaction-state.ts'

type RuntimeLike = {
  session: { sessionFile?: string | undefined }
}

const nativeAskQuestionsKind = 'howcode.ask_questions'

export function getNativeAskQuestionsRequest(
  runtime: RuntimeLike,
): NativeAskQuestionsRequest | null {
  const request = getNativeInteractionRequest(runtime, nativeAskQuestionsKind)
  if (!request || !isNativeAskQuestionsRequest(request.payload)) return null
  return request.payload
}

export function createPendingNativeAskQuestionsRequest(
  sessionPath: string,
  request: NativeAskQuestionsRequest,
  options: { signal?: AbortSignal } = {},
) {
  return createPendingNativeInteractionRequest<string[][]>(
    sessionPath,
    {
      id: request.id,
      kind: nativeAskQuestionsKind,
      title: 'Ask questions',
      payload: request,
    },
    { ...options, supersedeKind: true },
  )
}

export function answerNativeAskQuestions(
  runtime: RuntimeLike,
  requestId: string,
  answers: string[][] | null,
) {
  return answerNativeInteraction(runtime, requestId, answers)
}

function isNativeAskQuestionsRequest(value: unknown): value is NativeAskQuestionsRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    Array.isArray((value as { questions?: unknown }).questions)
  )
}
