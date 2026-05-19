import { existsSync, readFileSync } from 'node:fs'
import type { PiWorkflowProgressRun } from '../../shared/desktop-contracts.ts'
import type { PiRuntime } from './types.ts'

const lineBreakPattern = /\r?\n/
const workflowEventName = 'workflow:running-task'
const terminalStatuses = new Set(['completed', 'failed', 'aborted'])
const runsBySessionPath = new Map<string, Map<string, PiWorkflowProgressRun>>()
const disposersByRuntime = new WeakMap<PiRuntime, () => void>()

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

function asString(value: unknown) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asDetailKind(value: unknown) {
  return value === 'workflow-jsonl' || value === 'text' ? value : null
}

function normalizeEvent(input: unknown): RawWorkflowEvent | null {
  if (!input || typeof input !== 'object') return null
  const event = input as RawWorkflowEvent
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

export function getWorkflowProgressRuns(runtime: Pick<PiRuntime, 'session'>) {
  const sessionPath = runtime.session.sessionFile
  if (!sessionPath) return []
  return [...(runsBySessionPath.get(sessionPath)?.values() ?? [])].sort((left, right) =>
    left.updatedAt.localeCompare(right.updatedAt),
  )
}

function parseEventLine(line: string) {
  try {
    return JSON.parse(line) as unknown
  } catch {
    return null
  }
}

export function recoverWorkflowProgressFromEventsFile(eventsPath: string) {
  if (!existsSync(eventsPath)) return null
  let current: PiWorkflowProgressRun | null = null
  for (const line of readFileSync(eventsPath, 'utf8').split(lineBreakPattern)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    current = applyWorkflowProgressEvent(current ?? undefined, parseEventLine(trimmed))
  }
  return current
}

export function subscribeRuntimeWorkflowProgress(runtime: PiRuntime, onStateChange: () => void) {
  disposeRuntimeWorkflowProgress(runtime)
  const sessionPath = runtime.session.sessionFile
  if (!sessionPath) return () => undefined

  const eventBus = (
    runtime.session.extensionRunner as unknown as {
      runtime?: {
        events?: { on: (channel: string, handler: (data: unknown) => void) => () => void }
      }
    }
  ).runtime?.events
  if (!eventBus) return () => undefined
  const unsubscribe = eventBus.on(workflowEventName, (data: unknown) => {
    const event = normalizeEvent(data)
    if (!event) return
    const runId = asString(event.runId)
    if (!runId) return
    const runs = getSessionRuns(sessionPath)
    const next = applyWorkflowProgressEvent(runs.get(runId), event)
    if (!next) return
    runs.set(runId, next)
    onStateChange()
  })
  disposersByRuntime.set(runtime, unsubscribe)
  return unsubscribe
}

export function disposeRuntimeWorkflowProgress(runtime: PiRuntime) {
  const dispose = disposersByRuntime.get(runtime)
  if (!dispose) return
  dispose()
  disposersByRuntime.delete(runtime)
}
