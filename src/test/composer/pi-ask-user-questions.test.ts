import { describe, expect, it } from 'vitest'
import {
  getPiAskUserQuestionsRequest,
  toPiAskUserQuestionsCardQuestions,
  toPiAskUserQuestionsResponse,
} from '../../app/components/workspace/composer/pi-ask-user-questions'
import type { NativeInteractionRequest, PiAskUserQuestionsPayload } from '../../app/desktop/types'

const payload: PiAskUserQuestionsPayload = {
  questions: [
    {
      id: 'q1',
      question: 'Choose one',
      alternatives: [
        { text: 'Alpha', recommended: true, isOther: false, originalIndex: 0 },
        { text: 'Beta', recommended: false, isOther: false, originalIndex: 1 },
        { text: 'Other', recommended: false, isOther: true, originalIndex: null },
      ],
    },
  ],
}

describe('Pi ask_user_questions composer adapter', () => {
  it('finds native interaction requests and maps card options without making legacy answers canonical', () => {
    const request: NativeInteractionRequest = {
      id: 'request-1',
      kind: 'ask_user_questions',
      payload,
    }

    expect(getPiAskUserQuestionsRequest([request])?.id).toBe('request-1')
    expect(toPiAskUserQuestionsCardQuestions(payload)).toEqual([
      {
        id: 'q1',
        question: 'Choose one',
        options: [{ label: 'Alpha' }, { label: 'Beta' }],
      },
    ])
  })

  it('normalizes selected options into Pi-shaped confirmed responses', () => {
    expect(toPiAskUserQuestionsResponse(payload, [['Beta']])).toEqual({
      status: 'confirmed',
      answers: [
        {
          questionId: 'q1',
          question: 'Choose one',
          selectedIndex: 1,
          selectedOriginalIndex: 1,
          answer: 'Beta',
          fromOther: false,
          edited: false,
        },
      ],
    })
  })

  it('normalizes custom answers and dismissal into Pi-shaped responses', () => {
    expect(toPiAskUserQuestionsResponse(payload, [['Custom']])).toEqual({
      status: 'confirmed',
      answers: [
        {
          questionId: 'q1',
          question: 'Choose one',
          selectedIndex: 2,
          selectedOriginalIndex: null,
          answer: 'Custom',
          fromOther: true,
          edited: true,
        },
      ],
    })
    expect(toPiAskUserQuestionsResponse(payload, null)).toEqual({ status: 'denied' })
  })
})
