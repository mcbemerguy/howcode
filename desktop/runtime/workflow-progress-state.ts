// Pi UI bridge Howcode adapter. Managed by integrations/howcode/scripts/patch-howcode.mjs.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { PiWorkflowProgressRun } from '../../shared/desktop-contracts.ts'
import type { PiRuntime } from './types.ts'

const lineBreakPattern = /\r?\n/
const workflowEventName = 'workflow:running-task'
const terminalStatuses = new Set(['completed', 'failed', 'aborted'])
const workflowProgressEventTypes = new Set([
  'run_start',
  'run_end',
  'step_start',
  'step_update',
  'step_end',
])
const terminalRunRetentionMs = 10 * 60 * 1000
const artifactRecoveryMaxAgeMs = 24 * 60 * 60 * 1000
const artifactRecoveryLimit = 100
const eventsJsonlRecoveryMaxBytes = 16 * 1024 * 1024
const runJsonRecoveryMaxBytes = 1024 * 1024
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

type UiBridgeEventRecord = Record<string, unknown> & {
  type?: unknown
  payload?: unknown
  timestamp?: unknown
}

type TimestampRecord = Record<string, unknown> & { timestamp?: unknown }

type RecoveredWorkflowProgress = { cwd: string | null; run: PiWorkflowProgressRun }

type ArtifactStats = { mtimeMs: number; size: number }

type ArtifactCandidate = {
  runDir: string
  runPath: string
  eventsPath: string
  runStats: ArtifactStats | null
  eventsStats: ArtifactStats | null
  mtimeMs: number
}

type RunJsonRecord = Record<string, unknown> & {
  auditPath?: unknown
  currentStepIndex?: unknown
  cwd?: unknown
  endedAt?: unknown
  error?: unknown
  id?: unknown
  runDir?: unknown
  runId?: unknown
  startedAt?: unknown
  status?: unknown
  steps?: unknown
  workflowId?: unknown
}

type RunJsonStepRecord = Record<string, unknown> & {
  endedAt?: unknown
  id?: unknown
  index?: unknown
  startedAt?: unknown
  status?: unknown
  type?: unknown
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
  const record = asRecord(input) as UiBridgeEventRecord | null
  if (!record || record.type !== workflowEventName) return input
  const payload = asRecord(record.payload) as TimestampRecord | null
  if (!payload) return null
  return {
    ...payload,
    timestamp: asString(payload.timestamp) ?? asString(record.timestamp) ?? undefined,
  }
}

function normalizeEvent(input: unknown): RawWorkflowEvent | null {
  const unwrapped = unwrapWorkflowEvent(input)
  if (!unwrapped || typeof unwrapped !== 'object') return null
  const event = unwrapped as RawWorkflowEvent
  if (!(asString(event.runId) && asString(event.workflowId) && asString(event.type))) return null
  return event
}

function isWorkflowProgressEvent(event: RawWorkflowEvent) {
  const type = asString(event.type)
  return type !== null && workflowProgressEventTypes.has(type)
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

function recoveryWarning(message: string, artifactPath: string, error?: unknown) {
  const suffix = error instanceof Error ? `: ${error.message}` : ''
  console.warn(`Pi workflow recovery: ${message} (${artifactPath})${suffix}`)
}

function parseEventLine(line: string) {
  try {
    return { parsed: JSON.parse(line) as unknown, ok: true }
  } catch {
    return { parsed: null, ok: false }
  }
}

function parseTimestampMs(value: unknown) {
  const text = asString(value)
  if (!text) return null
  const timestamp = Date.parse(text)
  return Number.isFinite(timestamp) ? timestamp : null
}

function toIsoString(ms: number) {
  return new Date(ms).toISOString()
}

function artifactStats(path: string) {
  if (!existsSync(path)) return null
  try {
    const stats = statSync(path)
    if (!stats.isFile()) {
      recoveryWarning('skipping non-file artifact', path)
      return null
    }
    return { mtimeMs: stats.mtimeMs, size: stats.size } satisfies ArtifactStats
  } catch (error) {
    recoveryWarning('could not stat artifact', path, error)
    return null
  }
}

function readJsonArtifact(path: string, stats: ArtifactStats, maxBytes: number) {
  if (stats.size > maxBytes) {
    recoveryWarning(`skipping artifact above ${maxBytes} bytes`, path)
    return null
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch (error) {
    recoveryWarning('could not read or parse artifact', path, error)
    return null
  }
}

function selectRunJsonStep(run: RunJsonRecord) {
  const steps = Array.isArray(run.steps)
    ? run.steps.map(asRecord).filter((step): step is RunJsonStepRecord => Boolean(step))
    : []
  const running = steps.find((step) => asString(step.status) === 'running')
  if (running) return running
  const currentStepIndex = asNumber(run.currentStepIndex)
  if (currentStepIndex !== null) {
    const byArrayIndex = steps[currentStepIndex]
    if (byArrayIndex) return byArrayIndex
    const byStepIndex = steps.find((step) => asNumber(step.index) === currentStepIndex)
    if (byStepIndex) return byStepIndex
  }
  return steps.length > 0 ? (steps[steps.length - 1] ?? null) : null
}

function stepActivity(step: RunJsonStepRecord | null, status: string, terminal: boolean) {
  if (terminal) return status
  const stepId = step ? asString(step.id) : null
  const stepStatus = step ? asString(step.status) : null
  if (stepId && stepStatus) return `${stepId}: ${stepStatus}`
  if (stepId) return `Step ${stepId}`
  return status
}

function getRunJsonIdentity(run: RunJsonRecord, path: string) {
  const runId = asString(run.id) ?? asString(run.runId)
  const workflowId = asString(run.workflowId)
  if (runId && workflowId) return { runId, workflowId }
  recoveryWarning('skipping run.json without run identity', path)
  return null
}

function getRunJsonTiming(
  run: RunJsonRecord,
  step: RunJsonStepRecord | null,
  candidate: ArtifactCandidate,
  nowMs: number,
) {
  const startedAtMs = parseTimestampMs(run.startedAt)
  const endedAtMs = parseTimestampMs(run.endedAt)
  const stepEndedAtMs = step ? parseTimestampMs(step.endedAt) : null
  const stepStartedAtMs = step ? parseTimestampMs(step.startedAt) : null
  return {
    elapsedMs: startedAtMs === null ? null : (endedAtMs ?? nowMs) - startedAtMs,
    updatedAt: toIsoString(endedAtMs ?? stepEndedAtMs ?? stepStartedAtMs ?? candidate.mtimeMs),
  }
}

function getRunJsonPaths(run: RunJsonRecord, candidate: ArtifactCandidate) {
  const auditPath = asString(run.auditPath) ?? join(candidate.runDir, 'audit.md')
  return {
    auditPath,
    detailKind: candidate.eventsStats ? 'workflow-jsonl' : 'text',
    detailPath: candidate.eventsStats ? candidate.eventsPath : auditPath,
    runDir: asString(run.runDir) ?? candidate.runDir,
  } satisfies Pick<PiWorkflowProgressRun, 'auditPath' | 'detailKind' | 'detailPath' | 'runDir'>
}

function recoverRunJsonArtifact(
  candidate: ArtifactCandidate,
  nowMs: number,
): RecoveredWorkflowProgress | null {
  if (!candidate.runStats) return null
  const parsed = readJsonArtifact(candidate.runPath, candidate.runStats, runJsonRecoveryMaxBytes)
  const run = asRecord(parsed) as RunJsonRecord | null
  if (!run) return null
  const identity = getRunJsonIdentity(run, candidate.runPath)
  if (!identity) return null

  const status = asString(run.status) ?? 'running'
  const terminal = terminalStatuses.has(status)
  const step = selectRunJsonStep(run)
  return {
    cwd: asString(run.cwd),
    run: {
      ...identity,
      ...getRunJsonPaths(run, candidate),
      currentStepId: step ? asString(step.id) : null,
      currentStepType: step ? asString(step.type) : null,
      currentStepStatus: terminal ? null : step ? asString(step.status) : null,
      status,
      activity: stepActivity(step, status, terminal),
      currentTool: null,
      childSessionId: null,
      ...getRunJsonTiming(run, step, candidate, nowMs),
      error: asString(run.error),
      terminal,
    } satisfies PiWorkflowProgressRun,
  }
}

function readEventsJsonlContent(eventsPath: string) {
  try {
    return readFileSync(eventsPath, 'utf8')
  } catch (error) {
    recoveryWarning('could not read events.jsonl', eventsPath, error)
    return null
  }
}

function updateMalformedLineWarning(ok: boolean, warned: boolean, eventsPath: string) {
  if (ok || warned) return warned
  recoveryWarning('ignored malformed events.jsonl line', eventsPath)
  return true
}

type SmallEventsRecoveryState = {
  current: PiWorkflowProgressRun | null
  cwd: string | null
}

function updateSmallEventsRecoveryState(state: SmallEventsRecoveryState, parsed: unknown) {
  if (parsed && typeof parsed === 'object') {
    state.cwd = asString((parsed as { cwd?: unknown }).cwd) ?? state.cwd
  }
  const event = normalizeEvent(parsed)
  if (!(event && isWorkflowProgressEvent(event))) return
  state.current = applyWorkflowProgressEvent(state.current ?? undefined, event)
}

function recoverSmallEventsJsonlArtifact(eventsPath: string): RecoveredWorkflowProgress | null {
  const state: SmallEventsRecoveryState = { current: null, cwd: null }
  let warnedMalformedLine = false
  const content = readEventsJsonlContent(eventsPath)
  if (content === null) return null
  for (const line of content.split(lineBreakPattern)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const { parsed, ok } = parseEventLine(trimmed)
    warnedMalformedLine = updateMalformedLineWarning(ok, warnedMalformedLine, eventsPath)
    updateSmallEventsRecoveryState(state, parsed)
  }
  if (!state.current) return null
  return {
    cwd: state.cwd,
    run: {
      ...state.current,
      auditPath: state.current.auditPath ?? join(dirname(eventsPath), 'audit.md'),
      detailKind: state.current.detailKind ?? 'workflow-jsonl',
      detailPath: state.current.detailPath ?? eventsPath,
      runDir: state.current.runDir ?? dirname(eventsPath),
    } satisfies PiWorkflowProgressRun,
  }
}

function recoverEventsJsonlArtifact(
  eventsPath: string,
  stats: ArtifactStats,
): RecoveredWorkflowProgress | null {
  if (stats.size > eventsJsonlRecoveryMaxBytes) {
    recoveryWarning(`skipping events.jsonl above ${eventsJsonlRecoveryMaxBytes} bytes`, eventsPath)
    return null
  }
  return recoverSmallEventsJsonlArtifact(eventsPath)
}

function mergeRecoveredRunJsonAndEvents(
  summary: RecoveredWorkflowProgress,
  events: RecoveredWorkflowProgress,
): RecoveredWorkflowProgress {
  const runJsonIsTerminal = summary.run.terminal || terminalStatuses.has(summary.run.status)
  const merged = {
    ...summary.run,
    ...events.run,
    auditPath: events.run.auditPath ?? summary.run.auditPath,
    detailKind: summary.run.detailKind ?? events.run.detailKind,
    detailPath: summary.run.detailPath ?? events.run.detailPath,
    runDir: events.run.runDir ?? summary.run.runDir,
  }
  if (runJsonIsTerminal) {
    merged.status = summary.run.status
    merged.currentStepId = summary.run.currentStepId
    merged.currentStepType = summary.run.currentStepType
    merged.currentStepStatus = summary.run.currentStepStatus
    merged.activity = summary.run.activity
    merged.currentTool = summary.run.currentTool
    merged.childSessionId = summary.run.childSessionId
    merged.elapsedMs = summary.run.elapsedMs
    merged.error = summary.run.error
    merged.updatedAt = summary.run.updatedAt
    merged.terminal = true
  }
  return {
    cwd: summary.cwd ?? events.cwd,
    run: merged,
  }
}

function recoverWorkflowProgressArtifact(
  eventsPath: string,
): { cwd: string | null; run: PiWorkflowProgressRun } | null {
  const stats = artifactStats(eventsPath)
  if (!stats) return null
  return recoverEventsJsonlArtifact(eventsPath, stats)
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

function readWorkflowRunEntries(runsDir: string) {
  try {
    return readdirSync(runsDir, { withFileTypes: true })
  } catch (error) {
    recoveryWarning('could not list workflow-runs directory', runsDir, error)
    return []
  }
}

function discoverArtifactCandidates(runsDir: string) {
  return readWorkflowRunEntries(runsDir)
    .filter((entry) => entry.isDirectory())
    .flatMap((entry): ArtifactCandidate[] => {
      const runDir = join(runsDir, entry.name)
      const runPath = join(runDir, 'run.json')
      const eventsPath = join(runDir, 'events.jsonl')
      const runStats = artifactStats(runPath)
      const eventsStats = artifactStats(eventsPath)
      const mtimeMs = Math.max(runStats?.mtimeMs ?? 0, eventsStats?.mtimeMs ?? 0)
      return mtimeMs > 0 ? [{ runDir, runPath, eventsPath, runStats, eventsStats, mtimeMs }] : []
    })
}

function recoverArtifactCandidate(
  candidate: ArtifactCandidate,
  cwd: string,
  nowMs: number,
): RecoveredWorkflowProgress | null {
  const runJsonRecovered = recoverRunJsonArtifact(candidate, nowMs)
  if (runJsonRecovered?.cwd && !samePath(runJsonRecovered.cwd, cwd)) return null

  let recovered = runJsonRecovered
  if (candidate.eventsStats) {
    const eventsRecovered = recoverEventsJsonlArtifact(candidate.eventsPath, candidate.eventsStats)
    if (eventsRecovered) {
      recovered = recovered
        ? mergeRecoveredRunJsonAndEvents(recovered, eventsRecovered)
        : eventsRecovered
    }
  }

  if (!recovered) return null
  return recovered.cwd !== null && samePath(recovered.cwd, cwd) ? recovered : null
}

export function recoverWorkflowProgressFromArtifacts(options: {
  agentDir: string
  cwd: string
  nowMs?: number
}) {
  const runsDir = join(options.agentDir, 'workflow-runs')
  if (!existsSync(runsDir)) return []
  const nowMs = options.nowMs ?? Date.now()
  return discoverArtifactCandidates(runsDir)
    .filter((entry) => nowMs - entry.mtimeMs <= artifactRecoveryMaxAgeMs)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, artifactRecoveryLimit)
    .flatMap((entry) => {
      const recovered = recoverArtifactCandidate(entry, options.cwd, nowMs)
      return recovered
        ? [
            {
              ...recovered,
              run: { ...recovered.run, updatedAt: new Date(entry.mtimeMs).toISOString() },
            },
          ]
        : []
    })
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
    try {
      const recoveredRuns = recoverWorkflowProgressFromArtifacts({
        agentDir: options.agentDir,
        cwd: runtime.cwd,
      })
      if (recoveredRuns.length > 0) {
        const runs = getSessionRuns(sessionPath)
        for (const run of recoveredRuns) runs.set(run.runId, run)
        onStateChange()
      }
    } catch (error) {
      recoveryWarning('artifact recovery failed', options.agentDir, error)
    }
  }

  return () => undefined
}

export function disposeRuntimeWorkflowProgress(_runtime: PiRuntime) {
  return undefined
}
