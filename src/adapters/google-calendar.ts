import { type calendar_v3, google } from 'googleapis'
import { CalendarWriteError } from '~/lib/errors'
import { logger } from '~/lib/logger'

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
        body.start = { date: input.startAt.slice(0, 10) }
        body.end = { date: (input.endAt ?? input.startAt).slice(0, 10) }
      } else {
        body.start = { dateTime: input.startAt, timeZone: 'Asia/Tokyo' }
        body.end = { dateTime: input.endAt ?? input.startAt, timeZone: 'Asia/Tokyo' }
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
