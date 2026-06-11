import { describe, expect, it } from 'vitest'
import type { GeminiClient } from '~/adapters/gemini'
import { createMongoMcpClient } from '~/adapters/mcp-mongodb'
import type { ExtractedEvent } from '~/config/schema'
import { createScheduleAgent } from '~/pipeline/agent'
import type { LabelMap } from '~/pipeline/replier'

const connStr = process.env.MDB_MCP_CONNECTION_STRING

const labels: LabelMap = { child1: '長女', child2: '長男', child3: '末っ子', self: '自分' }

// reviewAndPersist is deterministic and never calls the LLM; a stub suffices.
const gemini: GeminiClient = {
  extract: (() => {
    throw new Error('not used')
  }) as unknown as GeminiClient['extract'],
  runWithTools: (() => {
    throw new Error('not used')
  }) as unknown as GeminiClient['runWithTools'],
}

/**
 * Live Atlas validation of the deterministic schedule agent. Skipped unless
 * MDB_MCP_CONNECTION_STRING is set. Uses a throwaway collection so it never
 * touches the real `events` collection, and cleans up after itself.
 *
 * Confirms the `parseFindResult` shape handling matches what the live MongoDB
 * MCP server emits (text blocks wrapping the matched docs in untrusted-data
 * tags) and that deterministic overlap detection actually fires.
 */
describe('schedule agent against live Atlas', () => {
  it.skipIf(!connStr)(
    'inserts events and detects an overlapping conflict via MCP find',
    async () => {
      const mcp = createMongoMcpClient({ connectionString: connStr as string })
      const dbName = 'hanamaru'
      const collectionName = `events_agent_it_${Date.now()}`
      await mcp.connect()

      const base: ExtractedEvent = {
        title: '既存ピアノ',
        startAt: '2026-06-18T14:00:00+09:00',
        endAt: '2026-06-18T15:00:00+09:00',
        allDay: false,
        location: null,
        description: null,
        attributedTo: 'child1',
        attributionConfidence: 0.9,
        datetimeConfidence: 0.9,
        rawExcerpt: 'ピアノ',
      }

      try {
        const agent = createScheduleAgent({ gemini, mcp, dbName, collectionName })

        // First insert: no existing docs → no conflicts.
        const first = await agent.reviewAndPersist([base], {
          familyLabels: labels,
          nowIso: '2026-06-17T20:00:00+09:00',
          source: 'web',
          sourceId: 'it-1',
        })
        expect(first.conflicts).toEqual([])
        expect(first.toolCalls.some((t) => t.name === 'insert-many')).toBe(true)

        // Second insert overlaps 14:30–15:30 with the existing 14:00–15:00.
        const overlap: ExtractedEvent = {
          ...base,
          title: 'サッカー',
          startAt: '2026-06-18T14:30:00+09:00',
          endAt: '2026-06-18T15:30:00+09:00',
          attributedTo: 'child2',
        }
        const second = await agent.reviewAndPersist([overlap], {
          familyLabels: labels,
          nowIso: '2026-06-17T20:00:00+09:00',
          source: 'web',
          sourceId: 'it-2',
        })
        expect(second.conflicts.length).toBeGreaterThanOrEqual(1)
        const c = second.conflicts[0]!
        expect(c.newEventTitle).toBe('サッカー')
        expect(c.conflictsWith).toBe('既存ピアノ')
        expect(c.members).toContain('長男')
        expect(c.members).toContain('長女')
      } finally {
        await mcp
          .callTool('drop-collection', { database: dbName, collection: collectionName })
          .catch(() => {})
        await mcp.close()
      }
    },
    60_000,
  )
})
