import { type FSWatcher, watch } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import {
  publishExternalThreadUpdate,
  publishSecondaryThreadUpdate,
  shouldSuppressExternalThreadUpdate,
} from './external-thread-publisher.ts'
import { loadThreadSnapshot } from './thread-loader.ts'

const WATCH_DEBOUNCE_MS = 140
const WATCH_RETRY_MS = 500

type SessionWatcher = {
  currentSessionPath: string | null
  currentWatcher: FSWatcher | null
  currentWatchToken: number
  lastObservedModifiedMs: number
  needsInitialRefresh: boolean
  pendingRefreshTimeout: ReturnType<typeof setTimeout> | null
  pendingWatchRetryTimeout: ReturnType<typeof setTimeout> | null
  publishMode: 'external' | 'secondary'
}

const selectedSessionWatcher = createSessionWatcher('external')
const secondarySessionWatcher = createSessionWatcher('secondary')

function createSessionWatcher(publishMode: SessionWatcher['publishMode']): SessionWatcher {
  return {
    currentSessionPath: null,
    currentWatcher: null,
    currentWatchToken: 0,
    lastObservedModifiedMs: 0,
    needsInitialRefresh: false,
    pendingRefreshTimeout: null,
    pendingWatchRetryTimeout: null,
    publishMode,
  }
}

function clearPendingRefresh(state: SessionWatcher) {
  if (!state.pendingRefreshTimeout) return
  clearTimeout(state.pendingRefreshTimeout)
  state.pendingRefreshTimeout = null
}

function clearPendingWatchRetry(state: SessionWatcher) {
  if (!state.pendingWatchRetryTimeout) return
  clearTimeout(state.pendingWatchRetryTimeout)
  state.pendingWatchRetryTimeout = null
}

function closeCurrentWatcher(state: SessionWatcher) {
  clearPendingRefresh(state)
  clearPendingWatchRetry(state)
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
  if (state.publishMode === 'secondary') {
    await publishSecondaryThreadUpdate(input)
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
    if (state.needsInitialRefresh)
      scheduleWatchedSessionRefreshAfter(state, sessionPath, watchToken, WATCH_RETRY_MS)
    return
  }

  if (fileStats.mtimeMs <= state.lastObservedModifiedMs) return

  try {
    const snapshot = await loadThreadSnapshot(sessionPath)
    if (state.currentSessionPath !== sessionPath || state.currentWatchToken !== watchToken) return

    state.lastObservedModifiedMs = fileStats.mtimeMs
    state.needsInitialRefresh = false
    await publishThreadUpdate(state, snapshot, sessionPath, fileStats.mtimeMs)
  } catch (error) {
    console.warn(`Failed to refresh watched Pi session: ${sessionPath}`, error)
    if (state.needsInitialRefresh)
      scheduleWatchedSessionRefreshAfter(state, sessionPath, watchToken, WATCH_RETRY_MS)
  }
}

function scheduleWatchedSessionRefreshAfter(
  state: SessionWatcher,
  sessionPath: string,
  watchToken: number,
  delayMs: number,
) {
  clearPendingRefresh(state)
  state.pendingRefreshTimeout = setTimeout(() => {
    state.pendingRefreshTimeout = null
    void refreshWatchedSession(state, sessionPath, watchToken)
  }, delayMs)
}

function scheduleWatchedSessionRefresh(
  state: SessionWatcher,
  sessionPath: string,
  watchToken: number,
) {
  scheduleWatchedSessionRefreshAfter(state, sessionPath, watchToken, WATCH_DEBOUNCE_MS)
}

function scheduleWatcherRetry(state: SessionWatcher, sessionPath: string, watchToken: number) {
  clearPendingWatchRetry(state)
  state.pendingWatchRetryTimeout = setTimeout(() => {
    state.pendingWatchRetryTimeout = null
    void attachWatcher(state, sessionPath, watchToken)
  }, WATCH_RETRY_MS)
}

async function attachWatcher(state: SessionWatcher, sessionPath: string, watchToken: number) {
  if (state.currentSessionPath !== sessionPath || state.currentWatchToken !== watchToken) return

  try {
    const fileStats = await stat(sessionPath)
    if (!state.needsInitialRefresh) state.lastObservedModifiedMs = fileStats.mtimeMs
  } catch {
    state.lastObservedModifiedMs = 0
    state.needsInitialRefresh = true
  }

  const watchedFileName = path.basename(sessionPath)
  const watchedDirectory = path.dirname(sessionPath)

  try {
    const watcher = watch(watchedDirectory, (_eventType, changedFileName) => {
      if (state.currentSessionPath !== sessionPath || state.currentWatchToken !== watchToken) return

      if (typeof changedFileName === 'string' && changedFileName.length > 0) {
        if (changedFileName !== watchedFileName) return
      }

      scheduleWatchedSessionRefresh(state, sessionPath, watchToken)
    })

    if (state.currentSessionPath !== sessionPath || state.currentWatchToken !== watchToken) {
      watcher.close()
      return
    }

    state.currentWatcher = watcher
    watcher.on('error', (error) => {
      if (state.currentSessionPath !== sessionPath || state.currentWatchToken !== watchToken) return
      console.warn(`Pi session watcher failed for ${sessionPath}`, error)
      state.currentWatcher?.close()
      state.currentWatcher = null
      state.lastObservedModifiedMs = 0
      state.needsInitialRefresh = true
      scheduleWatcherRetry(state, sessionPath, watchToken)
    })
  } catch (error) {
    if (state.currentSessionPath !== sessionPath || state.currentWatchToken !== watchToken) return
    console.warn(`Pi session watcher failed for ${sessionPath}`, error)
    state.currentWatcher = null
    state.lastObservedModifiedMs = 0
    state.needsInitialRefresh = true
    scheduleWatcherRetry(state, sessionPath, watchToken)
    return
  }

  if (state.needsInitialRefresh) scheduleWatchedSessionRefresh(state, sessionPath, watchToken)
}

async function setWatcherSessionPath(state: SessionWatcher, sessionPath: string | null) {
  if (sessionPath === state.currentSessionPath) return

  state.currentWatchToken += 1
  state.currentSessionPath = sessionPath
  state.lastObservedModifiedMs = 0
  state.needsInitialRefresh = false
  closeCurrentWatcher(state)

  if (!sessionPath) return

  await attachWatcher(state, sessionPath, state.currentWatchToken)
}

function disposeWatcher(state: SessionWatcher) {
  state.currentWatchToken += 1
  state.currentSessionPath = null
  state.lastObservedModifiedMs = 0
  state.needsInitialRefresh = false
  closeCurrentWatcher(state)
}

export async function setWatchedSessionPath(sessionPath: string | null) {
  await setWatcherSessionPath(selectedSessionWatcher, sessionPath)
}

export async function setWatchedSecondarySessionPath(sessionPath: string | null) {
  await setWatcherSessionPath(secondarySessionWatcher, sessionPath)
}

export function disposeSessionWatcher() {
  disposeWatcher(selectedSessionWatcher)
  disposeWatcher(secondarySessionWatcher)
}
