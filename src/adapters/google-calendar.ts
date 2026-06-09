import { type calendar_v3, google } from 'googleapis'
import { CalendarWriteError } from '~/lib/errors'
import { logger } from '~/lib/logger'

const DEFAULT_TIMED_DURATION_MS = 60 * 60 * 1000 // 1 hour

/** ISO 8601 文字列を JST の YYYY-MM-DD に変換（タイムゾーン情報を尊重） */
function jstDatePart(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(iso))
  const y = parts.find((p) => p.type === 'year')?.value ?? ''
  const m = parts.find((p) => p.type === 'month')?.value ?? ''
  const d = parts.find((p) => p.type === 'day')?.value ?? ''
  return `${y}-${m}-${d}`
}

/** YYYY-MM-DD の翌日を返す */
function addOneDay(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/** endAt 未指定時のデフォルト終了時刻（開始 + 1 時間、ISO 8601 with JST offset） */
function defaultEndForStart(startAt: string): string {
  const d = new Date(new Date(startAt).getTime() + DEFAULT_TIMED_DURATION_MS)
  // JST offset で出力
  const tzFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const parts = tzFormatter.formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}+09:00`
}

export type CalendarEventInput = {
  calendarId: string
  eventId: string
  summary: string
  description: string | null
  location: string | null
  startAt: string
  endAt: string | null
  allDay: boolean
}

export type CalendarClient = {
  insertEvent(input: CalendarEventInput): Promise<{ id: string; htmlLink: string }>
  deleteEvent(calendarId: string, eventId: string): Promise<void>
}

export type CalendarClientConfig = {
  clientId: string
  clientSecret: string
  refreshToken: string
}

export function createCalendarClient(config: CalendarClientConfig): CalendarClient {
  const oauth2 = new google.auth.OAuth2(config.clientId, config.clientSecret)
  oauth2.setCredentials({ refresh_token: config.refreshToken })
  const calendar = google.calendar({ version: 'v3', auth: oauth2 })

  return {
    async insertEvent(input) {
      const body: calendar_v3.Schema$Event = {
        id: input.eventId,
        summary: input.summary,
        description: input.description ?? undefined,
        location: input.location ?? undefined,
      }
      if (input.allDay) {
        const startDate = jstDatePart(input.startAt)
        const endDate = input.endAt ? jstDatePart(input.endAt) : startDate
        body.start = { date: startDate }
        body.end = { date: addOneDay(endDate) }
      } else {
        const endAt = input.endAt ?? defaultEndForStart(input.startAt)
        body.start = { dateTime: input.startAt, timeZone: 'Asia/Tokyo' }
        body.end = { dateTime: endAt, timeZone: 'Asia/Tokyo' }
      }

      try {
        const res = await calendar.events.insert({
          calendarId: input.calendarId,
          requestBody: body,
        })
        logger.info('calendar.inserted', { calendarId: input.calendarId, eventId: res.data.id })
        return { id: res.data.id ?? input.eventId, htmlLink: res.data.htmlLink ?? '' }
      } catch (err) {
        const status = (err as { code?: number }).code
        if (status === 409) {
          logger.info('calendar.duplicate', {
            calendarId: input.calendarId,
            eventId: input.eventId,
          })
          return { id: input.eventId, htmlLink: '' }
        }
        throw new CalendarWriteError(`Calendar insert failed: ${(err as Error).message}`, err)
      }
    },

    async deleteEvent(calendarId, eventId) {
      try {
        await calendar.events.delete({ calendarId, eventId })
        logger.info('calendar.deleted', { calendarId, eventId })
      } catch (err) {
        const status = (err as { code?: number }).code
        if (status === 404 || status === 410) return
        throw new CalendarWriteError(`Calendar delete failed: ${(err as Error).message}`, err)
      }
    },
  }
}
