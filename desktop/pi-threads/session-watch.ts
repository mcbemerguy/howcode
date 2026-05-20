import { type FSWatcher, watch } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import {
  publishExternalThreadUpdate,
  publishWorkflowStepThreadUpdate,
  shouldSuppressExternalThreadUpdate,
} from './external-thread-publisher.ts'
import { loadThreadSnapshot } from './thread-loader.ts'

const WATCH_DEBOUNCE_MS = 140

type SessionWatcher = {
  currentSessionPath: string | null
  currentWatcher: FSWatcher | null
  currentWatchToken: number
  lastObservedModifiedMs: number
  pendingRefreshTimeout: ReturnType<typeof setTimeout> | null
  publishMode: 'external' | 'workflow-step'
}

const selectedSessionWatcher = createSessionWatcher('external')
const workflowStepSessionWatcher = createSessionWatcher('workflow-step')

function createSessionWatcher(publishMode: SessionWatcher['publishMode']): SessionWatcher {
  return {
    currentSessionPath: null,
    currentWatcher: null,
    currentWatchToken: 0,
    lastObservedModifiedMs: 0,
    pendingRefreshTimeout: null,
    publishMode,
  }
}

function clearPendingRefresh(state: SessionWatcher) {
  if (!state.pendingRefreshTimeout) return
  clearTimeout(state.pendingRefreshTimeout)
  state.pendingRefreshTimeout = null
}

function closeCurrentWatcher(state: SessionWatcher) {
  clearPendingRefresh(state)
  state.currentWatcher?.close()
  state.currentWatcher = null
}

async function publishThreadUpdate(
  state: SessionWatcher,
  snapshot: Awaited<ReturnType<typeof loadThreadSnapshot>>,
  sessionPath: string,
  lastModifiedMs: number,
) {
  const input = {
    projectId: snapshot.projectId,
    threadId: snapshot.threadId,
    sessionPath,
    thread: snapshot.thread,
    lastModifiedMs,
  }
  if (state.publishMode === 'workflow-step') {
    await publishWorkflowStepThreadUpdate(input)
    return
  }
  await publishExternalThreadUpdate(input)
}

async function refreshWatchedSession(
  state: SessionWatcher,
  sessionPath: string,
  watchToken: number,
) {
  if (state.currentSessionPath !== sessionPath || state.currentWatchToken !== watchToken) return
  if (shouldSuppressExternalThreadUpdate(sessionPath)) return

  let fileStats: Awaited<ReturnType<typeof stat>>
  try {
    fileStats = await stat(sessionPath)
  } catch {
    return
  }

  if (fileStats.mtimeMs <= state.lastObservedModifiedMs) return

  try {
    const snapshot = await loadThreadSnapshot(sessionPath)
    if (state.currentSessionPath !== sessionPath || state.currentWatchToken !== watchToken) return

    state.lastObservedModifiedMs = fileStats.mtimeMs
    await publishThreadUpdate(state, snapshot, sessionPath, fileStats.mtimeMs)
  } catch (error) {
    console.warn(`Failed to refresh watched Pi session: ${sessionPath}`, error)
  }
}

function scheduleWatchedSessionRefresh(
  state: SessionWatcher,
  sessionPath: string,
  watchToken: number,
) {
  clearPendingRefresh(state)
  state.pendingRefreshTimeout = setTimeout(() => {
    state.pendingRefreshTimeout = null
    void refreshWatchedSession(state, sessionPath, watchToken)
  }, WATCH_DEBOUNCE_MS)
}

async function setWatcherSessionPath(state: SessionWatcher, sessionPath: string | null) {
  if (sessionPath === state.currentSessionPath) return

  state.currentWatchToken += 1
  state.currentSessionPath = sessionPath
  state.lastObservedModifiedMs = 0
  closeCurrentWatcher(state)

  if (!sessionPath) return

  try {
    const fileStats = await stat(sessionPath)
    state.lastObservedModifiedMs = fileStats.mtimeMs
  } catch {
    state.lastObservedModifiedMs = 0
  }

  const watchToken = state.currentWatchToken
  const watchedFileName = path.basename(sessionPath)
  const watchedDirectory = path.dirname(sessionPath)

  state.currentWatcher = watch(watchedDirectory, (_eventType, changedFileName) => {
    if (state.currentSessionPath !== sessionPath || state.currentWatchToken !== watchToken) return

    if (typeof changedFileName === 'string' && changedFileName.length > 0) {
      if (changedFileName !== watchedFileName) return
    }

    scheduleWatchedSessionRefresh(state, sessionPath, watchToken)
  })

  state.currentWatcher.on('error', (error) => {
    console.warn(`Pi session watcher failed for ${sessionPath}`, error)
  })
}

function disposeWatcher(state: SessionWatcher) {
  state.currentWatchToken += 1
  state.currentSessionPath = null
  state.lastObservedModifiedMs = 0
  closeCurrentWatcher(state)
}

export async function setWatchedSessionPath(sessionPath: string | null) {
  await setWatcherSessionPath(selectedSessionWatcher, sessionPath)
}

export async function setWatchedWorkflowStepSessionPath(sessionPath: string | null) {
  await setWatcherSessionPath(workflowStepSessionWatcher, sessionPath)
}

export function disposeSessionWatcher() {
  disposeWatcher(selectedSessionWatcher)
  disposeWatcher(workflowStepSessionWatcher)
}
