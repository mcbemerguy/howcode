// Pi UI bridge Howcode adapter. Managed by integrations/howcode/scripts/patch-howcode.mjs.
import type { PiNotification } from '../../../../../shared/desktop-contracts'
import { openPathQuery } from '../../../query/desktop-query'

type PiNotificationCardProps = {
  notifications: PiNotification[]
}

function levelLabel(level: PiNotification['level']) {
  if (level === 'error') return 'Error'
  if (level === 'warning') return 'Warning'
  return 'Info'
}

function levelClass(level: PiNotification['level']) {
  if (level === 'error') return 'border-[color:var(--danger)]'
  if (level === 'warning') return 'border-[color:var(--accent-border)]'
  return 'border-[color:var(--border)]'
}

function detailActionLabel(notification: PiNotification) {
  return notification.detailKind === 'workflow-jsonl' ? 'Open events' : 'Open detail'
}

function PiNotificationEntry({ notification }: { notification: PiNotification }) {
  return (
    <section
      className={`rounded-2xl border bg-[color:var(--panel)] p-3 text-sm shadow-sm ${levelClass(notification.level)}`}
      aria-label={notification.title}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-[color:var(--text)]">{notification.title}</span>
            <span className="rounded-full bg-[color:var(--accent-muted)] px-2 py-0.5 text-xs text-[color:var(--text-muted)]">
              {levelLabel(notification.level)}
            </span>
          </div>
          {notification.message ? (
            <div className="mt-1 text-xs text-[color:var(--text-muted)]">
              {notification.message}
            </div>
          ) : null}
        </div>
      </div>
      {notification.auditPath || notification.detailPath ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {notification.auditPath ? (
            <button
              type="button"
              className="rounded-full border border-[color:var(--border)] px-3 py-1 text-xs text-[color:var(--text-muted)] hover:bg-[color:var(--hover)]"
              onClick={() => void openPathQuery(notification.auditPath ?? '')}
            >
              Open audit
            </button>
          ) : null}
          {notification.detailPath && notification.detailPath !== notification.auditPath ? (
            <button
              type="button"
              className="rounded-full border border-[color:var(--border)] px-3 py-1 text-xs text-[color:var(--text-muted)] hover:bg-[color:var(--hover)]"
              onClick={() => void openPathQuery(notification.detailPath ?? '')}
            >
              {detailActionLabel(notification)}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

export function PiNotificationCard({ notifications }: PiNotificationCardProps) {
  if (notifications.length === 0) return null
  const visibleNotifications = notifications.slice(-2).reverse()
  return (
    <div className="mb-2 grid gap-2">
      {visibleNotifications.map((notification) => (
        <PiNotificationEntry key={notification.id} notification={notification} />
      ))}
    </div>
  )
}
