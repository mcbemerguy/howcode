import { describe, expect, test } from 'vitest'
import { getPiNotifications, recordPiNotificationEvent } from './pi-notification-state.ts'

function createRuntime(sessionFile = `/tmp/session-${Date.now()}-${Math.random()}.json`) {
  return { session: { sessionFile } }
}

describe('Pi notification state', () => {
  test('keeps workflow terminal audit and events links from generic bridge notifications', () => {
    const runtime = createRuntime()

    expect(
      recordPiNotificationEvent(runtime, {
        id: 'notification-1',
        type: 'notification',
        timestamp: '2026-05-19T00:00:00.000Z',
        payload: {
          event: 'workflow_completed',
          title: 'Workflow review-fix completed',
          message: 'Workflow run-1 completed. Audit: /tmp/run-1/audit.md',
          level: 'info',
          auditPath: '/tmp/run-1/audit.md',
          detailPath: '/tmp/run-1/events.jsonl',
          detailKind: 'workflow-jsonl',
        },
        source: { extension: 'workflows' },
      }),
    ).toBe(true)

    expect(getPiNotifications(runtime, Date.parse('2026-05-19T00:00:01.000Z'))).toMatchObject([
      {
        id: 'notification-1',
        event: 'workflow_completed',
        auditPath: '/tmp/run-1/audit.md',
        detailPath: '/tmp/run-1/events.jsonl',
        detailKind: 'workflow-jsonl',
        source: { extension: 'workflows' },
      },
    ])
  })

  test('retains final workflow notifications long enough for artifact access', () => {
    const runtime = createRuntime()
    recordPiNotificationEvent(runtime, {
      id: 'notification-2',
      type: 'notification',
      timestamp: '2026-05-19T00:00:00.000Z',
      payload: {
        event: 'workflow_failed',
        title: 'Workflow review-fix failed',
        message: 'Workflow failed. Audit: /tmp/run-2/audit.md',
        level: 'error',
        auditPath: '/tmp/run-2/audit.md',
      },
    })

    expect(getPiNotifications(runtime, Date.parse('2026-05-19T00:05:00.000Z'))).toHaveLength(1)
    expect(getPiNotifications(runtime, Date.parse('2026-05-19T00:11:00.000Z'))).toHaveLength(0)
  })
})
