import type { Context } from 'hono'
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
}

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
    const images: ExtractionInput['images'] = []
    try {
      const body = await c.req.parseBody({ all: true })
      const rawText = body.text
      if (typeof rawText === 'string') text = rawText

      const rawImages = body.images
      const fileParts: unknown[] = Array.isArray(rawImages)
        ? rawImages
        : rawImages !== undefined
          ? [rawImages]
          : []
      for (const part of fileParts) {
        if (part instanceof File) {
          const bytes = new Uint8Array(await part.arrayBuffer())
          images.push({
            base64: Buffer.from(bytes).toString('base64'),
            mimeType: part.type || 'application/octet-stream',
          })
        }
      }
    } catch (err) {
      logger.warn('webExtract.parseBodyFailed', { err: String(err) })
      return c.json({ error: 'リクエストの解析に失敗しました。' }, 400)
    }

    if (text.trim() === '' && images.length === 0) {
      return c.json({ error: 'テキストまたは画像のいずれかが必要です。' }, 400)
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

      let conflicts: Awaited<ReturnType<ScheduleAgent['reviewAndPersist']>>['conflicts'] = []
      let toolCalls: Awaited<ReturnType<ScheduleAgent['reviewAndPersist']>>['toolCalls'] = []
      let summary = ''

      if (deps.agent) {
        const review = await deps.agent.reviewAndPersist(attributed, {
          familyLabels: familyLabels(deps.children),
          nowIso: input.postedAt,
          source: 'web',
          sourceId: null,
        })
        conflicts = review.conflicts
        toolCalls = review.toolCalls
        summary = review.summary
      }

      return c.json({ mcpEnabled, events, conflicts, toolCalls, summary })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logger.error('webExtract.failed', { reason: message })
      // Return 200 with an error field so the UI can display it gracefully.
      return c.json({ mcpEnabled, error: message, events: [], conflicts: [], toolCalls: [] })
    }
  }
}
