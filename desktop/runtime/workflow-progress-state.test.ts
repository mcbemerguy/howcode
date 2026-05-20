import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { createPiUiBridgeExtensionFactories } from '../runtime-host/pi-ui-bridge-host.ts'
import { buildComposerState } from './composer-state.ts'
import {
  applyWorkflowProgressEvent,
  getWorkflowProgressRuns,
  recordRuntimeWorkflowProgressBridgeEvent,
  recoverWorkflowProgressFromArtifacts,
  recoverWorkflowProgressFromEventsFile,
  subscribeRuntimeWorkflowProgress,
} from './workflow-progress-state.ts'

function createRuntime(sessionFile = `/tmp/session-${Date.now()}-${Math.random()}.json`) {
  const model = {
    provider: 'test',
    id: 'test-model',
    name: 'Test model',
    reasoning: false,
    input: ['text'],
  }
  const session = {
    sessionFile,
    model,
    modelRegistry: { getAvailable: async () => [model] },
    thinkingLevel: 'off',
    getAvailableThinkingLevels: () => ['off'],
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    getContextUsage: () => null,
    isCompacting: false,
  }
  return {
    cwd: '/tmp/project',
    session,
    chatGroupId: null,
  }
}

describe('workflow progress state', () => {
  test('maps run and step events into a progress summary', () => {
    const run = applyWorkflowProgressEvent(undefined, {
      type: 'run_start',
      runId: 'run-1',
      workflowId: 'review-fix',
      runDir: '/tmp/run-1',
      auditPath: '/tmp/run-1/audit.md',
      detailPath: '/tmp/run-1/events.jsonl',
      detailKind: 'workflow-jsonl',
      status: 'running',
      elapsedMs: 0,
    })
    const step = applyWorkflowProgressEvent(run ?? undefined, {
      type: 'step_update',
      runId: 'run-1',
      workflowId: 'review-fix',
      stepId: 'code',
      stepType: 'agent',
      status: 'running',
      activity: 'Running tool',
      currentTool: 'bash',
      childSessionId: 'child-1',
      elapsedMs: 1234,
    })

    expect(step).toMatchObject({
      runId: 'run-1',
      workflowId: 'review-fix',
      currentStepId: 'code',
      currentStepType: 'agent',
      currentStepStatus: 'running',
      activity: 'Running tool',
      currentTool: 'bash',
      childSessionId: 'child-1',
      elapsedMs: 1234,
      terminal: false,
    })
  })

  test('does not treat completed step events as terminal run states', () => {
    const running = applyWorkflowProgressEvent(undefined, {
      type: 'run_start',
      runId: 'run-1',
      workflowId: 'review-fix',
      status: 'running',
    })
    const step = applyWorkflowProgressEvent(running ?? undefined, {
      type: 'step_end',
      runId: 'run-1',
      workflowId: 'review-fix',
      stepId: 'code',
      status: 'completed',
    })

    expect(step).toMatchObject({
      status: 'running',
      currentStepStatus: 'completed',
      terminal: false,
    })
  })

  test('marks terminal run states', () => {
    const running = applyWorkflowProgressEvent(undefined, {
      type: 'run_start',
      runId: 'run-1',
      workflowId: 'review-fix',
      status: 'running',
    })
    const aborted = applyWorkflowProgressEvent(running ?? undefined, {
      type: 'run_end',
      runId: 'run-1',
      workflowId: 'review-fix',
      status: 'aborted',
      elapsedMs: 5000,
    })

    expect(aborted).toMatchObject({
      status: 'aborted',
      currentStepStatus: null,
      terminal: true,
    })
  })

  test('expires terminal workflow cards after the retention window', () => {
    const runtime = createRuntime()
    recordRuntimeWorkflowProgressBridgeEvent(runtime as never, {
      type: 'workflow:running-task',
      timestamp: '2026-05-19T00:00:00.000Z',
      payload: {
        type: 'run_end',
        runId: 'run-expired',
        workflowId: 'review-fix',
        runDir: '/tmp/run-expired',
        auditPath: '/tmp/run-expired/audit.md',
        status: 'completed',
      },
    })

    expect(
      getWorkflowProgressRuns(runtime as never, Date.parse('2026-05-19T00:00:30.000Z')),
    ).toHaveLength(1)
    expect(
      getWorkflowProgressRuns(runtime as never, Date.parse('2026-05-19T00:02:00.000Z')),
    ).toHaveLength(0)
  })

  test('does not subscribe to private extension runner runtime events', () => {
    const runtime = {
      cwd: '/tmp/project',
      session: {
        sessionFile: `/tmp/session-${Date.now()}-${Math.random()}.json`,
        get extensionRunner() {
          throw new Error('private runtime event bus must not be used')
        },
      },
    }

    expect(() => subscribeRuntimeWorkflowProgress(runtime as never, () => undefined)).not.toThrow()
  })

  test('routes generic bridge workflow events into composer state', async () => {
    const runtime = createRuntime()
    const onStateChange = vi.fn()
    const handlers = new Map<string, (value: unknown) => unknown>()
    const shutdownHandlers: Array<() => void> = []
    const factories = await createPiUiBridgeExtensionFactories({
      agentDir: resolve(process.cwd(), '../../agent'),
      getRuntime: () => runtime,
      onStateChange,
    })

    factories[0]?.({
      events: {
        on: (channel: string, handler: (value: unknown) => unknown) => {
          handlers.set(channel, handler)
          return () => handlers.delete(channel)
        },
      },
      on: (event: string, handler: () => void) => {
        if (event === 'session_shutdown') shutdownHandlers.push(handler)
      },
    } as never)

    await handlers.get('workflow:running-task')?.({
      type: 'step_update',
      runId: 'bridge-run',
      workflowId: 'review-fix',
      runDir: '/tmp/bridge-run',
      auditPath: '/tmp/bridge-run/audit.md',
      detailPath: '/tmp/bridge-run/events.jsonl',
      detailKind: 'workflow-jsonl',
      stepId: 'code',
      stepType: 'agent',
      status: 'running',
      activity: 'Running code step',
      currentTool: 'bash',
      elapsedMs: 42,
    })

    const composer = await buildComposerState(runtime as never, { includeContextUsage: false })
    expect(onStateChange).toHaveBeenCalledTimes(1)
    expect(composer.workflowProgressRuns).toMatchObject([
      {
        runId: 'bridge-run',
        workflowId: 'review-fix',
        currentStepId: 'code',
        currentStepStatus: 'running',
        activity: 'Running code step',
        currentTool: 'bash',
      },
    ])

    for (const handler of shutdownHandlers) handler()
    expect(handlers.has('workflow:running-task')).toBe(false)
  })

  test('recovers the latest state from events.jsonl artifacts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'howcode-workflow-progress-'))
    const eventsPath = join(directory, 'events.jsonl')
    writeFileSync(
      eventsPath,
      [
        JSON.stringify({
          timestamp: '2026-05-19T00:00:00.000Z',
          type: 'run_start',
          runId: 'run-2',
          workflowId: 'code-review-fix',
          runDir: directory,
          auditPath: join(directory, 'audit.md'),
          detailPath: eventsPath,
          detailKind: 'workflow-jsonl',
          status: 'running',
        }),
        JSON.stringify({
          timestamp: '2026-05-19T00:00:01.000Z',
          type: 'step_end',
          runId: 'run-2',
          workflowId: 'code-review-fix',
          stepId: 'code',
          status: 'completed',
          elapsedMs: 1000,
        }),
        JSON.stringify({
          timestamp: '2026-05-19T00:00:02.000Z',
          type: 'run_end',
          runId: 'run-2',
          workflowId: 'code-review-fix',
          status: 'completed',
          elapsedMs: 2000,
        }),
      ].join('\n'),
    )

    expect(recoverWorkflowProgressFromEventsFile(eventsPath)).toMatchObject({
      runId: 'run-2',
      workflowId: 'code-review-fix',
      auditPath: join(directory, 'audit.md'),
      detailPath: eventsPath,
      status: 'completed',
      elapsedMs: 2000,
      terminal: true,
    })
  })

  test('discovers matching workflow artifacts from the Pi workflow-runs directory', () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'howcode-agent-dir-'))
    const cwd = join(agentDir, 'project')
    const runDir = join(agentDir, 'workflow-runs', 'review-fix-1')
    mkdirSync(runDir, { recursive: true })
    const eventsPath = join(runDir, 'events.jsonl')
    writeFileSync(
      eventsPath,
      [
        JSON.stringify({
          timestamp: '2026-05-19T00:00:00.000Z',
          type: 'artifact_initialized',
          runId: 'review-fix-1',
          workflowId: 'review-fix',
          cwd,
        }),
        JSON.stringify({
          timestamp: '2026-05-19T00:00:01.000Z',
          type: 'step_update',
          runId: 'review-fix-1',
          workflowId: 'review-fix',
          stepId: 'code',
          status: 'running',
          activity: 'Running code step',
        }),
      ].join('\n'),
    )

    expect(
      recoverWorkflowProgressFromArtifacts({
        agentDir,
        cwd,
        nowMs: Date.now(),
      }),
    ).toMatchObject([
      {
        runId: 'review-fix-1',
        workflowId: 'review-fix',
        currentStepId: 'code',
        status: 'running',
        detailPath: eventsPath,
      },
    ])
  })
})
