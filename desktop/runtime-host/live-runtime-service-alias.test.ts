import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ComposerState, DesktopEvent } from '../../shared/desktop-contracts.ts'
import { createLocalThreadDraft } from '../../shared/session-paths.ts'
import { rememberRuntimeLocalDraftSessionAlias } from '../runtime/composer-session-aliases.ts'
import { setRuntimeHostEventSink } from './host-events.ts'
import { sendComposerPrompt } from './live-runtime-service.ts'
import { bindRuntimeExtensionHandlers } from './runtime-extension-bindings.ts'

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

const mocks = vi.hoisted(() => ({
  applyComposerModeSettings: vi.fn(),
  buildComposerState: vi.fn(),
  buildComposerStateSnapshot: vi.fn(),
  buildComposerPromptMessage: vi.fn(),
  compactComposerRuntime: vi.fn(),
  createRuntimeForNewSession: vi.fn(),
  getCachedRuntimeForSessionPath: vi.fn(),
  getOrCreateRuntimeForSessionPath: vi.fn(),
  promptComposerRuntime: vi.fn(),
  bindHeadlessAgentSessionExtensions: vi.fn(),
  refreshHeadlessAgentSessionExtensionBindings: vi.fn(),
}))

vi.mock('../app-settings/readers.ts', () => ({
  loadAppSettings: () => ({ composerStreamingBehavior: 'steer' }),
}))

vi.mock('../runtime/agent-session-extensions.ts', () => ({
  bindHeadlessAgentSessionExtensions: mocks.bindHeadlessAgentSessionExtensions,
  refreshHeadlessAgentSessionExtensionBindings: mocks.refreshHeadlessAgentSessionExtensionBindings,
}))

vi.mock('../runtime/composer-mode-settings.ts', () => ({
  applyComposerModeSettings: mocks.applyComposerModeSettings,
  setDraftComposerModel: vi.fn(),
  setDraftComposerThinkingLevel: vi.fn(),
}))

vi.mock('../runtime/composer-prompt-flow.ts', () => ({
  buildComposerPromptMessage: mocks.buildComposerPromptMessage,
  compactComposerRuntime: mocks.compactComposerRuntime,
  promptComposerRuntime: mocks.promptComposerRuntime,
}))

vi.mock('../runtime/composer-skill-references.ts', () => ({
  expandRuntimeDollarSkillReferences: (_runtime: unknown, text: string) => text,
  mapSessionSkills: vi.fn(),
}))

vi.mock('../runtime/composer-state.ts', () => ({
  buildComposerState: mocks.buildComposerState,
  buildComposerStateSnapshot: mocks.buildComposerStateSnapshot,
}))

vi.mock('./composer-resource-service.ts', () => ({
  getComposerSessionResources: vi.fn(),
}))

vi.mock('./live-runtime-registry.ts', () => ({
  abortRuntimeExtensionCommand: vi.fn(),
  createRuntimeForNewSession: mocks.createRuntimeForNewSession,
  getCachedRuntimeForSessionPath: mocks.getCachedRuntimeForSessionPath,
  getOrCreateRuntimeForSessionPath: mocks.getOrCreateRuntimeForSessionPath,
  isRuntimeExtensionCommandRunning: vi.fn(() => false),
  reloadRuntimeSettingsIfSafe: vi.fn(),
  scheduleRuntimeDisposal: vi.fn(),
  withRuntimeMutationLock: vi.fn(async (_sessionPath: string, run: () => Promise<unknown>) =>
    run(),
  ),
}))

vi.mock('./slash-command-service.ts', () => ({
  mapSessionCommands: vi.fn(),
}))

describe('runtime-host local draft composer aliases', () => {
  afterEach(() => {
    vi.clearAllMocks()
    setRuntimeHostEventSink(() => undefined)
  })

  test('records local draft aliases on new-session sends and emits them on composer updates', async () => {
    const projectId = '/repo/project-a'
    const persistedSessionPath = '/repo/project-a/.pi/sessions/persisted-runtime-host.jsonl'
    const draft = createLocalThreadDraft(projectId, 'draft')
    const events: DesktopEvent[] = []
    setRuntimeHostEventSink((event) => events.push(event))

    const workflowComposer = composerState({
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
          childSessionPath: null,
          elapsedMs: 1000,
          error: null,
          updatedAt: '2026-05-20T00:00:00.000Z',
          terminal: false,
        },
      ],
    })
    const piRuntime = {
      cwd: projectId,
      chatGroupId: null,
      session: {
        sessionFile: persistedSessionPath,
        sessionId: 'thread-1',
        isStreaming: false,
        isCompacting: false,
      },
    }

    mocks.createRuntimeForNewSession.mockResolvedValue(piRuntime)
    mocks.getCachedRuntimeForSessionPath.mockReturnValue(Promise.resolve(piRuntime))
    mocks.buildComposerState.mockResolvedValue(workflowComposer)
    mocks.buildComposerPromptMessage.mockReturnValue({ role: 'user', content: ['go'] })
    mocks.promptComposerRuntime.mockImplementation(
      async ({ adapters, request, runtime: activeRuntime }) => {
        await adapters.emitComposerUpdate({
          ...request,
          sessionPath: activeRuntime.session.sessionFile,
        })
        return {
          outcome: 'sent',
          sessionPath: activeRuntime.session.sessionFile,
          threadId: activeRuntime.session.sessionId,
        }
      },
    )

    await sendComposerPrompt({
      projectId,
      sessionPath: draft.sessionPath,
      text: '/workflow:review-fix go',
      streamingBehavior: 'steer',
    })

    expect(events).toContainEqual({
      type: 'composer-update',
      projectId,
      sessionPath: persistedSessionPath,
      localDraftSessionPath: draft.sessionPath,
      composer: workflowComposer,
    })
  })

  test('emits local draft aliases for extension command state updates', async () => {
    const projectId = '/repo/project-extension-state'
    const persistedSessionPath = '/repo/project-extension-state/.pi/sessions/persisted.jsonl'
    const draft = createLocalThreadDraft(projectId, 'extension-draft')
    const events: DesktopEvent[] = []
    setRuntimeHostEventSink((event) => events.push(event))

    const workflowComposer = composerState({ isExtensionCommandRunning: true })
    const piRuntime = {
      cwd: projectId,
      chatGroupId: null,
      session: {
        sessionFile: persistedSessionPath,
        sessionId: 'thread-extension-state',
        isStreaming: false,
        isCompacting: false,
      },
    }
    rememberRuntimeLocalDraftSessionAlias({
      runtime: piRuntime,
      persistedSessionPath,
      localDraftSessionPath: draft.sessionPath,
    })
    mocks.buildComposerState.mockResolvedValue(workflowComposer)

    await bindRuntimeExtensionHandlers(piRuntime as never, {
      isRuntimeExtensionCommandRunning: () => true,
      reloadRuntimeSettingsIfSafe: vi.fn(),
    })
    const binding = mocks.bindHeadlessAgentSessionExtensions.mock.calls[0]?.[1]
    binding?.onExtensionCommandStateChange?.()
    await vi.waitFor(() => expect(events).toHaveLength(1))

    expect(events[0]).toEqual({
      type: 'composer-update',
      projectId,
      sessionPath: persistedSessionPath,
      localDraftSessionPath: draft.sessionPath,
      composer: workflowComposer,
    })
  })

  test('records local draft aliases after new runtime session files appear', async () => {
    const projectId = '/repo/project-b'
    const persistedSessionPath = '/repo/project-b/.pi/sessions/persisted-after-preflight.jsonl'
    const draft = createLocalThreadDraft(projectId, 'late-draft')
    const events: DesktopEvent[] = []
    setRuntimeHostEventSink((event) => events.push(event))

    const workflowComposer = composerState({ isExtensionCommandRunning: true })
    const piRuntime = {
      cwd: projectId,
      chatGroupId: null,
      session: {
        sessionFile: null as string | null,
        sessionId: 'thread-late',
        isStreaming: false,
        isCompacting: false,
      },
    }

    mocks.createRuntimeForNewSession.mockResolvedValue(piRuntime)
    mocks.getCachedRuntimeForSessionPath.mockReturnValue(Promise.resolve(piRuntime))
    mocks.buildComposerState.mockResolvedValue(workflowComposer)
    mocks.buildComposerPromptMessage.mockReturnValue({ role: 'user', content: ['go'] })
    mocks.promptComposerRuntime.mockImplementation(
      async ({ adapters, request, runtime: activeRuntime }) => {
        activeRuntime.session.sessionFile = persistedSessionPath
        adapters.prepareRuntimeSessionForPublish?.(activeRuntime)
        await adapters.emitComposerUpdate({
          ...request,
          sessionPath: activeRuntime.session.sessionFile,
        })
        return {
          outcome: 'sent',
          sessionPath: activeRuntime.session.sessionFile,
          threadId: activeRuntime.session.sessionId,
        }
      },
    )

    await sendComposerPrompt({
      projectId,
      sessionPath: draft.sessionPath,
      text: '/workflow:review-fix go',
      streamingBehavior: 'steer',
    })

    expect(events).toContainEqual({
      type: 'composer-update',
      projectId,
      sessionPath: persistedSessionPath,
      localDraftSessionPath: draft.sessionPath,
      composer: workflowComposer,
    })
  })
})
