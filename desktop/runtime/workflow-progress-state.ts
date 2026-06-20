// Pi UI bridge Howcode adapter. Managed by integrations/howcode/scripts/patch-howcode.mjs.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { PiWorkflowProgressRun } from '../../shared/desktop-contracts.ts'
import type { PiRuntime } from './types.ts'

const workflowEventName = 'workflow:running-task'
const terminalRunRetentionMs = 10 * 60 * 1000
const activeRunRecoveryMaxAgeMs = 5 * 60 * 1000
const artifactRecoveryMaxAgeMs = 24 * 60 * 60 * 1000
const artifactRecoveryLimit = 100
const eventsJsonlRecoveryMaxBytes = 16 * 1024 * 1024
const runJsonRecoveryMaxBytes = 1024 * 1024
const childSessionIdPattern = /^[A-Za-z0-9_-]+$/
const runsBySessionPath = new Map<string, Map<string, PiWorkflowProgressRun>>()

export type RecoveredWorkflowProgress = { cwd: string | null; run: PiWorkflowProgressRun }

type RuntimeSessionLike = { session: { sessionFile?: string | undefined } }

type ArtifactStats = { mtimeMs: number; size: number }

type ArtifactCandidate = {
  runDir: string
  runPath: string
  eventsPath: string
  runStats: ArtifactStats | null
  eventsStats: ArtifactStats | null
  mtimeMs: number
}

type WorkflowChildSessionPathInput = {
  runDir: string | null
  childSessionId: string | null
  childSessionPath: string | null
}

export type WorkflowProgressBridgeApi = {
  normalizeWorkflowProgressEvent: (input: unknown) => { runId: string } | null
  applyWorkflowProgressEvent: (
    previous: PiWorkflowProgressRun | undefined,
    input: unknown,
  ) => PiWorkflowProgressRun | null
  recoverWorkflowProgressFromEventsJsonlContent: (
    content: string,
    options?: {
      eventsPath?: string | undefined
      runDir?: string | undefined
      resolveChildSessionPath?:
        | ((input: WorkflowChildSessionPathInput) => string | null)
        | undefined
      onMalformedLine?: ((line: string) => void) | undefined
    },
  ) => RecoveredWorkflowProgress | null
  recoverWorkflowProgressFromRunJsonArtifact: (
    input: unknown,
    options: {
      runDir: string
      runPath?: string | undefined
      eventsPath?: string | undefined
      nowMs?: number | undefined
      mtimeMs?: number | undefined
      resolveChildSessionPath?:
        | ((input: WorkflowChildSessionPathInput) => string | null)
        | undefined
      onWarning?: ((message: string, artifactPath: string) => void) | undefined
    },
  ) => RecoveredWorkflowProgress | null
  mergeRecoveredWorkflowProgressArtifacts: (
    summary: RecoveredWorkflowProgress,
    events: RecoveredWorkflowProgress,
  ) => RecoveredWorkflowProgress
}

let workflowProgressBridgeApi: WorkflowProgressBridgeApi | null = null

export function setWorkflowProgressBridgeApi(api: WorkflowProgressBridgeApi) {
  workflowProgressBridgeApi = api
}

function getWorkflowProgressBridgeApi() {
  if (!workflowProgressBridgeApi) {
    recoveryWarning('workflow progress bridge helpers are unavailable', workflowEventName)
  }
  return workflowProgressBridgeApi
}

function getSessionRuns(sessionPath: string) {
  let runs = runsBySessionPath.get(sessionPath)
  if (!runs) {
    runs = new Map()
    runsBySessionPath.set(sessionPath, runs)
  }
  return runs
}

export function applyWorkflowProgressEvent(
  previous: PiWorkflowProgressRun | undefined,
  input: unknown,
): PiWorkflowProgressRun | null {
  return (
    getWorkflowProgressBridgeApi()?.applyWorkflowProgressEvent(previous, input) ?? previous ?? null
  )
}

export function recordRuntimeWorkflowProgressBridgeEvent(
  runtime: RuntimeSessionLike,
  input: unknown,
) {
  const sessionPath = runtime.session.sessionFile
  if (!sessionPath) return false
  const api = getWorkflowProgressBridgeApi()
  if (!api) return false
  const event = api.normalizeWorkflowProgressEvent(input)
  if (!event) return false
  const runs = getSessionRuns(sessionPath)
  const next = api.applyWorkflowProgressEvent(runs.get(event.runId), input)
  if (!next) return false
  runs.set(next.runId, next)
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

function readEventsJsonlContent(eventsPath: string, stats: ArtifactStats) {
  if (stats.size > eventsJsonlRecoveryMaxBytes) {
    recoveryWarning(`skipping events.jsonl above ${eventsJsonlRecoveryMaxBytes} bytes`, eventsPath)
    return null
  }
  try {
    return readFileSync(eventsPath, 'utf8')
  } catch (error) {
    recoveryWarning('could not read events.jsonl', eventsPath, error)
    return null
  }
}

function findSessionFileByChildId(
  runDir: string | null | undefined,
  childSessionId: string | null,
) {
  if (!(runDir && childSessionId && childSessionIdPattern.test(childSessionId))) return null
  const sessionsDir = join(runDir, 'sessions')
  try {
    const matches = readdirSync(sessionsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .filter(
        (name) =>
          name === `${childSessionId}.jsonl` ||
          (name.endsWith(`_${childSessionId}.jsonl`) &&
            !name.includes('/') &&
            !name.includes('\\')),
      )
      .sort()
    return matches.length > 0 ? join(sessionsDir, matches[matches.length - 1] ?? '') : null
  } catch {
    return null
  }
}

function resolveRecoveredChildSessionPath(input: WorkflowChildSessionPathInput) {
  return input.childSessionPath ?? findSessionFileByChildId(input.runDir, input.childSessionId)
}

function recoverRunJsonArtifact(
  candidate: ArtifactCandidate,
  nowMs: number,
  api: WorkflowProgressBridgeApi,
): RecoveredWorkflowProgress | null {
  if (!candidate.runStats) return null
  const parsed = readJsonArtifact(candidate.runPath, candidate.runStats, runJsonRecoveryMaxBytes)
  return api.recoverWorkflowProgressFromRunJsonArtifact(parsed, {
    runDir: candidate.runDir,
    runPath: candidate.runPath,
    ...(candidate.eventsStats ? { eventsPath: candidate.eventsPath } : {}),
    nowMs,
    mtimeMs: candidate.mtimeMs,
    resolveChildSessionPath: resolveRecoveredChildSessionPath,
    onWarning: recoveryWarning,
  })
}

function recoverEventsJsonlArtifact(
  eventsPath: string,
  stats: ArtifactStats,
  api: WorkflowProgressBridgeApi,
): RecoveredWorkflowProgress | null {
  const content = readEventsJsonlContent(eventsPath, stats)
  if (content === null) return null
  let warnedMalformedLine = false
  return api.recoverWorkflowProgressFromEventsJsonlContent(content, {
    eventsPath,
    resolveChildSessionPath: resolveRecoveredChildSessionPath,
    onMalformedLine: () => {
      if (warnedMalformedLine) return
      warnedMalformedLine = true
      recoveryWarning('ignored malformed events.jsonl line', eventsPath)
    },
  })
}

function recoverWorkflowProgressArtifact(
  eventsPath: string,
): { cwd: string | null; run: PiWorkflowProgressRun } | null {
  const api = getWorkflowProgressBridgeApi()
  const stats = artifactStats(eventsPath)
  if (!(api && stats)) return null
  return recoverEventsJsonlArtifact(eventsPath, stats, api)
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
  api: WorkflowProgressBridgeApi,
): RecoveredWorkflowProgress | null {
  const runJsonRecovered = recoverRunJsonArtifact(candidate, nowMs, api)
  if (runJsonRecovered?.cwd && !samePath(runJsonRecovered.cwd, cwd)) return null

  let recovered = runJsonRecovered
  if (candidate.eventsStats) {
    const eventsRecovered = recoverEventsJsonlArtifact(
      candidate.eventsPath,
      candidate.eventsStats,
      api,
    )
    if (eventsRecovered) {
      recovered = recovered
        ? api.mergeRecoveredWorkflowProgressArtifacts(recovered, eventsRecovered)
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
  const api = getWorkflowProgressBridgeApi()
  if (!api) return []
  const runsDir = join(options.agentDir, 'workflow-runs')
  if (!existsSync(runsDir)) return []
  const nowMs = options.nowMs ?? Date.now()
  return discoverArtifactCandidates(runsDir)
    .filter((entry) => nowMs - entry.mtimeMs <= artifactRecoveryMaxAgeMs)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, artifactRecoveryLimit)
    .flatMap((entry) => {
      const recovered = recoverArtifactCandidate(entry, options.cwd, nowMs, api)
      if (!recovered) return []
      const run = { ...recovered.run, updatedAt: new Date(entry.mtimeMs).toISOString() }
      if (!run.terminal && nowMs - entry.mtimeMs > activeRunRecoveryMaxAgeMs) return []
      return isTerminalRunExpired(run, nowMs) ? [] : [{ ...recovered, run }]
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
