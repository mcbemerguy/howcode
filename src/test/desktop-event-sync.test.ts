import { describe, expect, it } from 'vitest'
import { createLocalThreadDraft } from '../../shared/session-paths'
import { shouldApplyComposerUpdate } from '../app/app-shell/desktop-event-handlers'
import {
  type DesktopEventSelectionState,
  getVisibleDesktopSessionPath,
  shouldAutoOpenStartedThread,
  shouldDisplayStartedThreadForLocalDraft,
} from '../app/app-shell/desktop-event-sync'
import type { ComposerState, DesktopEvent } from '../app/desktop/types'

function selectionState(
  overrides: Partial<DesktopEventSelectionState> = {},
): DesktopEventSelectionState {
  return {
    activeView: 'code',
    selectedProjectId: '/repo/project-a',
    selectedThreadId: null,
    selectedSessionPath: null,
    selectedInboxSessionPath: null,
    ...overrides,
  }
}

function composerState(overrides: Partial<ComposerState> = {}): ComposerState {
  return {
    currentModel: null,
    availableModels: [],
    currentThinkingLevel: 'off',
    availableThinkingLevels: [],
    queuedPrompts: [],
    nativeInteractionRequests: [],
    nativeAskQuestionsRequest: null,
    workflowProgressRuns: [],
    piNotifications: [],
    contextUsage: null,
    isCompacting: false,
    isExtensionCommandRunning: false,
    ...overrides,
  }
}

function composerUpdateEvent(
  overrides: Partial<Extract<DesktopEvent, { type: 'composer-update' }>> = {},
): Extract<DesktopEvent, { type: 'composer-update' }> {
  return {
    type: 'composer-update',
    projectId: '/repo/project-a',
    sessionPath: '/sessions/project-a.jsonl',
    composer: composerState(),
    ...overrides,
  }
}

describe('desktop event selection helpers', () => {
  it('applies persisted workflow composer updates to their visible local draft alias', () => {
    const draft = createLocalThreadDraft('/repo/project-a', 'draft')
    const aliasesRef = { current: new Map<string, string>() }

    expect(
      shouldApplyComposerUpdate({
        event: composerUpdateEvent({
          localDraftSessionPath: draft.sessionPath,
          composer: composerState({
            workflowProgressRuns: [
              {
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
                activity: 'Running code',
                currentTool: null,
                childSessionId: null,
                elapsedMs: 1000,
                error: null,
                updatedAt: '2026-05-20T00:00:00.000Z',
                terminal: false,
              },
            ],
          }),
        }),
        latestComposerProjectId: draft.projectId,
        latestWorkspaceState: selectionState({
          activeView: 'thread',
          selectedProjectId: draft.projectId,
          selectedSessionPath: draft.sessionPath,
        }),
        localDraftSessionPathByPersistedSessionPathRef: aliasesRef,
        visibleSessionPath: null,
      }),
    ).toBe(true)
    expect(aliasesRef.current.get('/sessions/project-a.jsonl')).toBe(draft.sessionPath)
  })

  it('does not apply persisted composer updates to an unrelated visible local draft', () => {
    const selectedDraft = createLocalThreadDraft('/repo/project-a', 'selected')
    const otherDraft = createLocalThreadDraft('/repo/project-a', 'other')

    expect(
      shouldApplyComposerUpdate({
        event: composerUpdateEvent({ localDraftSessionPath: otherDraft.sessionPath }),
        latestComposerProjectId: selectedDraft.projectId,
        latestWorkspaceState: selectionState({
          activeView: 'thread',
          selectedProjectId: selectedDraft.projectId,
          selectedSessionPath: selectedDraft.sessionPath,
        }),
        localDraftSessionPathByPersistedSessionPathRef: { current: new Map() },
        visibleSessionPath: null,
      }),
    ).toBe(false)
  })

  it('does not treat a local draft thread as a visible persisted session', () => {
    const draft = createLocalThreadDraft('/repo/project-b', 'draft')

    expect(
      getVisibleDesktopSessionPath(
        selectionState({
          activeView: 'thread',
          selectedProjectId: draft.projectId,
          selectedSessionPath: draft.sessionPath,
        }),
      ),
    ).toBeNull()
  })

  it('does not auto-open a started background thread over a local draft in another project', () => {
    const draft = createLocalThreadDraft('/repo/project-b', 'draft')

    expect(
      shouldAutoOpenStartedThread({
        reason: 'start',
        projectId: '/repo/project-a',
        workspaceState: selectionState({
          activeView: 'thread',
          selectedProjectId: draft.projectId,
          selectedSessionPath: draft.sessionPath,
        }),
      }),
    ).toBe(false)
  })

  it('does not auto-open over a local draft even when the background thread is in the same project', () => {
    const draft = createLocalThreadDraft('/repo/project-a', 'draft')

    expect(
      shouldAutoOpenStartedThread({
        reason: 'start',
        projectId: draft.projectId,
        workspaceState: selectionState({
          activeView: 'thread',
          selectedProjectId: draft.projectId,
          selectedSessionPath: draft.sessionPath,
        }),
      }),
    ).toBe(false)
  })

  it('displays same-view started thread updates for the selected local draft without auto-open', () => {
    const draft = createLocalThreadDraft('/repo/project-a', 'draft')

    expect(
      shouldDisplayStartedThreadForLocalDraft({
        reason: 'start',
        projectId: draft.projectId,
        isChat: true,
        workspaceState: selectionState({
          activeView: 'chat',
          selectedProjectId: draft.projectId,
          selectedSessionPath: draft.sessionPath,
        }),
      }),
    ).toBe(true)

    expect(
      shouldDisplayStartedThreadForLocalDraft({
        reason: 'start',
        projectId: draft.projectId,
        isChat: true,
        workspaceState: selectionState({
          activeView: 'thread',
          selectedProjectId: draft.projectId,
          selectedSessionPath: draft.sessionPath,
        }),
      }),
    ).toBe(false)
  })

  it('does not auto-open a started background thread over an empty thread view in another project', () => {
    expect(
      shouldAutoOpenStartedThread({
        reason: 'start',
        projectId: '/repo/project-a',
        workspaceState: selectionState({
          activeView: 'thread',
          selectedProjectId: '/repo/project-b',
          selectedSessionPath: null,
        }),
      }),
    ).toBe(false)
  })

  it('does not auto-open background starts for empty thread and code views', () => {
    expect(
      shouldAutoOpenStartedThread({
        reason: 'start',
        projectId: '/repo/project-a',
        workspaceState: selectionState({ activeView: 'thread', selectedSessionPath: null }),
      }),
    ).toBe(false)

    expect(
      shouldAutoOpenStartedThread({
        reason: 'start',
        projectId: '/repo/project-a',
        workspaceState: selectionState({ activeView: 'code' }),
      }),
    ).toBe(false)
  })

  it('does not auto-open non-start updates or when a persisted session is visible', () => {
    expect(
      shouldAutoOpenStartedThread({
        reason: 'end',
        projectId: '/repo/project-a',
        workspaceState: selectionState({ activeView: 'thread', selectedSessionPath: null }),
      }),
    ).toBe(false)

    expect(
      shouldAutoOpenStartedThread({
        reason: 'start',
        projectId: '/repo/project-a',
        workspaceState: selectionState({
          activeView: 'thread',
          selectedSessionPath: '/sessions/project-a.jsonl',
        }),
      }),
    ).toBe(false)
  })
})
