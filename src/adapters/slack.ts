import { WebClient } from '@slack/web-api'
import { logger } from '~/lib/logger'

export type SlackClient = {
  postThreadMessage(channel: string, threadTs: string, text: string): Promise<{ ts: string }>
  postChannelMessage(channel: string, text: string): Promise<{ ts: string }>
  postDirectMessage(userId: string, text: string): Promise<void>
  getFileBytes(url: string): Promise<{ bytes: Uint8Array; mimeType: string }>
}

export type SlackClientConfig = {
  botToken: string
}

export function createSlackClient(config: SlackClientConfig): SlackClient {
  const client = new WebClient(config.botToken)

  return {
    async postThreadMessage(channel, threadTs, text) {
      const res = await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text,
        unfurl_links: false,
        unfurl_media: false,
      })
      logger.info('slack.threadReply', { channel, threadTs, ts: res.ts })
      return { ts: res.ts as string }
    },

    async postChannelMessage(channel, text) {
      const res = await client.chat.postMessage({ channel, text })
      return { ts: res.ts as string }
    },

    async postDirectMessage(userId, text) {
      const im = await client.conversations.open({ users: userId })
      const channel = (im.channel as { id: string }).id
      await client.chat.postMessage({ channel, text })
      logger.info('slack.dmSent', { userId })
    },

    async getFileBytes(url) {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${config.botToken}` },
      })
      if (!res.ok) throw new Error(`Slack file fetch failed: ${res.status}`)
      const buffer = await res.arrayBuffer()
      return {
        bytes: new Uint8Array(buffer),
        mimeType: res.headers.get('content-type') ?? 'application/octet-stream',
      }
    },
  }
}
