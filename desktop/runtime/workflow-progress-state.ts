// Pi UI bridge Howcode adapter. Managed by integrations/howcode/scripts/patch-howcode.mjs.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { PiWorkflowProgressRun } from '../../shared/desktop-contracts.ts'
import type { PiRuntime } from './types.ts'

const lineBreakPattern = /\r?\n/
const workflowEventName = 'workflow:running-task'
const terminalStatuses = new Set(['completed', 'failed', 'aborted'])
const terminalRunRetentionMs = 60_000
const artifactRecoveryMaxAgeMs = 24 * 60 * 60 * 1000
const artifactRecoveryLimit = 100
const runsBySessionPath = new Map<string, Map<string, PiWorkflowProgressRun>>()

type RuntimeSessionLike = { session: { sessionFile?: string | undefined } }

type RawWorkflowEvent = {
  type?: unknown
  runId?: unknown
  workflowId?: unknown
  runDir?: unknown
  auditPath?: unknown
  stepId?: unknown
  stepType?: unknown
  status?: unknown
  elapsedMs?: unknown
  activity?: unknown
  currentTool?: unknown
  childSessionId?: unknown
  detailPath?: unknown
  detailKind?: unknown
  error?: unknown
  timestamp?: unknown
}

function asRecord(value: unknown) {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function asString(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asDetailKind(value: unknown) {
  return value === 'workflow-jsonl' || value === 'text' ? value : null
}

function unwrapWorkflowEvent(input: unknown) {
  const record = asRecord(input)
  if (!record || record['type'] !== workflowEventName) return input
  const payload = asRecord(record['payload'])
  if (!payload) return null
  return {
    ...payload,
    timestamp: asString(payload['timestamp']) ?? asString(record['timestamp']) ?? undefined,
  }
}

function normalizeEvent(input: unknown): RawWorkflowEvent | null {
  const unwrapped = unwrapWorkflowEvent(input)
  if (!unwrapped || typeof unwrapped !== 'object') return null
  const event = unwrapped as RawWorkflowEvent
  if (!(asString(event.runId) && asString(event.workflowId) && asString(event.type))) return null
  return event
}

function getRunIdentity(previous: PiWorkflowProgressRun | undefined, event: RawWorkflowEvent) {
  const runId = asString(event.runId) ?? previous?.runId ?? null
  const workflowId = asString(event.workflowId) ?? previous?.workflowId ?? null
  return runId && workflowId ? { runId, workflowId } : null
}

function getRunPaths(previous: PiWorkflowProgressRun | undefined, event: RawWorkflowEvent) {
  const detailPath = asString(event.detailPath) ?? previous?.detailPath ?? null
  return {
    auditPath: asString(event.auditPath) ?? previous?.auditPath ?? detailPath,
    detailKind: asDetailKind(event.detailKind) ?? previous?.detailKind ?? null,
    detailPath,
    runDir: asString(event.runDir) ?? previous?.runDir ?? null,
  }
}

function getRunStatus(previous: PiWorkflowProgressRun | undefined, event: RawWorkflowEvent) {
  const eventType = asString(event.type) ?? 'step_update'
  const eventStatus = asString(event.status)
  const runStatus = eventType === 'run_end' ? eventStatus : null
  const status =
    eventType === 'run_start' ? 'running' : (runStatus ?? previous?.status ?? 'running')
  return {
    eventType,
    status,
    stepStatus:
      eventType === 'run_end' ? null : (eventStatus ?? previous?.currentStepStatus ?? null),
    terminal: eventType === 'run_end' || terminalStatuses.has(status),
  }
}

function getRunActivity(previous: PiWorkflowProgressRun | undefined, event: RawWorkflowEvent) {
  return {
    activity: asString(event.activity) ?? previous?.activity ?? null,
    childSessionId: asString(event.childSessionId) ?? previous?.childSessionId ?? null,
    currentTool: asString(event.currentTool) ?? previous?.currentTool ?? null,
    error: asString(event.error) ?? previous?.error ?? null,
  }
}

export function applyWorkflowProgressEvent(
  previous: PiWorkflowProgressRun | undefined,
  input: unknown,
): PiWorkflowProgressRun | null {
  const event = normalizeEvent(input)
  if (!event) return previous ?? null
  const identity = getRunIdentity(previous, event)
  if (!identity) return previous ?? null

  const paths = getRunPaths(previous, event)
  const status = getRunStatus(previous, event)
  const activity = getRunActivity(previous, event)
  const next: PiWorkflowProgressRun = {
    ...identity,
    ...paths,
    currentStepId: asString(event.stepId) ?? previous?.currentStepId ?? null,
    currentStepType: asString(event.stepType) ?? previous?.currentStepType ?? null,
    currentStepStatus: status.stepStatus,
    status: status.status,
    ...activity,
    elapsedMs: asNumber(event.elapsedMs) ?? previous?.elapsedMs ?? null,
    updatedAt: asString(event.timestamp) ?? new Date().toISOString(),
    terminal: status.terminal,
  }

  if (status.eventType === 'run_end') {
    next.activity = next.error ? 'Workflow failed' : next.status
  }

  return next
}

function getSessionRuns(sessionPath: string) {
  let runs = runsBySessionPath.get(sessionPath)
  if (!runs) {
    runs = new Map()
    runsBySessionPath.set(sessionPath, runs)
  }
  return runs
}

export function recordRuntimeWorkflowProgressBridgeEvent(
  runtime: RuntimeSessionLike,
  input: unknown,
) {
  const sessionPath = runtime.session.sessionFile
  if (!sessionPath) return false
  const event = normalizeEvent(input)
  if (!event) return false
  const runId = asString(event.runId)
  if (!runId) return false
  const runs = getSessionRuns(sessionPath)
  const next = applyWorkflowProgressEvent(runs.get(runId), event)
  if (!next) return false
  runs.set(runId, next)
  return true
}

function isTerminalRunExpired(run: PiWorkflowProgressRun, nowMs: number) {
  if (!run.terminal) return false
  const updatedAtMs = Date.parse(run.updatedAt)
  if (!Number.isFinite(updatedAtMs)) return false
  return nowMs - updatedAtMs > terminalRunRetentionMs
}

export function getWorkflowProgressRuns(runtime: RuntimeSessionLike, nowMs = Date.now()) {
  const sessionPath = runtime.session.sessionFile
  if (!sessionPath) return []
  const runs = runsBySessionPath.get(sessionPath)
  if (!runs) return []
  for (const [runId, run] of runs) {
    if (isTerminalRunExpired(run, nowMs)) runs.delete(runId)
  }
  return [...runs.values()].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
}

function parseEventLine(line: string) {
  try {
    return JSON.parse(line) as unknown
  } catch {
    return null
  }
}

function recoverWorkflowProgressArtifact(
  eventsPath: string,
): { cwd: string | null; run: PiWorkflowProgressRun } | null {
  if (!existsSync(eventsPath)) return null
  let current: PiWorkflowProgressRun | null = null
  let cwd: string | null = null
  for (const line of readFileSync(eventsPath, 'utf8').split(lineBreakPattern)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parsed = parseEventLine(trimmed)
    if (parsed && typeof parsed === 'object') {
      cwd = asString((parsed as { cwd?: unknown }).cwd) ?? cwd
    }
    current = applyWorkflowProgressEvent(current ?? undefined, parsed)
  }
  if (!current) return null
  return {
    cwd,
    run: {
      ...current,
      auditPath: current.auditPath ?? join(dirname(eventsPath), 'audit.md'),
      detailKind: current.detailKind ?? 'workflow-jsonl',
      detailPath: current.detailPath ?? eventsPath,
      runDir: current.runDir ?? dirname(eventsPath),
    } satisfies PiWorkflowProgressRun,
  }
}

export function recoverWorkflowProgressFromEventsFile(eventsPath: string) {
  return recoverWorkflowProgressArtifact(eventsPath)?.run ?? null
}

function normalizeComparablePath(value: string) {
  const resolved = resolve(value)
  return process.platform === 'win32' || process.platform === 'darwin'
    ? resolved.toLowerCase()
    : resolved
}

function samePath(left: string, right: string) {
  return normalizeComparablePath(left) === normalizeComparablePath(right)
}

export function recoverWorkflowProgressFromArtifacts(options: {
  agentDir: string
  cwd: string
  nowMs?: number
}) {
  const runsDir = join(options.agentDir, 'workflow-runs')
  if (!existsSync(runsDir)) return []
  const nowMs = options.nowMs ?? Date.now()
  return readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const eventsPath = join(runsDir, entry.name, 'events.jsonl')
      try {
        const stats = statSync(eventsPath)
        return { eventsPath, mtimeMs: stats.mtimeMs }
      } catch {
        return null
      }
    })
    .filter((entry): entry is { eventsPath: string; mtimeMs: number } => Boolean(entry))
    .filter((entry) => nowMs - entry.mtimeMs <= artifactRecoveryMaxAgeMs)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, artifactRecoveryLimit)
    .flatMap((entry) => {
      const recovered = recoverWorkflowProgressArtifact(entry.eventsPath)
      return recovered ? [recovered] : []
    })
    .filter((entry) => entry.cwd !== null && samePath(entry.cwd, options.cwd))
    .map((entry) => entry.run)
}

export function subscribeRuntimeWorkflowProgress(
  runtime: PiRuntime,
  onStateChange: () => void,
  options: { agentDir?: string } = {},
) {
  const sessionPath = runtime.session.sessionFile
  if (!sessionPath) return () => undefined

  if (options.agentDir) {
    const recoveredRuns = recoverWorkflowProgressFromArtifacts({
      agentDir: options.agentDir,
      cwd: runtime.cwd,
    })
    if (recoveredRuns.length > 0) {
      const runs = getSessionRuns(sessionPath)
      for (const run of recoveredRuns) runs.set(run.runId, run)
      onStateChange()
    }
  }

  return () => undefined
}

export function disposeRuntimeWorkflowProgress(_runtime: PiRuntime) {
  return undefined
}
