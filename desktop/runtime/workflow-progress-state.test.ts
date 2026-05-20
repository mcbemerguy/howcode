import { mkdirSync, mkdtempSync, readFileSync, truncateSync, writeFileSync } from 'node:fs'
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

function createRuntime(
  sessionFile = `/tmp/session-${Date.now()}-${Math.random()}.json`,
  cwd = '/tmp/project',
) {
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
    cwd,
    session,
    chatGroupId: null,
  }
}

function writeReviewFixFixture(agentDir: string, cwd: string) {
  const runDir = join(agentDir, 'workflow-runs', 'review-fix-20260519225734-ffm6gv')
  const auditPath = join(runDir, 'audit.md')
  const eventsPath = join(runDir, 'events.jsonl')
  mkdirSync(runDir, { recursive: true })
  const fixture = readFileSync(
    new URL('./fixtures/review-fix-minimized-events.jsonl', import.meta.url),
    'utf8',
  )
  const jsonStringContent = (value: string) => JSON.stringify(value).slice(1, -1)
  writeFileSync(
    eventsPath,
    fixture
      .replaceAll('__PI_UI_BRIDGE_FIXTURE_CWD__', jsonStringContent(cwd))
      .replaceAll('__PI_UI_BRIDGE_RUN_DIR__', jsonStringContent(runDir))
      .replaceAll('__PI_UI_BRIDGE_AUDIT_PATH__', jsonStringContent(auditPath))
      .replaceAll('__PI_UI_BRIDGE_EVENTS_PATH__', jsonStringContent(eventsPath)),
  )
  writeFileSync(auditPath, '# Audit\n')
  return { auditPath, eventsPath, runDir }
}

function writeRunJsonFixture(runDir: string, cwd: string, overrides: Record<string, unknown> = {}) {
  const run = {
    id: 'run-json-1',
    workflowId: 'review-fix',
    status: 'running',
    cwd,
    runDir,
    auditPath: join(runDir, 'audit.md'),
    startedAt: '2026-05-19T00:00:00.000Z',
    currentStepIndex: 0,
    steps: [
      {
        id: 'code',
        index: 0,
        status: 'running',
        type: 'agent',
        startedAt: '2026-05-19T00:00:01.000Z',
        childSessionId: 'run-json-child',
        childSessionPath: join(runDir, 'sessions', 'run-json-child.jsonl'),
      },
    ],
    ...overrides,
  }
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(run, null, 2))
  writeFileSync(join(runDir, 'audit.md'), '# Audit\n')
  return run
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
      childSessionPath: '/tmp/run-1/sessions/child-1.jsonl',
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
      childSessionPath: '/tmp/run-1/sessions/child-1.jsonl',
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

  test('retains terminal workflow cards long enough to open artifacts', () => {
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
        detailPath: '/tmp/run-expired/events.jsonl',
        detailKind: 'workflow-jsonl',
        status: 'completed',
      },
    })

    expect(
      getWorkflowProgressRuns(runtime as never, Date.parse('2026-05-19T00:02:00.000Z')),
    ).toMatchObject([
      {
        auditPath: '/tmp/run-expired/audit.md',
        detailPath: '/tmp/run-expired/events.jsonl',
        terminal: true,
      },
    ])
    expect(
      getWorkflowProgressRuns(runtime as never, Date.parse('2026-05-19T00:11:00.000Z')),
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
      childSessionId: 'bridge-child',
      childSessionPath: '/tmp/bridge-run/sessions/bridge-child.jsonl',
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
        childSessionId: 'bridge-child',
        childSessionPath: '/tmp/bridge-run/sessions/bridge-child.jsonl',
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
          childSessionId: 'events-child',
          childSessionPath: join(directory, 'sessions', 'events-child.jsonl'),
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
      childSessionId: 'events-child',
      childSessionPath: join(directory, 'sessions', 'events-child.jsonl'),
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
          childSessionId: 'artifact-child',
          childSessionPath: join(runDir, 'sessions', 'artifact-child.jsonl'),
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
        childSessionPath: join(runDir, 'sessions', 'artifact-child.jsonl'),
        detailPath: eventsPath,
      },
    ])
  })

  test('recovers run.json summary without reading oversized events.jsonl', () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'howcode-agent-dir-'))
    const cwd = join(agentDir, 'project')
    const runDir = join(agentDir, 'workflow-runs', 'huge-events-run')
    mkdirSync(runDir, { recursive: true })
    const eventsPath = join(runDir, 'events.jsonl')
    writeRunJsonFixture(runDir, cwd, {
      id: 'huge-events-run',
      workflowId: 'code-review-fix',
    })
    writeFileSync(eventsPath, '')
    truncateSync(eventsPath, 16 * 1024 * 1024 + 1)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      expect(
        recoverWorkflowProgressFromArtifacts({
          agentDir,
          cwd,
          nowMs: Date.now(),
        }),
      ).toMatchObject([
        {
          runId: 'huge-events-run',
          workflowId: 'code-review-fix',
          currentStepId: 'code',
          status: 'running',
          childSessionId: 'run-json-child',
          childSessionPath: join(runDir, 'sessions', 'run-json-child.jsonl'),
          detailPath: eventsPath,
          detailKind: 'workflow-jsonl',
        },
      ])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipping events.jsonl'))
    } finally {
      warn.mockRestore()
    }
  })

  test('isolates malformed artifacts while recovering valid sibling artifacts', () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'howcode-agent-dir-'))
    const cwd = join(agentDir, 'project')
    const badRunDir = join(agentDir, 'workflow-runs', 'bad-run')
    const goodRunDir = join(agentDir, 'workflow-runs', 'good-run')
    mkdirSync(badRunDir, { recursive: true })
    mkdirSync(goodRunDir, { recursive: true })
    writeFileSync(join(badRunDir, 'run.json'), '{not json')
    writeRunJsonFixture(goodRunDir, cwd, { id: 'good-run' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      expect(
        recoverWorkflowProgressFromArtifacts({
          agentDir,
          cwd,
          nowMs: Date.now(),
        }),
      ).toMatchObject([
        {
          runId: 'good-run',
          workflowId: 'review-fix',
          currentStepId: 'code',
        },
      ])
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  test('overlays small events.jsonl details onto run.json recovery', () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'howcode-agent-dir-'))
    const cwd = join(agentDir, 'project')
    const runDir = join(agentDir, 'workflow-runs', 'overlay-run')
    mkdirSync(runDir, { recursive: true })
    const eventsPath = join(runDir, 'events.jsonl')
    writeRunJsonFixture(runDir, cwd, { id: 'overlay-run' })
    writeFileSync(
      eventsPath,
      [
        JSON.stringify({
          timestamp: '2026-05-19T00:00:00.000Z',
          type: 'artifact_initialized',
          runId: 'overlay-run',
          workflowId: 'review-fix',
          cwd,
        }),
        JSON.stringify({
          timestamp: '2026-05-19T00:00:02.000Z',
          type: 'step_update',
          runId: 'overlay-run',
          workflowId: 'review-fix',
          stepId: 'review',
          stepType: 'agent',
          status: 'running',
          activity: 'Running review step',
          currentTool: 'bash',
          childSessionId: 'child-overlay',
          childSessionPath: join(runDir, 'sessions', 'child-overlay.jsonl'),
          elapsedMs: 2000,
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
        runId: 'overlay-run',
        currentStepId: 'review',
        currentStepType: 'agent',
        activity: 'Running review step',
        currentTool: 'bash',
        childSessionId: 'child-overlay',
        childSessionPath: join(runDir, 'sessions', 'child-overlay.jsonl'),
        elapsedMs: 2000,
      },
    ])
  })

  test('does not let non-progress events.jsonl lines clobber run.json recovery', () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'howcode-agent-dir-'))
    const cwd = join(agentDir, 'project')
    const runDir = join(agentDir, 'workflow-runs', 'artifact-only-run')
    mkdirSync(runDir, { recursive: true })
    const eventsPath = join(runDir, 'events.jsonl')
    writeRunJsonFixture(runDir, cwd, {
      id: 'artifact-only-run',
      status: 'completed',
      endedAt: '2026-05-19T00:00:05.000Z',
      steps: [
        {
          id: 'code',
          index: 0,
          status: 'completed',
          type: 'agent',
          startedAt: '2026-05-19T00:00:01.000Z',
          endedAt: '2026-05-19T00:00:05.000Z',
        },
      ],
    })
    writeFileSync(
      eventsPath,
      JSON.stringify({
        timestamp: '2026-05-19T00:00:00.000Z',
        type: 'artifact_initialized',
        runId: 'artifact-only-run',
        workflowId: 'review-fix',
        cwd,
      }),
    )

    expect(
      recoverWorkflowProgressFromArtifacts({
        agentDir,
        cwd,
        nowMs: Date.now(),
      }),
    ).toMatchObject([
      {
        runId: 'artifact-only-run',
        workflowId: 'review-fix',
        currentStepId: 'code',
        currentStepStatus: null,
        status: 'completed',
        activity: 'completed',
        detailPath: eventsPath,
        terminal: true,
      },
    ])
  })

  test('does not let incomplete events regress terminal run.json recovery', () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'howcode-agent-dir-'))
    const cwd = join(agentDir, 'project')
    const runDir = join(agentDir, 'workflow-runs', 'terminal-summary-run')
    mkdirSync(runDir, { recursive: true })
    const eventsPath = join(runDir, 'events.jsonl')
    writeRunJsonFixture(runDir, cwd, {
      id: 'terminal-summary-run',
      status: 'completed',
      currentStepIndex: 1,
      endedAt: '2026-05-19T00:00:05.000Z',
      steps: [
        {
          id: 'code',
          index: 0,
          status: 'completed',
          type: 'agent',
          startedAt: '2026-05-19T00:00:01.000Z',
          endedAt: '2026-05-19T00:00:03.000Z',
        },
        {
          id: 'double-check-and-fix',
          index: 1,
          status: 'completed',
          type: 'agent',
          startedAt: '2026-05-19T00:00:03.000Z',
          endedAt: '2026-05-19T00:00:05.000Z',
        },
      ],
    })
    writeFileSync(
      eventsPath,
      [
        JSON.stringify({
          timestamp: '2026-05-19T00:00:00.000Z',
          type: 'run_start',
          runId: 'terminal-summary-run',
          workflowId: 'review-fix',
          runDir,
          auditPath: join(runDir, 'audit.md'),
          detailPath: eventsPath,
          detailKind: 'workflow-jsonl',
          status: 'running',
        }),
        JSON.stringify({
          timestamp: '2026-05-19T00:00:02.000Z',
          type: 'step_update',
          runId: 'terminal-summary-run',
          workflowId: 'review-fix',
          stepId: 'code',
          stepType: 'agent',
          status: 'running',
          activity: 'Still running in stale events',
          currentTool: 'bash',
          childSessionId: 'stale-child-session',
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
        runId: 'terminal-summary-run',
        workflowId: 'review-fix',
        currentStepId: 'double-check-and-fix',
        currentStepType: 'agent',
        currentStepStatus: null,
        status: 'completed',
        activity: 'completed',
        currentTool: null,
        childSessionId: null,
        childSessionPath: null,
        detailPath: eventsPath,
        terminal: true,
      },
    ])
  })

  test('does not throw subscription when artifact discovery fails', () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'howcode-agent-dir-'))
    writeFileSync(join(agentDir, 'workflow-runs'), 'not a directory')
    const runtime = createRuntime(join(agentDir, 'session.json'), join(agentDir, 'project'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      expect(() =>
        subscribeRuntimeWorkflowProgress(runtime as never, vi.fn(), { agentDir }),
      ).not.toThrow()
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  test('recovers the review-fix regression fixture for the active runtime cwd on subscription', () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'howcode-agent-dir-'))
    const cwd = join(agentDir, 'project')
    const { auditPath, eventsPath } = writeReviewFixFixture(agentDir, cwd)
    const runtime = createRuntime(join(agentDir, 'session.json'), cwd)
    const onStateChange = vi.fn()

    subscribeRuntimeWorkflowProgress(runtime as never, onStateChange, { agentDir })

    expect(onStateChange).toHaveBeenCalledTimes(1)
    expect(getWorkflowProgressRuns(runtime as never)).toMatchObject([
      {
        runId: 'review-fix-20260519225734-ffm6gv',
        workflowId: 'review-fix',
        auditPath,
        detailPath: eventsPath,
        currentStepId: 'double-check-and-fix',
        currentStepStatus: null,
        status: 'completed',
        activity: 'completed',
        childSessionId: '019e4276-5f71-70d9-ad40-02d302bac4e4',
        elapsedMs: 65243,
        terminal: true,
      },
    ])

    const otherRuntime = createRuntime(
      join(agentDir, 'other-session.json'),
      join(agentDir, 'other'),
    )
    subscribeRuntimeWorkflowProgress(otherRuntime as never, vi.fn(), { agentDir })
    expect(getWorkflowProgressRuns(otherRuntime as never)).toEqual([])
  })

  test.skipIf(process.platform === 'win32' || process.platform === 'darwin')(
    'does not recover artifacts from a different project path that only differs by case',
    () => {
      const agentDir = mkdtempSync(join(tmpdir(), 'howcode-agent-dir-'))
      const artifactCwd = join(agentDir, 'project')
      const runtimeCwd = join(agentDir, 'Project')
      const runDir = join(agentDir, 'workflow-runs', 'review-fix-case')
      mkdirSync(runDir, { recursive: true })
      writeFileSync(
        join(runDir, 'events.jsonl'),
        [
          JSON.stringify({
            timestamp: '2026-05-19T00:00:00.000Z',
            type: 'artifact_initialized',
            runId: 'review-fix-case',
            workflowId: 'review-fix',
            cwd: artifactCwd,
          }),
          JSON.stringify({
            timestamp: '2026-05-19T00:00:01.000Z',
            type: 'step_update',
            runId: 'review-fix-case',
            workflowId: 'review-fix',
            status: 'running',
          }),
        ].join('\n'),
      )

      expect(
        recoverWorkflowProgressFromArtifacts({
          agentDir,
          cwd: runtimeCwd,
          nowMs: Date.now(),
        }),
      ).toEqual([])
    },
  )
})
