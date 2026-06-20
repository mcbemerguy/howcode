export type ComposerThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export type ComposerStreamingBehavior = 'steer' | 'followUp' | 'stop'

export type ComposerQueuedPrompt = {
  id: string
  mode: Exclude<ComposerStreamingBehavior, 'stop'>
  queueIndex: number
  queueSnapshotKey: string
  text: string
}

export type NativeAskQuestionOption = {
  label: string
  description?: string | undefined
}

export type NativeAskQuestion = {
  id: string
  question: string
  multiple?: boolean | undefined
  options: NativeAskQuestionOption[]
}

export type NativeAskQuestionsRequest = {
  id: string
  questions: NativeAskQuestion[]
}

export type NativeInteractionRequest = {
  id: string
  kind: string
  title?: string | undefined
  payload: unknown
  source?:
    | {
        extension?: string | undefined
        toolCallId?: string | undefined
        sessionId?: string | undefined
      }
    | undefined
}

export type PiAskUserQuestionsAlternative = {
  text: string
  recommended: boolean
  isOther: boolean
  originalIndex: number | null
}

export type PiAskUserQuestionsQuestion = {
  id: string
  question: string
  alternatives: PiAskUserQuestionsAlternative[]
}

export type PiAskUserQuestionsPayload = {
  questions: PiAskUserQuestionsQuestion[]
}

export type PiAskUserQuestionsAnswer = {
  questionId: string
  question: string
  selectedIndex: number
  selectedOriginalIndex: number | null
  answer: string
  fromOther: boolean
  edited: boolean
}

export type PiAskUserQuestionsResponse =
  | { status: 'denied' }
  | { status: 'confirmed'; answers: PiAskUserQuestionsAnswer[] }

export type PiNotification = {
  id: string
  title: string
  message: string
  level: 'info' | 'warning' | 'error'
  event: string | null
  auditPath: string | null
  detailPath: string | null
  detailKind: 'text' | 'workflow-jsonl' | null
  createdAt: string
  source: {
    extension: string | null
    toolCallId: string | null
    sessionId: string | null
  }
}

export type PiWorkflowProgressRun = {
  runId: string
  workflowId: string
  runDir: string | null
  auditPath: string | null
  detailPath: string | null
  detailKind: 'text' | 'workflow-jsonl' | null
  currentStepId: string | null
  currentStepType: string | null
  currentStepStatus: string | null
  status: string
  activity: string | null
  currentTool: string | null
  childSessionId: string | null
  childSessionPath: string | null
  elapsedMs: number | null
  error: string | null
  updatedAt: string
  terminal: boolean
}

export type ComposerBridgeState = {
  nativeInteractionRequests: NativeInteractionRequest[]
  nativeAskQuestionsRequest: NativeAskQuestionsRequest | null
  workflowProgressRuns: PiWorkflowProgressRun[]
  piNotifications: PiNotification[]
}

export type ComposerModel = {
  provider: string
  id: string
  name: string
  reasoning: boolean
  input: Array<'text' | 'image'>
}

export type ComposerContextUsage = {
  tokens: number | null
  contextWindow: number
  percent: number | null
}

export type ComposerState = {
  currentModel: ComposerModel | null
  availableModels: ComposerModel[]
  currentThinkingLevel: ComposerThinkingLevel
  availableThinkingLevels: ComposerThinkingLevel[]
  queuedPrompts: ComposerQueuedPrompt[]
  bridge: ComposerBridgeState
  contextUsage: ComposerContextUsage | null
  isCompacting: boolean
  isExtensionCommandRunning: boolean
}

export type ComposerAttachment = {
  path: string
  name: string
  kind: 'directory' | 'text' | 'image'
}

export type ComposerFilePickerEntry = {
  path: string
  name: string
  kind: 'directory' | 'text' | 'image'
}

export type ComposerFilePickerState = {
  homePath: string
  rootPath: string
  currentPath: string
  parentPath: string | null
  entries: ComposerFilePickerEntry[]
}

export type ComposerFileSearchEntry = ComposerFilePickerEntry & {
  relativePath: string
}

export type ComposerStateRequest = {
  projectId?: string | undefined | null | undefined
  sessionPath?: string | undefined | null | undefined
  composerMode?: 'chat' | 'code' | null | undefined
  composerModelSelection?: { provider: string | undefined; id: string } | null
  composerUseDefaultModel?: boolean | undefined
  composerThinkingLevel?: ComposerThinkingLevel | null | undefined
  composerStreamingBehavior?: ComposerStreamingBehavior | null | undefined
  composerSessionDir?: string | undefined | null | undefined
  chatGroupId?: string | undefined | null | undefined
  branchName?: string | undefined | null | undefined
}

export type ComposerSlashCommandSource = 'app' | 'builtin' | 'extension' | 'prompt' | 'skill'

export type ComposerSlashCommand = {
  name: string
  description?: string | undefined
  source: ComposerSlashCommandSource
  sourceInfo?: unknown | undefined
}

export type ComposerSkillReference = {
  name: string
  description: string
  filePath: string
  sourceInfo?: unknown | undefined
}
