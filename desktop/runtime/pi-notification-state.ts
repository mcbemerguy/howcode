// Pi UI bridge Howcode adapter. Managed by integrations/howcode/scripts/patch-howcode.mjs.
import type { PiNotification } from '../../shared/desktop-contracts.ts'

const notificationRetentionMs = 10 * 60 * 1000
const notificationLimit = 20
const notificationsBySessionPath = new Map<string, PiNotification[]>()

type RuntimeSessionLike = { session: { sessionFile?: string | undefined } }

type UiBridgeEventLike = {
  id?: unknown
  type?: unknown
  timestamp?: unknown
  payload?: unknown
  source?: { extension?: unknown; toolCallId?: unknown; sessionId?: unknown } | undefined
}

type NotificationPayload = Record<string, unknown> & {
  auditPath?: unknown
  detailPath?: unknown
  detailKind?: unknown
  title?: unknown
  message?: unknown
  level?: unknown
  event?: unknown
}

function asRecord(value: unknown) {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function asString(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function asLevel(value: unknown): PiNotification['level'] {
  return value === 'warning' || value === 'error' || value === 'info' ? value : 'info'
}

function notificationAuditPath(payload: NotificationPayload) {
  return asString(payload.auditPath) ?? null
}

function notificationDetailPath(payload: NotificationPayload) {
  return asString(payload.detailPath) ?? null
}

function notificationDetailKind(payload: NotificationPayload) {
  const kind = payload.detailKind
  return kind === 'text' || kind === 'workflow-jsonl' ? kind : null
}

function normalizeNotificationEvent(input: unknown): PiNotification | null {
  const event = asRecord(input) as UiBridgeEventLike | null
  if (!event || event.type !== 'notification') return null
  const payload = asRecord(event.payload) as NotificationPayload | null
  if (!payload) return null
  const title = asString(payload.title) ?? 'Pi'
  const message = typeof payload.message === 'string' ? payload.message : ''
  if (!message && title === 'Pi') return null
  const createdAt = asString(event.timestamp) ?? new Date().toISOString()
  return {
    id: asString(event.id) ?? `pi_notification_${Date.now().toString(36)}`,
    title,
    message,
    level: asLevel(payload.level),
    event: asString(payload.event) ?? null,
    auditPath: notificationAuditPath(payload),
    detailPath: notificationDetailPath(payload),
    detailKind: notificationDetailKind(payload),
    createdAt,
    source: {
      extension: asString(event.source?.extension) ?? null,
      toolCallId: asString(event.source?.toolCallId) ?? null,
      sessionId: asString(event.source?.sessionId) ?? null,
    },
  }
}

function isExpired(notification: PiNotification, nowMs: number) {
  const createdAtMs = Date.parse(notification.createdAt)
  if (!Number.isFinite(createdAtMs)) return false
  return nowMs - createdAtMs > notificationRetentionMs
}

export function recordPiNotificationEvent(runtime: RuntimeSessionLike, input: unknown) {
  const sessionPath = runtime.session.sessionFile
  if (!sessionPath) return false
  const notification = normalizeNotificationEvent(input)
  if (!notification) return false
  const current = notificationsBySessionPath.get(sessionPath) ?? []
  const deduped = current.filter((entry) => entry.id !== notification.id)
  deduped.push(notification)
  notificationsBySessionPath.set(sessionPath, deduped.slice(-notificationLimit))
  return true
}

export function getPiNotifications(runtime: RuntimeSessionLike, nowMs = Date.now()) {
  const sessionPath = runtime.session.sessionFile
  if (!sessionPath) return []
  const current = notificationsBySessionPath.get(sessionPath) ?? []
  const active = current.filter((notification) => !isExpired(notification, nowMs))
  if (active.length === 0) notificationsBySessionPath.delete(sessionPath)
  else if (active.length !== current.length) notificationsBySessionPath.set(sessionPath, active)
  return active
}

export function clearPiNotifications(runtime: RuntimeSessionLike) {
  const sessionPath = runtime.session.sessionFile
  if (sessionPath) notificationsBySessionPath.delete(sessionPath)
}
