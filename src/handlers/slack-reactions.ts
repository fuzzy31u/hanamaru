import type { SlackClient } from '~/adapters/slack'
import { logger } from '~/lib/logger'
import type { CalendarWriter } from '~/pipeline/calendar-writer'
import type { PendingStore } from '~/stores/pending'

export type ReactionAddedEvent = {
  type: 'reaction_added'
  user: string
  reaction: string
  item: { type: 'message'; channel: string; ts: string }
}

export type ReactionsHandlerDeps = {
  slack: SlackClient
  pending: PendingStore
  writer: CalendarWriter
  allowedUserIds: Set<string>
}

const APPROVE_EMOJIS = new Set(['white_check_mark', 'heavy_check_mark', '+1'])
const REJECT_EMOJIS = new Set(['x', 'no_entry', '-1'])

export async function handleReaction(
  event: ReactionAddedEvent,
  deps: ReactionsHandlerDeps,
): Promise<void> {
  if (!deps.allowedUserIds.has(event.user)) {
    logger.warn('reactions.unauthorizedUser', { user: event.user })
    return
  }

  const pending = await deps.pending.findByMessageTs(event.item.channel, event.item.ts)
  if (!pending || pending.status !== 'awaiting') return

  if (APPROVE_EMOJIS.has(event.reaction)) {
    const slackEventId = `pending-${pending.id}`
    const results = await deps.writer.writeAll(pending.events, slackEventId)
    await deps.pending.updateStatus(pending.id, 'approved')
    const text = `✅ 承認: ${results.length} 件を登録しました`
    await deps.slack.postThreadMessage(pending.slackChannelId, pending.slackThreadTs, text)
    logger.info('reactions.approved', { pendingId: pending.id, count: results.length })
    return
  }

  if (REJECT_EMOJIS.has(event.reaction)) {
    await deps.pending.updateStatus(pending.id, 'rejected')
    await deps.slack.postThreadMessage(pending.slackChannelId, pending.slackThreadTs, '❌ 破棄しました')
    logger.info('reactions.rejected', { pendingId: pending.id })
    return
  }
}
