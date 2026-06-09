import type { SlackClient } from '~/adapters/slack'
import { logger } from '~/lib/logger'
import type { CalendarWriter } from '~/pipeline/calendar-writer'
import type { PendingStore } from '~/stores/pending'

export type ReactionAddedEvent = {
  type: 'reaction_added'
  user?: string
  reaction?: string
  item?: { type?: string; channel?: string; ts?: string }
}

export type ReactionsHandlerDeps = {
  slack: SlackClient
  pending: PendingStore
  writer: CalendarWriter
  allowedUserIds: Set<string>
}

const APPROVE_EMOJIS = new Set(['white_check_mark', 'heavy_check_mark', '+1'])
const REJECT_EMOJIS = new Set(['x', 'no_entry', '-1'])

function isValidMessageReaction(event: ReactionAddedEvent): event is ReactionAddedEvent & {
  user: string
  reaction: string
  item: { type: 'message'; channel: string; ts: string }
} {
  return (
    typeof event.user === 'string' &&
    typeof event.reaction === 'string' &&
    event.item?.type === 'message' &&
    typeof event.item.channel === 'string' &&
    typeof event.item.ts === 'string'
  )
}

export async function handleReaction(
  event: ReactionAddedEvent,
  deps: ReactionsHandlerDeps,
): Promise<void> {
  if (!isValidMessageReaction(event)) {
    logger.info('reactions.skipped.invalidPayload', { item: event.item?.type })
    return
  }
  if (!deps.allowedUserIds.has(event.user)) {
    logger.warn('reactions.unauthorizedUser', { user: event.user })
    return
  }

  const pending = await deps.pending.findByMessageTs(event.item.channel, event.item.ts)
  if (!pending || pending.status !== 'awaiting') return

  if (APPROVE_EMOJIS.has(event.reaction)) {
    // 'unknown' 属性のイベントは Calendar に書き込めない → ユーザーに再投稿を促す
    const unknownEvents = pending.events.filter((e) => e.attributedTo === 'unknown')
    if (unknownEvents.length > 0) {
      await deps.slack.postThreadMessage(
        pending.slackChannelId,
        pending.slackThreadTs,
        `⚠️ ${unknownEvents.length} 件の予定で誰のものか判別できません。\nスレッドで \`#長女 / #長男 / #末っ子 / #自分\` を指定して再投稿するか、新しい投稿でやり直してください。`,
      )
      logger.info('reactions.approvedButUnknown', {
        pendingId: pending.id,
        unknown: unknownEvents.length,
      })
      return
    }

    try {
      const slackEventId = `pending-${pending.id}`
      const results = await deps.writer.writeAll(pending.events, slackEventId)
      await deps.pending.updateStatus(pending.id, 'approved')
      const text = `✅ 承認: ${results.length} 件を登録しました`
      await deps.slack.postThreadMessage(pending.slackChannelId, pending.slackThreadTs, text)
      logger.info('reactions.approved', { pendingId: pending.id, count: results.length })
    } catch (err) {
      logger.error('reactions.approveFailed', {
        pendingId: pending.id,
        err: err instanceof Error ? err.message : String(err),
      })
      await deps.slack.postThreadMessage(
        pending.slackChannelId,
        pending.slackThreadTs,
        '⚠️ 登録に失敗しました。少し時間をおいて再度 ✅ を押してください。',
      )
    }
    return
  }

  if (REJECT_EMOJIS.has(event.reaction)) {
    await deps.pending.updateStatus(pending.id, 'rejected')
    await deps.slack.postThreadMessage(
      pending.slackChannelId,
      pending.slackThreadTs,
      '❌ 破棄しました',
    )
    logger.info('reactions.rejected', { pendingId: pending.id })
    return
  }
}
