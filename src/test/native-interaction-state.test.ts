import { describe, expect, it } from 'vitest'
import {
  answerNativeInteraction,
  createPendingNativeInteractionRequest,
  getNativeInteractionRequests,
} from '../../desktop/runtime/native-interaction-state'

const runtime = { session: { sessionFile: 'native-interaction-test-session.jsonl' } }

describe('native interaction state', () => {
  it('publishes pending requests, resolves answers, and clears state', async () => {
    const pending = createPendingNativeInteractionRequest(runtime.session.sessionFile, {
      id: 'request-1',
      kind: 'ask_user_questions',
      payload: { questions: [] },
    })

    expect(getNativeInteractionRequests(runtime)).toEqual([
      { id: 'request-1', kind: 'ask_user_questions', payload: { questions: [] } },
    ])
    expect(answerNativeInteraction(runtime, 'request-1', { status: 'denied' })).toBe(true)
    await expect(pending).resolves.toEqual({ status: 'denied' })
    expect(getNativeInteractionRequests(runtime)).toEqual([])
  })

  it('resolves null and clears state on abort', async () => {
    const controller = new AbortController()
    const pending = createPendingNativeInteractionRequest(
      runtime.session.sessionFile,
      { id: 'request-2', kind: 'ask_user_questions', payload: { questions: [] } },
      { signal: controller.signal },
    )

    expect(getNativeInteractionRequests(runtime)).toHaveLength(1)
    controller.abort()
    await expect(pending).resolves.toBeNull()
    expect(getNativeInteractionRequests(runtime)).toEqual([])
  })
})
