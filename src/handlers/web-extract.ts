import { randomBytes } from 'node:crypto'
import type { Context } from 'hono'
import type { CalendarClient } from '~/adapters/google-calendar'
import type { ChildrenMap } from '~/config/children'
import type { ChildId, ExtractedEvent, ExtractionInput } from '~/config/schema'
import type { Thresholds } from '~/config/thresholds'
import { logger } from '~/lib/logger'
import type { ScheduleAgent } from '~/pipeline/agent'
import { attributeEvents } from '~/pipeline/attributor'
import { type Route, decideRoute } from '~/pipeline/confidence'
import type { Extractor } from '~/pipeline/extractor'
import { parsePrefix } from '~/pipeline/prefix-parser'
import type { AttributionHintsStore } from '~/stores/attribution-hints'

export type WebExtractHandlerDeps = {
  extractor: Extractor
  children: ChildrenMap
  thresholds: Thresholds
  /** Optional MongoDB-MCP schedule agent. When set, the demo runs the agentic
   *  persist + conflict-detection step and returns its tool-call trace. */
  agent?: ScheduleAgent
  /** Optional attribution-hints store. When set, mirrors the orchestrator's
   *  hints lookup; otherwise attribution falls back to a no-op (always null). */
  hints?: AttributionHintsStore
  /** Optional Google Calendar client. When set together with `demoCalendarId`,
   *  the web demo WRITES auto-register events to the demo calendar instead of a
   *  pure dry-run. */
  calendar?: CalendarClient
  /** Demo calendar id to write auto-register events into. Only effective when
   *  `calendar` is also provided. */
  demoCalendarId?: string
}

/** Cheap input guards for the public /api/extract endpoint, which calls Gemini
 *  on arbitrary input. */
const MAX_TEXT_BYTES = 20_000
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_IMAGES = 3
const ALLOWED_MIME = /^image\/(jpeg|png|webp|gif|heic|heif)$/i

type WebEventView = {
  title: string
  startAt: string
  endAt: string | null
  allDay: boolean
  location: string | null
  description: string | null
  attributedTo: ChildId
  attributionConfidence: number
  datetimeConfidence: number
  route: Route
}

function familyLabels(children: ChildrenMap) {
  return {
    child1: children.child1.label,
    child2: children.child2.label,
    child3: children.child3.label,
    self: children.self.label,
  }
}

/**
 * English display labels for family members. Used per-request when the web demo
 * runs with `?lang=en` so conflict members come back in English, WITHOUT
 * touching the family's CHILD*_NAME Cloud Run env (which stays Japanese).
 */
const EN_FAMILY_LABELS = {
  child1: 'Daughter',
  child2: 'Son',
  child3: 'Youngest',
  self: 'Me',
} as const

/** Family label for an event title, e.g. 'child1'→'長女', 'unknown'→'不明'. */
function memberLabel(children: ChildrenMap, attributedTo: ChildId): string {
  if (attributedTo === 'unknown') return '不明'
  return children[attributedTo].label
}

/** Google Calendar event IDs must match [a-v0-9]{5,1024}; hex (0-9a-f) qualifies. */
function randomEventId(): string {
  return randomBytes(16).toString('hex')
}

/**
 * Headless extract handler for the web demo (POST /api/extract).
 *
 * This is a DRY-RUN surface: it runs Gemini extraction → attribution → routing,
 * optionally runs the MongoDB-MCP schedule agent, and returns the analysis as
 * JSON. It NEVER writes to Google Calendar and NEVER touches Firestore
 * idempotency / pending state.
 */
export function createWebExtractHandler(deps: WebExtractHandlerDeps) {
  return async function handleWebExtract(c: Context): Promise<Response> {
    // Parse multipart/form-data: a `text` field + zero-or-more `images` file parts.
    let text = ''
    let lang = ''
    const images: ExtractionInput['images'] = []
    const imageParts: File[] = []
    try {
      const body = await c.req.parseBody({ all: true })
      const rawText = body.text
      if (typeof rawText === 'string') text = rawText
      const rawLang = body.lang
      if (typeof rawLang === 'string') lang = rawLang

      const rawImages = body.images
      const fileParts: unknown[] = Array.isArray(rawImages)
        ? rawImages
        : rawImages !== undefined
          ? [rawImages]
          : []
      for (const part of fileParts) {
        if (part instanceof File) {
          imageParts.push(part)
        }
      }
    } catch (err) {
      logger.warn('webExtract.parseBodyFailed', { err: String(err) })
      return c.json({ error: 'リクエストの解析に失敗しました。' }, 400)
    }

    if (text.trim() === '' && imageParts.length === 0) {
      return c.json({ error: 'テキストまたは画像のいずれかが必要です。' }, 400)
    }

    if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
      return c.json({ error: 'テキストが長すぎます（上限 20KB）。' }, 413)
    }

    if (imageParts.length > MAX_IMAGES) {
      return c.json({ error: `画像は最大 ${MAX_IMAGES} 枚までです。` }, 400)
    }

    for (const part of imageParts) {
      if (!ALLOWED_MIME.test(part.type)) {
        return c.json({ error: '画像は JPEG/PNG/WebP/GIF のみ対応しています。' }, 400)
      }
      if (part.size > MAX_IMAGE_BYTES) {
        return c.json({ error: '画像が大きすぎます（1 枚あたり上限 5MB）。' }, 413)
      }
    }

    for (const part of imageParts) {
      const bytes = new Uint8Array(await part.arrayBuffer())
      images.push({
        base64: Buffer.from(bytes).toString('base64'),
        mimeType: part.type,
      })
    }

    const { prefixHint, modeHint, remainingText } = parsePrefix(text)

    const input: ExtractionInput = {
      postedAt: new Date().toISOString(),
      authorUserId: 'web',
      channelId: 'web',
      threadTs: 'web',
      text: remainingText,
      prefixHint,
      modeHint,
      images,
    }

    const mcpEnabled = Boolean(deps.agent)

    try {
      const { events: rawEvents } = await deps.extractor.extract(input)

      // Mirror the orchestrator's hints lookup; no-op (null) when no store provided.
      const allHints = deps.hints ? await deps.hints.listAll() : []
      const hintsLookup = (rawExcerpt: string): Exclude<ChildId, 'unknown'> | null => {
        if (allHints.length === 0) return null
        const normalized = rawExcerpt.normalize('NFKC')
        for (const h of allHints) {
          if (normalized.includes(h.key)) return h.childId
        }
        return null
      }

      const attributed = attributeEvents(rawEvents, { prefixHint, hintsLookup })

      const events: WebEventView[] = attributed.map((e: ExtractedEvent) => ({
        title: e.title,
        startAt: e.startAt,
        endAt: e.endAt,
        allDay: e.allDay,
        location: e.location,
        description: e.description,
        attributedTo: e.attributedTo,
        attributionConfidence: e.attributionConfidence,
        datetimeConfidence: e.datetimeConfidence,
        route: decideRoute(e, { modeHint, thresholds: deps.thresholds }),
      }))

      // Live demo calendar: when configured, WRITE every auto-register event to a
      // single shared Google Calendar so the embedded view reflects the result.
      // Failures are non-fatal — the extraction + MCP analysis still return.
      const calendarWritten = Boolean(deps.calendar && deps.demoCalendarId)
      const calendarLinks: Array<{ title: string; htmlLink: string }> = []
      if (deps.calendar && deps.demoCalendarId) {
        const cal = deps.calendar
        const calendarId = deps.demoCalendarId
        for (let i = 0; i < attributed.length; i++) {
          const e = attributed[i]
          if (!e || events[i]?.route !== 'auto-register') continue
          try {
            const inserted = await cal.insertEvent({
              calendarId,
              eventId: randomEventId(),
              summary: `${e.title}（${memberLabel(deps.children, e.attributedTo)}）`,
              description: e.description,
              location: e.location,
              startAt: e.startAt,
              endAt: e.endAt,
              allDay: e.allDay,
            })
            calendarLinks.push({ title: e.title, htmlLink: inserted.htmlLink })
          } catch (err) {
            logger.warn('webExtract.calendarWriteFailed', {
              title: e.title,
              reason: err instanceof Error ? err.message : String(err),
            })
          }
        }
      }

      let conflicts: Awaited<ReturnType<ScheduleAgent['reviewAndPersist']>>['conflicts'] = []
      let toolCalls: Awaited<ReturnType<ScheduleAgent['reviewAndPersist']>>['toolCalls'] = []
      let summary = ''

      if (deps.agent) {
        const labels = lang === 'en' ? EN_FAMILY_LABELS : familyLabels(deps.children)
        const review = await deps.agent.reviewAndPersist(attributed, {
          familyLabels: labels,
          nowIso: input.postedAt,
          source: 'web',
          sourceId: null,
        })
        conflicts = review.conflicts
        toolCalls = review.toolCalls
        summary = review.summary
      }

      return c.json({
        mcpEnabled,
        events,
        conflicts,
        toolCalls,
        summary,
        calendarWritten,
        calendarLinks,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('webExtract.failed', { reason: message })
      // Return 200 with an error field so the UI can display it gracefully.
      return c.json({
        mcpEnabled,
        error: message,
        events: [],
        conflicts: [],
        toolCalls: [],
        calendarWritten: false,
        calendarLinks: [],
      })
    }
  }
}
