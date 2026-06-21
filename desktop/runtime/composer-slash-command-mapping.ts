import {
  appNewSessionSlashCommand,
  appSettingsSlashCommand,
  compactSlashCommand,
} from '../../shared/composer-slash-commands.ts'
import type { ComposerSlashCommand } from '../../shared/desktop-contracts.ts'
import type { PiUiBridgeSlashCommand } from '../runtime-host/pi-ui-bridge-host.ts'
import type { PiRuntime } from './types.ts'

const reservedCommandNames = new Set([
  appSettingsSlashCommand.name,
  appNewSessionSlashCommand.name,
  compactSlashCommand.name,
])

export function mapPiSessionCommands(piCommands: PiUiBridgeSlashCommand[]): ComposerSlashCommand[] {
  const commands: ComposerSlashCommand[] = [
    appSettingsSlashCommand,
    appNewSessionSlashCommand,
    compactSlashCommand,
  ]
  const extensionCommandNames = new Set<string>()

  for (const command of piCommands) {
    if (reservedCommandNames.has(command.name)) {
      continue
    }

    if (command.source !== 'extension' && extensionCommandNames.has(command.name)) {
      continue
    }

    if (command.source === 'extension') {
      extensionCommandNames.add(command.name)
    }

    commands.push({
      name: command.name,
      description: command.description,
      source: command.source,
      sourceInfo: command.sourceInfo,
    })
  }

  return commands
}

export function mapSessionCommands(session: PiRuntime['session']): ComposerSlashCommand[] {
  return mapPiSessionCommands([
    ...session.extensionRunner.getRegisteredCommands().map((command) => ({
      name: command.invocationName,
      description: command.description,
      source: 'extension' as const,
      sourceInfo: command.sourceInfo,
    })),
    ...session.promptTemplates.map((template) => ({
      name: template.name,
      description: template.description,
      source: 'prompt' as const,
      sourceInfo: template.sourceInfo,
    })),
    ...(session.settingsManager.getEnableSkillCommands()
      ? session.resourceLoader.getSkills().skills.map((skill) => ({
          name: `skill:${skill.name}`,
          description: skill.description,
          source: 'skill' as const,
          sourceInfo: skill.sourceInfo,
        }))
      : []),
  ])
}
