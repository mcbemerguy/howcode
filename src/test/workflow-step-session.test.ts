// Pi UI bridge Howcode adapter. Managed by integrations/howcode/scripts/patch-howcode.mjs.
import { describe, expect, it } from 'vitest'
import { selectActiveWorkflowStepSession } from '../app/app-shell/workflow-step-session'
import type { ComposerState, PiWorkflowProgressRun } from '../app/desktop/types'

function workflowRun(overrides: Partial<PiWorkflowProgressRun> = {}): PiWorkflowProgressRun {
  return {
    runId: 'run-1',
    workflowId: 'review-fix',
    runDir: null,
    auditPath: null,
    detailPath: null,
    detailKind: null,
    currentStepId: 'code',
    currentStepType: 'agent',
    currentStepStatus: 'running',
    status: 'running',
    activity: null,
    currentTool: null,
    childSessionId: 'child-1',
    childSessionPath: 'C:\\Users\\me\\.pi\\agent\\workflow-runs\\run\\sessions\\child.jsonl',
    elapsedMs: null,
    error: null,
    updatedAt: '2026-05-20T12:00:00.000Z',
    terminal: false,
    ...overrides,
  }
}

function composerState(runs: PiWorkflowProgressRun[]): ComposerState {
  return {
    currentModel: null,
    availableModels: [],
    currentThinkingLevel: 'off',
    availableThinkingLevels: [],
    queuedPrompts: [],
    bridge: {
      nativeInteractionRequests: [],
      nativeAskQuestionsRequest: null,
      workflowProgressRuns: runs,
      piNotifications: [],
    },
    contextUsage: null,
    isCompacting: false,
    isExtensionCommandRunning: false,
  }
}

describe('workflow step session selection', () => {
  it('selects the newest non-terminal workflow child session path', () => {
    expect(
      selectActiveWorkflowStepSession(
        composerState([
          workflowRun({ runId: 'older', childSessionPath: '/tmp/older.jsonl' }),
          workflowRun({
            runId: 'terminal',
            childSessionPath: '/tmp/terminal.jsonl',
            terminal: true,
            updatedAt: '2026-05-20T12:02:00.000Z',
          }),
          workflowRun({
            runId: 'newer',
            currentStepId: 'review',
            childSessionPath: '/tmp/newer.jsonl',
            updatedAt: '2026-05-20T12:01:00.000Z',
          }),
        ]),
      ),
    ).toEqual({
      runId: 'newer',
      workflowId: 'review-fix',
      stepId: 'review',
      stepStatus: 'running',
      sessionPath: '/tmp/newer.jsonl',
    })
  })

  it('does not select terminal or missing child sessions', () => {
    expect(
      selectActiveWorkflowStepSession(
        composerState([
          workflowRun({ childSessionPath: null }),
          workflowRun({ childSessionPath: '/tmp/done.jsonl', terminal: true }),
        ]),
      ),
    ).toBeNull()
  })
})
