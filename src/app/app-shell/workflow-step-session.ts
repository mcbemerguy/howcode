// Pi UI bridge Howcode adapter. Managed by integrations/howcode/scripts/patch-howcode.mjs.
import type { ComposerState, PiWorkflowProgressRun } from '../desktop/types'

export type ActiveWorkflowStepSession = {
  runId: string
  workflowId: string
  stepId: string | null
  stepStatus: string | null
  sessionPath: string
}

function normalizeSessionPath(sessionPath: string | null | undefined) {
  if (typeof sessionPath !== 'string') return null
  const trimmed = sessionPath.trim()
  return trimmed.length > 0 ? trimmed : null
}

function compareUpdatedAt(left: PiWorkflowProgressRun, right: PiWorkflowProgressRun) {
  return left.updatedAt.localeCompare(right.updatedAt)
}

export function selectActiveWorkflowStepSession(
  composerState: ComposerState | null | undefined,
): ActiveWorkflowStepSession | null {
  const run = [...(composerState?.bridge.workflowProgressRuns ?? [])]
    .filter((candidate) => !candidate.terminal && normalizeSessionPath(candidate.childSessionPath))
    .sort(compareUpdatedAt)
    .at(-1)
  const sessionPath = normalizeSessionPath(run?.childSessionPath)
  if (!(run && sessionPath)) return null
  return {
    runId: run.runId,
    workflowId: run.workflowId,
    stepId: run.currentStepId,
    stepStatus: run.currentStepStatus,
    sessionPath,
  }
}
