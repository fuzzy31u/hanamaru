import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GeminiClient, RunWithToolsArgs } from '~/adapters/gemini'
import type { McpToolInfo, MongoMcpClient } from '~/adapters/mcp-mongodb'
import type { ExtractedEvent } from '~/config/schema'
import { createScheduleAgent } from '~/pipeline/agent'
import type { LabelMap } from '~/pipeline/replier'

const labels: LabelMap = { child1: '長女', child2: '長男', child3: '末っ子', self: '自分' }

const sampleEvent: ExtractedEvent = {
  title: 'サッカー',
  startAt: '2026-06-10T09:00:00+09:00',
  endAt: '2026-06-10T11:00:00+09:00',
  allDay: false,
  location: 'グラウンド',
  description: null,
  attributedTo: 'child2',
  attributionConfidence: 0.95,
  datetimeConfidence: 0.95,
  rawExcerpt: 'サッカー練習',
}

const ALL_TOOLS: McpToolInfo[] = [
  { name: 'find', description: 'find docs', inputSchema: { type: 'object' } },
  { name: 'aggregate', description: 'aggregate', inputSchema: { type: 'object' } },
  { name: 'count', description: 'count', inputSchema: { type: 'object' } },
  { name: 'insert-many', description: 'insert many', inputSchema: { type: 'object' } },
  { name: 'list-collections', description: 'list collections', inputSchema: { type: 'object' } },
  { name: 'list-databases', description: 'list databases', inputSchema: { type: 'object' } },
]

function makeMcp(overrides: Partial<MongoMcpClient> = {}): MongoMcpClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue(ALL_TOOLS),
    callTool: vi.fn().mockResolvedValue({ ok: true }),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function makeGemini(runWithTools: GeminiClient['runWithTools']): GeminiClient {
  return {
    extract: vi.fn(),
    runWithTools,
  }
}

const context = {
  familyLabels: labels,
  nowIso: '2026-06-09T20:00:00+09:00',
  source: 'slack' as const,
  sourceId: 'evt-1',
}

describe('createScheduleAgent.reviewAndPersist', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('filters MCP tools to the relevant subset and passes them to runWithTools', async () => {
    let captured: RunWithToolsArgs | null = null
    const gemini = makeGemini(async (args) => {
      captured = args
      return { text: '{"conflicts":[],"summary":"ok"}', toolCalls: [] }
    })
    const mcp = makeMcp()
    const agent = createScheduleAgent({ gemini, mcp, dbName: 'hanamaru' })

    await agent.reviewAndPersist([sampleEvent], context)

    expect(mcp.listTools).toHaveBeenCalledOnce()
    expect(captured).not.toBeNull()
    const toolNames = captured!.tools.map((t) => t.name).sort()
    expect(toolNames).toEqual(['aggregate', 'count', 'find', 'insert-many'])
    // schema carried through as parametersJsonSchema
    expect(captured!.tools[0]).toHaveProperty('parametersJsonSchema')
    expect(captured!.maxSteps).toBe(10)
  })

  it('dispatch routes to mcp.callTool', async () => {
    const callTool = vi.fn().mockResolvedValue({ inserted: 1 })
    const mcp = makeMcp({ callTool })
    const gemini = makeGemini(async (args) => {
      const result = await args.dispatch('insert-many', { database: 'hanamaru' })
      expect(result).toEqual({ inserted: 1 })
      return { text: '{"conflicts":[],"summary":"done"}', toolCalls: [] }
    })
    const agent = createScheduleAgent({ gemini, mcp, dbName: 'hanamaru' })

    await agent.reviewAndPersist([sampleEvent], context)
    expect(callTool).toHaveBeenCalledWith('insert-many', { database: 'hanamaru' })
  })

  it('parses plain JSON final text into ConflictNote[]', async () => {
    const gemini = makeGemini(async () => ({
      text: JSON.stringify({
        conflicts: [
          {
            newEventTitle: 'サッカー',
            conflictsWith: 'ピアノ',
            when: '2026-06-10T09:00:00+09:00',
            members: ['長男'],
          },
        ],
        summary: '重複あり',
      }),
      toolCalls: [{ name: 'find', args: {}, result: [] }],
    }))
    const agent = createScheduleAgent({ gemini, mcp: makeMcp(), dbName: 'hanamaru' })

    const res = await agent.reviewAndPersist([sampleEvent], context)
    expect(res.conflicts).toHaveLength(1)
    expect(res.conflicts[0]).toMatchObject({ newEventTitle: 'サッカー', conflictsWith: 'ピアノ' })
    expect(res.summary).toBe('重複あり')
    expect(res.toolCalls).toHaveLength(1)
  })

  it('parses a ```json fenced final text', async () => {
    const fenced = ['```json', '{"conflicts":[],"summary":"問題なし"}', '```'].join('\n')
    const gemini = makeGemini(async () => ({ text: fenced, toolCalls: [] }))
    const agent = createScheduleAgent({ gemini, mcp: makeMcp(), dbName: 'hanamaru' })

    const res = await agent.reviewAndPersist([sampleEvent], context)
    expect(res.conflicts).toEqual([])
    expect(res.summary).toBe('問題なし')
  })

  it('returns empty conflicts (no throw) when runWithTools rejects', async () => {
    const gemini = makeGemini(async () => {
      throw new Error('gemini down')
    })
    const agent = createScheduleAgent({ gemini, mcp: makeMcp(), dbName: 'hanamaru' })

    const res = await agent.reviewAndPersist([sampleEvent], context)
    expect(res.conflicts).toEqual([])
    expect(res.toolCalls).toEqual([])
  })

  it('coerces malformed ConflictNote field types without throwing', async () => {
    const gemini = makeGemini(async () => ({
      text: '{"conflicts":[{"newEventTitle":42,"conflictsWith":null,"when":"bad","members":"child1"}],"summary":"ok"}',
      toolCalls: [],
    }))
    const agent = createScheduleAgent({ gemini, mcp: makeMcp(), dbName: 'hanamaru' })

    const res = await agent.reviewAndPersist([sampleEvent], context)
    expect(res.conflicts).toHaveLength(1)
    const c = res.conflicts[0]!
    expect(c.newEventTitle).toBe('42')
    // null -> String(null ?? '') -> ''
    expect(c.conflictsWith).toBe('')
    expect(c.when).toBe('bad')
    // non-array members are coerced to an empty array
    expect(Array.isArray(c.members)).toBe(true)
    expect(c.members).toEqual([])
    expect(res.summary).toBe('ok')
  })

  it('returns empty conflicts with raw text as summary on unparseable final text', async () => {
    const gemini = makeGemini(async () => ({ text: 'not json at all', toolCalls: [] }))
    const agent = createScheduleAgent({ gemini, mcp: makeMcp(), dbName: 'hanamaru' })

    const res = await agent.reviewAndPersist([sampleEvent], context)
    expect(res.conflicts).toEqual([])
    expect(res.summary).toBe('not json at all')
  })
})
