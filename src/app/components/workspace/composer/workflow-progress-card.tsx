import type { PiWorkflowProgressRun } from '../../../../../shared/desktop-contracts'
import { openPathQuery } from '../../../query/desktop-query'

type WorkflowProgressCardProps = {
  runs: PiWorkflowProgressRun[]
  stopping: boolean
  onStop: () => void
}

function formatElapsed(ms: number | null) {
  if (ms === null) return '—'
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes === 0) return `${remainingSeconds}s`
  return `${minutes}m ${remainingSeconds}s`
}

function workflowStatusLabel(run: PiWorkflowProgressRun) {
  if (run.error) return 'failed'
  return run.status || (run.terminal ? 'completed' : 'running')
}

function workflowActivity(run: PiWorkflowProgressRun) {
  if (run.activity) return run.activity
  if (run.currentTool) return `Tool: ${run.currentTool}`
  if (run.currentStepId) return `Step ${run.currentStepId}`
  return run.terminal ? 'Workflow finished' : 'Workflow running'
}

function WorkflowProgressActions({
  run,
  stopping,
  onStop,
}: WorkflowProgressCardProps & { run: PiWorkflowProgressRun }) {
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {run.terminal ? null : (
        <button
          type="button"
          className="rounded-full border border-[color:var(--border)] px-3 py-1 text-xs text-[color:var(--text)] hover:bg-[color:var(--hover)] disabled:opacity-50"
          disabled={stopping}
          onClick={onStop}
        >
          {stopping ? 'Stopping…' : 'Stop'}
        </button>
      )}
      {run.auditPath ? (
        <button
          type="button"
          className="rounded-full border border-[color:var(--border)] px-3 py-1 text-xs text-[color:var(--text-muted)] hover:bg-[color:var(--hover)]"
          onClick={() => void openPathQuery(run.auditPath ?? '')}
        >
          Open audit
        </button>
      ) : null}
      {run.detailPath && run.detailPath !== run.auditPath ? (
        <button
          type="button"
          className="rounded-full border border-[color:var(--border)] px-3 py-1 text-xs text-[color:var(--text-muted)] hover:bg-[color:var(--hover)]"
          onClick={() => void openPathQuery(run.detailPath ?? '')}
        >
          Open detail
        </button>
      ) : null}
    </div>
  )
}

function WorkflowProgressRunCard({
  run,
  stopping,
  onStop,
}: WorkflowProgressCardProps & { run: PiWorkflowProgressRun }) {
  return (
    <section
      className="rounded-2xl border border-[color:var(--accent-border)] bg-[color:var(--panel)] p-3 text-sm shadow-sm"
      aria-label={`Workflow ${run.workflowId} progress`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-[color:var(--text)]">Workflow</span>
            <span className="rounded-full bg-[color:var(--accent-muted)] px-2 py-0.5 text-xs text-[color:var(--text-muted)]">
              {workflowStatusLabel(run)}
            </span>
          </div>
          <div className="mt-1 truncate text-xs text-[color:var(--text-muted)]">
            {run.workflowId} · {run.runId}
          </div>
        </div>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs text-[color:var(--text-muted)] sm:grid-cols-4">
        <div>
          <dt>Step</dt>
          <dd className="truncate text-[color:var(--text)]">{run.currentStepId ?? '—'}</dd>
        </div>
        <div>
          <dt>Step status</dt>
          <dd className="truncate text-[color:var(--text)]">{run.currentStepStatus ?? '—'}</dd>
        </div>
        <div>
          <dt>Elapsed</dt>
          <dd className="truncate text-[color:var(--text)]">{formatElapsed(run.elapsedMs)}</dd>
        </div>
        <div>
          <dt>Child session</dt>
          <dd className="truncate text-[color:var(--text)]">{run.childSessionId ?? '—'}</dd>
        </div>
      </dl>
      <div className="mt-3 text-xs text-[color:var(--text-muted)]">
        <span className="text-[color:var(--text)]">{workflowActivity(run)}</span>
        {run.currentTool ? <span> · {run.currentTool}</span> : null}
        {run.error ? <span className="text-[color:var(--danger)]"> · {run.error}</span> : null}
      </div>
      <WorkflowProgressActions runs={[]} run={run} stopping={stopping} onStop={onStop} />
    </section>
  )
}

export function WorkflowProgressCard({ runs, stopping, onStop }: WorkflowProgressCardProps) {
  if (runs.length === 0) return null
  const activeRuns = runs.filter((run) => !run.terminal)
  const visibleRuns = activeRuns.length > 0 ? activeRuns : runs.slice(-1)

  return (
    <div className="mb-2 grid gap-2">
      {visibleRuns.map((run) => (
        <WorkflowProgressRunCard
          key={run.runId}
          runs={runs}
          run={run}
          stopping={stopping}
          onStop={onStop}
        />
      ))}
    </div>
  )
}
