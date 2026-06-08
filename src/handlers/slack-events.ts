import type { Context } from 'hono'
import type { SlackClient } from '~/adapters/slack'
import type { ExtractionInput } from '~/config/schema'
import { logger } from '~/lib/logger'
import { parsePrefix } from '~/pipeline/prefix-parser'

export type SlackMessageEvent = {
  type: 'message'
  subtype?: string
  user?: string
  bot_id?: string
  channel: string
  ts: string
  thread_ts?: string
  text?: string
  files?: Array<{ url_private: string; mimetype: string }>
}

export type SlackEventCallback = {
  type: 'event_callback' | 'url_verification'
  challenge?: string
  team_id?: string
  event_id?: string
  event_time?: number
  event?: SlackMessageEvent | { type: string }
}

export type EventsHandlerDeps = {
  slack: SlackClient
  allowedUserIds: Set<string>
  process: (input: ExtractionInput, slackEventId: string) => Promise<unknown>
}

export async function handleSlackEvent(
  c: Context,
  body: SlackEventCallback,
  deps: EventsHandlerDeps,
): Promise<Response> {
  if (body.type === 'url_verification') {
    return c.json({ challenge: body.challenge })
  }
  if (body.type !== 'event_callback') return c.body(null, 200)
  if (!body.event || body.event.type !== 'message') return c.body(null, 200)

  const event = body.event as SlackMessageEvent
  if (event.bot_id) return c.body(null, 200)
  if (event.subtype && event.subtype !== 'file_share') return c.body(null, 200)
  if (!event.user || !deps.allowedUserIds.has(event.user)) {
    logger.warn('slackEvents.unauthorizedUser', { user: event.user })
    return c.body(null, 200)
  }

  const slackEventId = body.event_id ?? `${body.team_id}-${event.ts}`
  const { prefixHint, modeHint, remainingText } = parsePrefix(event.text ?? '')

  const images: ExtractionInput['images'] = []
  for (const f of event.files ?? []) {
    const fetched = await deps.slack.getFileBytes(f.url_private)
    images.push({
      base64: Buffer.from(fetched.bytes).toString('base64'),
      mimeType: fetched.mimeType,
    })
  }

  const input: ExtractionInput = {
    postedAt: new Date((body.event_time ?? Number(event.ts)) * 1000).toISOString(),
    authorUserId: event.user,
    channelId: event.channel,
    threadTs: event.thread_ts ?? event.ts,
    text: remainingText,
    prefixHint,
    modeHint,
    images,
  }

  void deps
    .process(input, slackEventId)
    .catch((err) =>
      logger.error('slackEvents.processFailed', { slackEventId, err: String(err) }),
    )

  return c.body(null, 200)
}
