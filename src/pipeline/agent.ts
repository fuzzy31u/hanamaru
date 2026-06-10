import type { GeminiClient, ToolDeclaration } from '~/adapters/gemini'
import type { MongoMcpClient } from '~/adapters/mcp-mongodb'
import type { ExtractedEvent } from '~/config/schema'
import { logger } from '~/lib/logger'
import type { LabelMap } from '~/pipeline/replier'

const DEFAULT_COLLECTION = 'events'
const MAX_STEPS = 10

/** MCP tools the schedule agent is allowed to use. */
const ALLOWED_TOOLS = new Set(['find', 'aggregate', 'count', 'insert-many'])

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
  gemini: GeminiClient
  mcp: MongoMcpClient
  dbName: string
  collectionName?: string
}

function buildSystemInstruction(dbName: string, collection: string): string {
  return [
    'You are a family-schedule agent for a Japanese household.',
    `You have MongoDB tools operating over database "${dbName}", collection "${collection}".`,
    '',
    'Your job, in order:',
    `1. Insert the provided NEW events into "${collection}" using the "insert-many" tool.`,
    '   For each document, set the original event fields plus: "source", "sourceId",',
    '   and a numeric "startMs" = epoch milliseconds derived from the event\'s startAt.',
    '2. Detect schedule conflicts: existing events for the family whose time window',
    '   overlaps any of the NEW events. Use "find" / "aggregate" / "count" to query',
    `   "${collection}". Compare by startMs / time ranges.`,
    '3. Return a FINAL ANSWER as STRICT JSON only (no markdown, no prose) of the form:',
    '   {"conflicts":[{"newEventTitle":string,"conflictsWith":string,"when":string,"members":string[]}],"summary":string}',
    '   - "when" is an ISO 8601 datetime (JST) of the overlap.',
    '   - "members" are the family member labels involved.',
    '   - If there are no conflicts, return {"conflicts":[],"summary":"..."}.',
  ].join('\n')
}

function buildUserContent(
  events: ExtractedEvent[],
  context: ReviewContext,
  dbName: string,
  collection: string,
): string {
  return [
    `Current datetime (JST): ${context.nowIso}`,
    `Database: ${dbName}`,
    `Collection: ${collection}`,
    `Source: ${context.source}`,
    `SourceId: ${context.sourceId ?? 'null'}`,
    `Family labels: ${JSON.stringify(context.familyLabels)}`,
    '',
    'NEW events to persist and check for conflicts:',
    JSON.stringify(events),
  ].join('\n')
}

/** Strips ```json / ``` fences and returns the inner text. */
function stripCodeFences(text: string): string {
  const trimmed = text.trim()
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  return fence?.[1]?.trim() ?? trimmed
}

function parseFinalAnswer(text: string): { conflicts: ConflictNote[]; summary: string } {
  const inner = stripCodeFences(text)
  let parsed: unknown
  try {
    parsed = JSON.parse(inner)
  } catch {
    logger.warn('agent.parseFailed', { rawText: text.slice(0, 500) })
    return { conflicts: [], summary: text }
  }

  const obj = (parsed ?? {}) as Record<string, unknown>
  const rawConflicts = Array.isArray(obj.conflicts) ? obj.conflicts : []
  const conflicts: ConflictNote[] = rawConflicts
    .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
    .map((c) => ({
      newEventTitle: String(c.newEventTitle ?? ''),
      conflictsWith: String(c.conflictsWith ?? ''),
      when: String(c.when ?? ''),
      members: Array.isArray(c.members) ? c.members.map((m) => String(m)) : [],
    }))
  const summary = typeof obj.summary === 'string' ? obj.summary : ''
  return { conflicts, summary }
}

/**
 * Schedule agent: persists extracted events into MongoDB (via the MCP server)
 * and detects family schedule conflicts, driven by Gemini tool-calling.
 *
 * It NEVER throws for an MCP/Gemini failure — it logs a warning and returns
 * empty conflicts so the calendar pipeline is never blocked.
 */
export function createScheduleAgent(deps: ScheduleAgentDeps): ScheduleAgent {
  const collection = deps.collectionName ?? DEFAULT_COLLECTION

  return {
    async reviewAndPersist(events, context) {
      try {
        const tools = await deps.mcp.listTools()
        const toolDecls: ToolDeclaration[] = tools
          .filter((t) => ALLOWED_TOOLS.has(t.name))
          .map((t) => ({
            name: t.name,
            description: t.description,
            parametersJsonSchema: t.inputSchema,
          }))

        const { text, toolCalls } = await deps.gemini.runWithTools({
          systemInstruction: buildSystemInstruction(deps.dbName, collection),
          contents: [
            {
              role: 'user',
              parts: [{ text: buildUserContent(events, context, deps.dbName, collection) }],
            },
          ],
          tools: toolDecls,
          dispatch: (name, args) => deps.mcp.callTool(name, args),
          maxSteps: MAX_STEPS,
        })

        const { conflicts, summary } = parseFinalAnswer(text)
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
        return { conflicts: [], toolCalls: [], summary: '' }
      }
    },
  }
}
