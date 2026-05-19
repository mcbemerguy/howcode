import { describe, expect, test, vi } from 'vitest'
import { withHeadlessAgentSessionLifecycle } from './agent-session-extensions.ts'
import { mapSessionCommands } from './composer-slash-command-mapping.ts'
import type { PiRuntime } from './types.ts'

vi.mock('./headless-pi-theme.ts', () => ({
  applyHeadlessPiTheme: vi.fn(async () => undefined),
}))

type RegisteredCommand = ReturnType<PiRuntime['session']['extensionRunner']['getRegisteredCommands']>[number]

function createLifecycleSensitiveSession(options: { failBind?: boolean } = {}) {
  const commands: RegisteredCommand[] = []
  const events: string[] = []
  const extensionRunner = {
    emitContext: vi.fn(async (messages: unknown[]) => messages),
    getCommand: vi.fn(() => undefined),
    hasHandlers: vi.fn((eventType: string) => eventType === 'session_shutdown'),
    emit: vi.fn(async (event: { type: string }) => {
      events.push(event.type)
    }),
    getRegisteredCommands: vi.fn(() => commands),
  }
  const session = {
    agent: { waitForIdle: vi.fn(async () => undefined) },
    extensionRunner,
    bindExtensions: vi.fn(async () => {
      events.push('session_start')
      if (options.failBind) throw new Error('bind failed')
      commands.push({
        invocationName: 'workflow:code-review-fix',
        description: 'Run code review fix workflow',
        sourceInfo: { source: 'extension' },
      } as RegisteredCommand)
    }),
    navigateTree: vi.fn(async () => ({ cancelled: true })),
    promptTemplates: [],
    resourceLoader: {
      getSkills: vi.fn(() => ({ skills: [] })),
      getThemes: vi.fn(() => ({ themes: [] })),
    },
    settingsManager: {
      getEnableSkillCommands: vi.fn(() => false),
      getTheme: vi.fn(() => undefined),
    },
    dispose: vi.fn(),
  } as unknown as PiRuntime['session']

  return { events, session }
}

describe('headless Pi extension lifecycle', () => {
  test('binds startup-equivalent lifecycle before mapping slash commands', async () => {
    const { events, session } = createLifecycleSensitiveSession()

    const commands = await withHeadlessAgentSessionLifecycle(session, mapSessionCommands)

    expect(commands.map((command) => command.name)).toContain('workflow:code-review-fix')
    expect(session.bindExtensions).toHaveBeenCalledTimes(1)
    expect(session.extensionRunner.emit).toHaveBeenCalledWith({
      type: 'session_shutdown',
      reason: 'quit',
    })
    expect(session.dispose).toHaveBeenCalledTimes(1)
    expect(events).toEqual(['session_start', 'session_shutdown'])
  })

  test('shuts down and disposes temporary lifecycle sessions when mapping fails', async () => {
    const { events, session } = createLifecycleSensitiveSession()

    await expect(
      withHeadlessAgentSessionLifecycle(session, () => {
        throw new Error('mapping failed')
      }),
    ).rejects.toThrow('mapping failed')

    expect(session.extensionRunner.emit).toHaveBeenCalledWith({
      type: 'session_shutdown',
      reason: 'quit',
    })
    expect(session.dispose).toHaveBeenCalledTimes(1)
    expect(events).toEqual(['session_start', 'session_shutdown'])
  })

  test('shuts down and disposes temporary lifecycle sessions when startup binding fails', async () => {
    const { events, session } = createLifecycleSensitiveSession({ failBind: true })

    await expect(withHeadlessAgentSessionLifecycle(session, mapSessionCommands)).rejects.toThrow(
      'bind failed',
    )

    expect(session.extensionRunner.emit).toHaveBeenCalledWith({
      type: 'session_shutdown',
      reason: 'quit',
    })
    expect(session.dispose).toHaveBeenCalledTimes(1)
    expect(events).toEqual(['session_start', 'session_shutdown'])
  })
})
