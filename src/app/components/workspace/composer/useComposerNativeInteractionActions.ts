import type { ComposerProps } from '../composer'

export function useComposerNativeInteractionActions({
  chatGroupId,
  composerMode,
  projectId,
  runComposerAction,
  sessionPath,
}: {
  chatGroupId: string | null | undefined
  composerMode: 'chat' | 'code'
  projectId: string
  runComposerAction: (
    action: Parameters<ComposerProps['onAction']>[0],
    payload: NonNullable<Parameters<ComposerProps['onAction']>[1]>,
  ) => Promise<boolean>
  sessionPath: string | null
}) {
  const answerNativeInteraction = async (requestId: string, response: unknown) => {
    return await runComposerAction('composer.answer-native-interaction', {
      projectId,
      sessionPath,
      composerMode,
      chatGroupId,
      requestId,
      response,
    })
  }

  return { answerNativeInteraction }
}
