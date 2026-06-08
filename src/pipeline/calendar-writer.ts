import { createHash } from 'node:crypto'
import type { CalendarClient } from '~/adapters/google-calendar'
import type { ChildrenMap } from '~/config/children'
import type { ExtractedEvent } from '~/config/schema'

export type WriteResult = {
  eventId: string
  htmlLink: string
  calendarId: string
  child: string
}

export type CalendarWriter = {
  writeAll(events: ExtractedEvent[], slackEventId: string): Promise<WriteResult[]>
  remove(events: WriteResult[]): Promise<void>
}

export function createCalendarWriter(
  calendar: CalendarClient,
  children: ChildrenMap,
): CalendarWriter {
  function pickCalendarId(child: ExtractedEvent['attributedTo']): string {
    if (child === 'unknown') throw new Error('Cannot write event with attributedTo=unknown')
    return children[child].calendarId
  }

  function buildEventId(slackEventId: string, index: number): string {
    // Google Calendar event ID は base32hex (a-v + 0-9) のみ。SHA-256 hex (a-f + 0-9) はサブセット。
    const hash = createHash('sha256').update(slackEventId).digest('hex').slice(0, 20)
    return `hnm${hash}${index}`
  }

  return {
    async writeAll(events, slackEventId) {
      const tasks = events.map(async (event, index) => {
        const calendarId = pickCalendarId(event.attributedTo)
        const eventId = buildEventId(slackEventId, index)
        const inserted = await calendar.insertEvent({
          calendarId,
          eventId,
          summary: event.title,
          description: event.description,
          location: event.location,
          startAt: event.startAt,
          endAt: event.endAt,
          allDay: event.allDay,
        })
        return {
          eventId: inserted.id,
          htmlLink: inserted.htmlLink,
          calendarId,
          child: event.attributedTo,
        }
      })
      return Promise.all(tasks)
    },

    async remove(events) {
      await Promise.all(events.map((e) => calendar.deleteEvent(e.calendarId, e.eventId)))
    },
  }
}
