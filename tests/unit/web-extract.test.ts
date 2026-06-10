import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { CalendarClient } from '~/adapters/google-calendar'
import type { ChildrenMap } from '~/config/children'
import type { ExtractedEvent } from '~/config/schema'
import { DEFAULT_THRESHOLDS } from '~/config/thresholds'
import { createWebExtractHandler } from '~/handlers/web-extract'
import type { ReviewResult, ScheduleAgent } from '~/pipeline/agent'
import type { Extractor } from '~/pipeline/extractor'

function makeCalendar(opts: { rejects?: boolean } = {}): CalendarClient {
  return {
    insertEvent: vi.fn(async (input) => {
      if (opts.rejects) throw new Error('calendar exploded')
      return {
        id: input.eventId,
        htmlLink: `https://calendar.google.com/event?eid=${input.eventId}`,
      }
    }),
    deleteEvent: vi.fn(async () => {}),
  }
}

const children = {
  child1: { label: '長女', calendarId: 'c1', aliases: [], contexts: [] },
  child2: { label: '長男', calendarId: 'c2', aliases: [], contexts: [] },
  child3: { label: '末っ子', calendarId: 'c3', aliases: [], contexts: [] },
  self: { label: '自分', calendarId: 'self', aliases: [], contexts: [] },
} satisfies ChildrenMap

const highConfidenceEvent: ExtractedEvent = {
  title: '授業参観',
  startAt: '2026-06-20T14:00:00+09:00',
  endAt: '2026-06-20T15:00:00+09:00',
  allDay: false,
  location: '3年2組教室',
  description: null,
  attributedTo: 'child1',
  attributionConfidence: 0.95,
  datetimeConfidence: 0.95,
  rawExcerpt: '授業参観',
}

const lowConfidenceEvent: ExtractedEvent = {
  ...highConfidenceEvent,
  title: '謎の予定',
  attributedTo: 'unknown',
  attributionConfidence: 0.3,
  datetimeConfidence: 0.4,
  rawExcerpt: '謎',
}

function makeExtractor(
  events: ExtractedEvent[],
  opts: { throws?: boolean; capture?: (input: unknown) => void } = {},
): Extractor {
  return {
    extract: vi.fn(async (input) => {
      opts.capture?.(input)
      if (opts.throws) throw new Error('Gemini exploded')
      return { events, summary: 'ok' }
    }),
  }
}

function makeAgent(result: ReviewResult): ScheduleAgent {
  return { reviewAndPersist: vi.fn(async () => result) }
}

type ExtractResponse = {
  mcpEnabled: boolean
  events: Array<Record<string, unknown>>
  conflicts: unknown[]
  toolCalls: Array<Record<string, unknown>>
  summary?: string
  error?: string
  calendarWritten?: boolean
  calendarLinks?: Array<{ title: string; htmlLink: string }>
}

function appWith(handler: ReturnType<typeof createWebExtractHandler>) {
  const app = new Hono()
  app.post('/api/extract', handler)
  return app
}

async function readJson(res: Response): Promise<ExtractResponse> {
  return (await res.json()) as ExtractResponse
}

function form(
  fields: Record<string, string>,
  file?: { name: string; type: string; bytes: Uint8Array },
) {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.append(k, v)
  if (file) {
    fd.append('images', new Blob([file.bytes], { type: file.type }), file.name)
  }
  return fd
}

describe('createWebExtractHandler', () => {
  it('runs extract→attribute→route for a text-only request and returns the JSON shape', async () => {
    const handler = createWebExtractHandler({
      extractor: makeExtractor([highConfidenceEvent, lowConfidenceEvent]),
      children,
      thresholds: DEFAULT_THRESHOLDS,
    })
    const res = await appWith(handler).request('/api/extract', {
      method: 'POST',
      body: form({ text: '授業参観のお知らせ' }),
    })
    expect(res.status).toBe(200)
    const body = await readJson(res)
    expect(body.mcpEnabled).toBe(false)
    expect(body.events).toHaveLength(2)
    expect(body.events[0]!.route).toBe('auto-register')
    expect(body.events[1]!.route).toBe('ask')
    expect(body.events[0]!).toMatchObject({
      title: '授業参観',
      attributedTo: 'child1',
      attributionConfidence: 0.95,
    })
    expect(body.conflicts).toEqual([])
    expect(body.toolCalls).toEqual([])
  })

  it('applies a prefix hint from the text', async () => {
    const handler = createWebExtractHandler({
      extractor: makeExtractor([lowConfidenceEvent]),
      children,
      thresholds: DEFAULT_THRESHOLDS,
    })
    const res = await appWith(handler).request('/api/extract', {
      method: 'POST',
      body: form({ text: '#長男 サッカーの練習' }),
    })
    const body = await readJson(res)
    // prefix forces attribution to child2 with confidence 1.0
    expect(body.events[0]!.attributedTo).toBe('child2')
    expect(body.events[0]!.attributionConfidence).toBe(1)
  })

  it('decodes an uploaded image to base64 and passes it to the extractor', async () => {
    let captured: { images: Array<{ base64: string; mimeType: string }> } | undefined
    const handler = createWebExtractHandler({
      extractor: makeExtractor([], {
        capture: (input) => {
          captured = input as typeof captured
        },
      }),
      children,
      thresholds: DEFAULT_THRESHOLDS,
    })
    const bytes = new Uint8Array([1, 2, 3, 4])
    const res = await appWith(handler).request('/api/extract', {
      method: 'POST',
      body: form({}, { name: 'photo.png', type: 'image/png', bytes }),
    })
    expect(res.status).toBe(200)
    expect(captured?.images).toHaveLength(1)
    expect(captured!.images[0]!.mimeType).toBe('image/png')
    expect(captured!.images[0]!.base64).toBe(Buffer.from(bytes).toString('base64'))
  })

  it('returns conflicts, toolCalls and mcpEnabled:true when an agent is provided', async () => {
    const review: ReviewResult = {
      conflicts: [
        {
          newEventTitle: '授業参観',
          conflictsWith: '通院',
          when: '2026-06-20T14:00:00+09:00',
          members: ['長女'],
        },
      ],
      toolCalls: [{ name: 'insert-many', args: { documents: [] }, result: { ok: true } }],
      summary: '1件の重複を検出しました。',
    }
    const handler = createWebExtractHandler({
      extractor: makeExtractor([highConfidenceEvent]),
      children,
      thresholds: DEFAULT_THRESHOLDS,
      agent: makeAgent(review),
    })
    const res = await appWith(handler).request('/api/extract', {
      method: 'POST',
      body: form({ text: '授業参観' }),
    })
    const body = await readJson(res)
    expect(body.mcpEnabled).toBe(true)
    expect(body.conflicts).toHaveLength(1)
    expect(body.toolCalls[0]!.name).toBe('insert-many')
    expect(body.summary).toContain('重複')
  })

  it('returns 400 for an empty body', async () => {
    const handler = createWebExtractHandler({
      extractor: makeExtractor([highConfidenceEvent]),
      children,
      thresholds: DEFAULT_THRESHOLDS,
    })
    const res = await appWith(handler).request('/api/extract', {
      method: 'POST',
      body: form({ text: '   ' }),
    })
    expect(res.status).toBe(400)
    const body = await readJson(res)
    expect(body.error).toBeTruthy()
  })

  it('returns 413 for an oversized text request (> 20KB)', async () => {
    const handler = createWebExtractHandler({
      extractor: makeExtractor([highConfidenceEvent]),
      children,
      thresholds: DEFAULT_THRESHOLDS,
    })
    const res = await appWith(handler).request('/api/extract', {
      method: 'POST',
      body: form({ text: 'あ'.repeat(20_001) }),
    })
    expect(res.status).toBe(413)
    const body = await readJson(res)
    expect(body.error).toBeTruthy()
  })

  it('writes auto-register events to the demo calendar and returns calendarLinks', async () => {
    const calendar = makeCalendar()
    const handler = createWebExtractHandler({
      extractor: makeExtractor([highConfidenceEvent, lowConfidenceEvent]),
      children,
      thresholds: DEFAULT_THRESHOLDS,
      calendar,
      demoCalendarId: 'demo@group.calendar.google.com',
    })
    const res = await appWith(handler).request('/api/extract', {
      method: 'POST',
      body: form({ text: '授業参観のお知らせ' }),
    })
    expect(res.status).toBe(200)
    const body = await readJson(res)
    expect(body.calendarWritten).toBe(true)
    // Only the auto-register event is written (the low-confidence 'ask' event is not).
    expect(calendar.insertEvent).toHaveBeenCalledTimes(1)
    const callArg = (calendar.insertEvent as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      calendarId: string
      eventId: string
      summary: string
    }
    expect(callArg.calendarId).toBe('demo@group.calendar.google.com')
    expect(callArg.eventId).toMatch(/^[a-v0-9]{5,}$/)
    expect(callArg.summary).toBe('授業参観（長女）')
    expect(body.calendarLinks).toHaveLength(1)
    expect(body.calendarLinks![0]!.title).toBe('授業参観')
    expect(body.calendarLinks![0]!.htmlLink).toContain('calendar.google.com')
  })

  it('preserves dry-run when calendar/demoCalendarId are not provided', async () => {
    const calendar = makeCalendar()
    const handler = createWebExtractHandler({
      extractor: makeExtractor([highConfidenceEvent]),
      children,
      thresholds: DEFAULT_THRESHOLDS,
      // no calendar / demoCalendarId
    })
    const res = await appWith(handler).request('/api/extract', {
      method: 'POST',
      body: form({ text: '授業参観' }),
    })
    const body = await readJson(res)
    expect(calendar.insertEvent).not.toHaveBeenCalled()
    expect(body.calendarWritten).toBe(false)
    expect(body.calendarLinks).toEqual([])
  })

  it('swallows calendar write failures and still returns 200 with events', async () => {
    const calendar = makeCalendar({ rejects: true })
    const handler = createWebExtractHandler({
      extractor: makeExtractor([highConfidenceEvent]),
      children,
      thresholds: DEFAULT_THRESHOLDS,
      calendar,
      demoCalendarId: 'demo@group.calendar.google.com',
    })
    const res = await appWith(handler).request('/api/extract', {
      method: 'POST',
      body: form({ text: '授業参観' }),
    })
    expect(res.status).toBe(200)
    const body = await readJson(res)
    expect(body.events).toHaveLength(1)
    expect(body.calendarWritten).toBe(true)
    // The failed insert produced no link.
    expect(body.calendarLinks).toEqual([])
  })

  it('does not write ask-route events to the demo calendar', async () => {
    const calendar = makeCalendar()
    const handler = createWebExtractHandler({
      extractor: makeExtractor([lowConfidenceEvent]),
      children,
      thresholds: DEFAULT_THRESHOLDS,
      calendar,
      demoCalendarId: 'demo@group.calendar.google.com',
    })
    const res = await appWith(handler).request('/api/extract', {
      method: 'POST',
      body: form({ text: '謎の予定' }),
    })
    const body = await readJson(res)
    expect(calendar.insertEvent).not.toHaveBeenCalled()
    expect(body.calendarWritten).toBe(true)
    expect(body.calendarLinks).toEqual([])
  })

  it('returns 200 with an error field when the extractor throws', async () => {
    const handler = createWebExtractHandler({
      extractor: makeExtractor([], { throws: true }),
      children,
      thresholds: DEFAULT_THRESHOLDS,
    })
    const res = await appWith(handler).request('/api/extract', {
      method: 'POST',
      body: form({ text: 'なにか' }),
    })
    expect(res.status).toBe(200)
    const body = await readJson(res)
    expect(body.error).toBe('Gemini exploded')
    expect(body.events).toEqual([])
  })
})
