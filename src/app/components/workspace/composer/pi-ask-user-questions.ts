import type {
  NativeAskQuestion,
  NativeInteractionRequest,
  PiAskUserQuestionsPayload,
  PiAskUserQuestionsResponse,
} from '../../../desktop/types'

const piAskUserQuestionsKind = 'ask_user_questions'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getRecordValue(record: Record<string, unknown>, key: string) {
  return record[key]
}

function isPiAskUserQuestionsPayload(value: unknown): value is PiAskUserQuestionsPayload {
  if (!isRecord(value)) return false
  const questions = getRecordValue(value, 'questions')
  if (!Array.isArray(questions)) return false
  return questions.every((question) => {
    if (!isRecord(question)) return false
    const id = getRecordValue(question, 'id')
    const text = getRecordValue(question, 'question')
    const alternatives = getRecordValue(question, 'alternatives')
    return typeof id === 'string' && typeof text === 'string' && Array.isArray(alternatives)
  })
}

export function getPiAskUserQuestionsRequest(
  requests: NativeInteractionRequest[],
): (NativeInteractionRequest & { payload: PiAskUserQuestionsPayload }) | null {
  const request = requests.find((item) => item.kind === piAskUserQuestionsKind)
  if (!(request && isPiAskUserQuestionsPayload(request.payload))) return null
  return request as NativeInteractionRequest & { payload: PiAskUserQuestionsPayload }
}

export function toPiAskUserQuestionsCardQuestions(
  payload: PiAskUserQuestionsPayload,
): NativeAskQuestion[] {
  return payload.questions.map((question) => ({
    id: question.id,
    question: question.question,
    options: question.alternatives
      .filter((alternative) => !alternative.isOther)
      .map((alternative) => ({ label: alternative.text })),
  }))
}

export function toPiAskUserQuestionsResponse(
  payload: PiAskUserQuestionsPayload,
  answers: string[][] | null,
): PiAskUserQuestionsResponse {
  if (!answers || answers.length !== payload.questions.length) return { status: 'denied' }
  if (answers.some((answer) => !answer[0]?.trim())) return { status: 'denied' }

  return {
    status: 'confirmed',
    answers: payload.questions.map((question, index) => {
      const answer = answers[index]?.[0]?.trim() ?? ''
      const selected = question.alternatives.find(
        (option) => !option.isOther && option.text === answer,
      )
      const fallback =
        question.alternatives.find((option) => option.isOther) ?? question.alternatives[0]
      if (!fallback) {
        return {
          questionId: question.id,
          question: question.question,
          selectedIndex: -1,
          selectedOriginalIndex: null,
          answer,
          fromOther: true,
          edited: true,
        }
      }

      const selectedAlternative = selected ?? fallback
      const selectedIndex = question.alternatives.indexOf(selectedAlternative)
      return {
        questionId: question.id,
        question: question.question,
        selectedIndex,
        selectedOriginalIndex: selectedAlternative.originalIndex,
        answer: answer || selectedAlternative.text,
        fromOther: selectedAlternative.isOther,
        edited:
          selectedAlternative.isOther ||
          (answer || selectedAlternative.text) !== selectedAlternative.text,
      }
    }),
  }
}
