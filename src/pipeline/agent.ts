import type { GeminiClient } from '~/adapters/gemini'
import type { MongoMcpClient } from '~/adapters/mcp-mongodb'
import type { ExtractedEvent } from '~/config/schema'
import { logger } from '~/lib/logger'
import type { LabelMap } from '~/pipeline/replier'

const DEFAULT_COLLECTION = 'events'

/** Default event duration (1h) when an event has no explicit endAt. */
const DEFAULT_DURATION_MS = 60 * 60 * 1000

/** A single detected schedule conflict between a new event and an existing one. */
export type ConflictNote = {
  newEventTitle: string
  conflictsWith: string
  when: string
  members: string[]
}

/** Trace of a single MCP tool call executed during the agent run. */
export type ToolCallTrace = {
  name: string
  args: Record<string, unknown>
  result: unknown
}

export type ReviewContext = {
  familyLabels: LabelMap
  nowIso: string
  source: 'slack' | 'web'
  sourceId: string | null
}

export type ReviewResult = {
  conflicts: ConflictNote[]
  toolCalls: ToolCallTrace[]
  summary: string
}

export type ScheduleAgent = {
  reviewAndPersist(events: ExtractedEvent[], context: ReviewContext): Promise<ReviewResult>
}

export type ScheduleAgentDeps = {
  /**
   * Kept on the deps for a stable factory signature (server.ts / web-extract.ts
   * construct the agent with it) and forward-compatibility. `reviewAndPersist`
   * is now fully deterministic and does NOT call the LLM, so this is currently
   * unused inside the agent.
   */
  gemini: GeminiClient
  mcp: MongoMcpClient
  dbName: string
  collectionName?: string
}

/** A matched existing document as parsed from an MCP `find` result. */
type FoundDoc = { title?: string; attributedTo?: string; startAt?: string }

/** Computed epoch-ms time bounds for a new event. */
type EventBounds = { startMs: number; endMs: number }

/**
 * Computes [startMs, endMs) for an event in TypeScript — NEVER via the LLM.
 * Mirrors `src/stores/events-mongo.ts`: endMs defaults to startMs + 1h when the
 * event has no explicit endAt.
 */
function computeBounds(event: ExtractedEvent): EventBounds {
  const startMs = Date.parse(event.startAt)
  const endMs = event.endAt ? Date.parse(event.endAt) : startMs + DEFAULT_DURATION_MS
  return { startMs, endMs }
}

/**
 * Robustly parses the documents out of an MCP `find` result.
 *
 * The MongoDB MCP server returns one of these shapes (verified against the live
 * Atlas cluster), all of which this tolerates:
 *  - Structured content: an array of docs, or a single doc object → used directly.
 *  - Content blocks: an array of `{ type: 'text', text }`. The matched documents
 *    are embedded as a JSON array inside one of the text blocks, wrapped by a
 *    security-warning preamble and `<untrusted-user-data-…>` tags (NOT the whole
 *    block). An empty result is a single text block:
 *    `Query on collection "events" resulted in 0 documents...` with no JSON.
 *
 * Returns [] for empty / unparseable results rather than throwing.
 */
export function parseFindResult(raw: unknown): FoundDoc[] {
  if (raw == null) return []

  // Structured content: already-parsed array of docs.
  if (Array.isArray(raw) && !looksLikeContentBlocks(raw)) {
    return raw.filter(isDocLike).map(toFoundDoc)
  }

  // Structured content: a single doc object.
  if (!Array.isArray(raw) && typeof raw === 'object' && isDocLike(raw)) {
    return [toFoundDoc(raw)]
  }

  // Content blocks: array of { type: 'text', text }. Scan each block's text for
  // an embedded JSON array/object of documents.
  if (Array.isArray(raw)) {
    const docs: FoundDoc[] = []
    for (const block of raw) {
      const text = blockText(block)
      if (!text) continue
      docs.push(...extractDocsFromText(text))
    }
    return docs
  }

  return []
}

/** True when value is an array of MCP content blocks ({ type, text? }). */
function looksLikeContentBlocks(value: unknown[]): boolean {
  return (
    value.length > 0 &&
    value.every(
      (b) =>
        typeof b === 'object' && b !== null && typeof (b as { type?: unknown }).type === 'string',
    )
  )
}

function blockText(block: unknown): string | null {
  if (typeof block === 'object' && block !== null) {
    const t = (block as { text?: unknown }).text
    if (typeof t === 'string') return t
  }
  return null
}

/**
 * Extracts document objects from a text block. The block may be:
 *  - The 0-document summary text (no JSON) → [].
 *  - Prose wrapping a JSON array `[ {...}, ... ]` of docs → parsed array.
 *  - Prose wrapping a single JSON object `{ ... }` → parsed single doc.
 * Finds the JSON by locating the first balanced array/object substring.
 */
function extractDocsFromText(text: string): FoundDoc[] {
  const json = sliceFirstJson(text)
  if (!json) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  if (Array.isArray(parsed)) return parsed.filter(isDocLike).map(toFoundDoc)
  if (isDocLike(parsed)) return [toFoundDoc(parsed)]
  return []
}

/**
 * Returns the first balanced `[...]` or `{...}` JSON substring in `text`, or
 * null if none is found. Tracks string literals/escapes so braces inside string
 * values do not break balancing.
 */
function sliceFirstJson(text: string): string | null {
  const start = firstJsonStart(text)
  if (start === -1) return null
  const open = text[start]
  const close = open === '[' ? ']' : '}'
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

function firstJsonStart(text: string): number {
  const arr = text.indexOf('[')
  const obj = text.indexOf('{')
  if (arr === -1) return obj
  if (obj === -1) return arr
  return Math.min(arr, obj)
}

function isDocLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toFoundDoc(value: Record<string, unknown>): FoundDoc {
  return {
    title: typeof value.title === 'string' ? value.title : undefined,
    attributedTo: typeof value.attributedTo === 'string' ? value.attributedTo : undefined,
    startAt: typeof value.startAt === 'string' ? value.startAt : undefined,
  }
}

/** Resolves a family member label for display; tolerates unknown/missing ids. */
function labelFor(id: string | undefined, labels: LabelMap): string {
  if (!id) return '不明'
  if (id === 'unknown') return '誰の予定か不明'
  const label = (labels as Record<string, string | undefined>)[id]
  return label ?? id
}

/**
 * Schedule agent: persists extracted events into MongoDB (via the MCP server)
 * and detects family schedule conflicts.
 *
 * Persistence and conflict detection are FULLY DETERMINISTIC — all epoch-ms
 * arithmetic and the overlap query filter are computed in TypeScript here, never
 * by the LLM (which previously produced inconsistent `startMs` values). MongoDB
 * is still driven through the MCP server (`find` + `insert-many`).
 *
 * It NEVER throws for an MCP failure — it logs a warning and returns whatever it
 * collected so the calendar pipeline is never blocked.
 */
export function createScheduleAgent(deps: ScheduleAgentDeps): ScheduleAgent {
  const collection = deps.collectionName ?? DEFAULT_COLLECTION
  const database = deps.dbName

  return {
    async reviewAndPersist(events, context) {
      const toolCalls: ToolCallTrace[] = []
      const conflicts: ConflictNote[] = []

      try {
        if (events.length === 0) {
          return { conflicts: [], toolCalls, summary: '重複なし。' }
        }

        // 1+2. Detect conflicts BEFORE inserting (so a new event never matches
        // itself). Query per new non-all-day event with a CODE-BUILT overlap
        // filter that mirrors src/stores/events-mongo.ts half-open semantics:
        // existing.startMs < newEndMs && existing.endMs > newStartMs.
        for (const event of events) {
          if (event.allDay) continue
          const { startMs, endMs } = computeBounds(event)
          const args = {
            database,
            collection,
            filter: {
              allDay: false,
              startMs: { $lt: endMs },
              endMs: { $gt: startMs },
            },
            projection: { title: 1, attributedTo: 1, startAt: 1, endAt: 1 },
          }
          let raw: unknown
          try {
            raw = await deps.mcp.callTool('find', args)
          } catch (err) {
            logger.warn('agent.findFailed', {
              title: event.title,
              error: err instanceof Error ? err.message : String(err),
            })
            continue
          }
          toolCalls.push({ name: 'find', args, result: raw })

          for (const doc of parseFindResult(raw)) {
            conflicts.push({
              newEventTitle: event.title,
              conflictsWith: doc.title ?? '(不明な予定)',
              when: doc.startAt ?? event.startAt,
              members: [
                labelFor(event.attributedTo, context.familyLabels),
                labelFor(doc.attributedTo, context.familyLabels),
              ],
            })
          }
        }

        // 3. Persist via insert-many with CORRECT precomputed numeric bounds.
        const createdAt = new Date().toISOString()
        const documents = events.map((event) => {
          const { startMs, endMs } = computeBounds(event)
          return {
            ...event,
            source: context.source,
            sourceId: context.sourceId,
            startMs,
            endMs,
            createdAt,
          }
        })
        const insertArgs = { database, collection, documents }
        try {
          const insertResult = await deps.mcp.callTool('insert-many', insertArgs)
          toolCalls.push({ name: 'insert-many', args: insertArgs, result: insertResult })
        } catch (err) {
          logger.warn('agent.insertFailed', {
            error: err instanceof Error ? err.message : String(err),
          })
        }

        // 5. Deterministic summary.
        const summary =
          conflicts.length > 0
            ? `${events.length} 件を追加。${conflicts.length} 件の重複を検出。`
            : `${events.length} 件を追加。重複なし。`

        logger.info('agent.reviewed', {
          eventCount: events.length,
          conflicts: conflicts.length,
          toolCalls: toolCalls.length,
        })
        return { conflicts, toolCalls, summary }
      } catch (err) {
        logger.warn('agent.reviewFailed', {
          error: err instanceof Error ? err.message : String(err),
        })
        return { conflicts, toolCalls, summary: '' }
      }
    },
  }
}
