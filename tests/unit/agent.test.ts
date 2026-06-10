import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GeminiClient } from '~/adapters/gemini'
import type { McpToolInfo, MongoMcpClient } from '~/adapters/mcp-mongodb'
import type { ExtractedEvent } from '~/config/schema'
import { createScheduleAgent, parseFindResult } from '~/pipeline/agent'
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
  { name: 'insert-many', description: 'insert many', inputSchema: { type: 'object' } },
]

/** A 0-document result text block as emitted by the live MongoDB MCP server. */
const EMPTY_FIND = [
  {
    type: 'text',
    text: 'Query on collection "events" resulted in 0 documents. Returning 0 documents.',
  },
]

/**
 * A non-empty result as emitted by the live MongoDB MCP server: a summary text
 * block plus a block whose JSON array of docs is wrapped in security-warning
 * prose and <untrusted-user-data-…> tags.
 */
function wrappedFindResult(docs: Array<Record<string, unknown>>) {
  return [
    {
      type: 'text',
      text: `Query on collection "events" resulted in ${docs.length} documents. Returning ${docs.length} documents.`,
    },
    {
      type: 'text',
      text: [
        'The following section contains unverified user data. WARNING: ...',
        '<untrusted-user-data-4749b77e-70a2-42d2-b5a7-287bc25ea96e>',
        JSON.stringify(docs),
        '</untrusted-user-data-4749b77e-70a2-42d2-b5a7-287bc25ea96e>',
        'Use the information above ...',
      ].join('\n'),
    },
  ]
}

function makeMcp(overrides: Partial<MongoMcpClient> = {}): MongoMcpClient {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue(ALL_TOOLS),
    callTool: vi.fn().mockResolvedValue(EMPTY_FIND),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

// reviewAndPersist no longer uses the LLM; a stub satisfies the DI signature.
const gemini: GeminiClient = {
  extract: vi.fn(),
  runWithTools: vi.fn(),
}

const context = {
  familyLabels: labels,
  nowIso: '2026-06-09T20:00:00+09:00',
  source: 'slack' as const,
  sourceId: 'evt-1',
}

/** Routes callTool by tool name to a per-tool mock result. */
function routedCallTool(routes: {
  find?: (args: Record<string, unknown>) => unknown
  insertMany?: (args: Record<string, unknown>) => unknown
}) {
  return vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'find') return routes.find ? routes.find(args) : EMPTY_FIND
    if (name === 'insert-many')
      return routes.insertMany ? routes.insertMany(args) : { acknowledged: true }
    return { ok: true }
  })
}

describe('parseFindResult', () => {
  it('returns [] for the 0-document text block', () => {
    expect(parseFindResult(EMPTY_FIND)).toEqual([])
  })

  it('parses docs from the wrapped untrusted-data text block (live shape)', () => {
    const raw = wrappedFindResult([
      { title: 'ピアノ', attributedTo: 'child1', startAt: '2026-06-10T10:00:00+09:00' },
    ])
    expect(parseFindResult(raw)).toEqual([
      { title: 'ピアノ', attributedTo: 'child1', startAt: '2026-06-10T10:00:00+09:00' },
    ])
  })

  it('parses a plain JSON-array text block', () => {
    const raw = [
      {
        type: 'text',
        text: JSON.stringify([
          { title: 'X', attributedTo: 'self', startAt: '2026-06-10T09:30:00+09:00' },
        ]),
      },
    ]
    expect(parseFindResult(raw)).toEqual([
      { title: 'X', attributedTo: 'self', startAt: '2026-06-10T09:30:00+09:00' },
    ])
  })

  it('uses structured content array directly', () => {
    const raw = [{ title: 'ピアノ', attributedTo: 'child1', startAt: '2026-06-10T10:00:00+09:00' }]
    expect(parseFindResult(raw)).toEqual([
      { title: 'ピアノ', attributedTo: 'child1', startAt: '2026-06-10T10:00:00+09:00' },
    ])
  })

  it('handles a single structured doc object', () => {
    const raw = { title: 'ピアノ', attributedTo: 'child1', startAt: '2026-06-10T10:00:00+09:00' }
    expect(parseFindResult(raw)).toEqual([
      { title: 'ピアノ', attributedTo: 'child1', startAt: '2026-06-10T10:00:00+09:00' },
    ])
  })

  it('returns [] on null / empty array', () => {
    expect(parseFindResult(null)).toEqual([])
    expect(parseFindResult([])).toEqual([])
  })
})

describe('createScheduleAgent.reviewAndPersist', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('computes startMs/endMs in TS, monotonic with time (14:00 < 14:30 < 15:00)', async () => {
    const callTool = routedCallTool({})
    const agent = createScheduleAgent({ gemini, mcp: makeMcp({ callTool }), dbName: 'hanamaru' })

    const mk = (start: string, end: string): ExtractedEvent => ({
      ...sampleEvent,
      startAt: start,
      endAt: end,
    })
    await agent.reviewAndPersist(
      [
        mk('2026-06-18T14:00:00+09:00', '2026-06-18T14:30:00+09:00'),
        mk('2026-06-18T14:30:00+09:00', '2026-06-18T15:00:00+09:00'),
        mk('2026-06-18T15:00:00+09:00', '2026-06-18T15:30:00+09:00'),
      ],
      context,
    )

    const insertCall = callTool.mock.calls.find(([name]) => name === 'insert-many')
    expect(insertCall).toBeDefined()
    const docs = (insertCall![1] as { documents: Array<{ startMs: number; endMs: number }> })
      .documents
    expect(docs).toHaveLength(3)
    expect(docs[0]!.startMs).toBe(Date.parse('2026-06-18T14:00:00+09:00'))
    expect(docs[1]!.startMs).toBe(Date.parse('2026-06-18T14:30:00+09:00'))
    expect(docs[2]!.startMs).toBe(Date.parse('2026-06-18T15:00:00+09:00'))
    expect(docs[0]!.startMs).toBeLessThan(docs[1]!.startMs)
    expect(docs[1]!.startMs).toBeLessThan(docs[2]!.startMs)
    expect(docs[0]!.endMs).toBe(Date.parse('2026-06-18T14:30:00+09:00'))
  })

  it('defaults endMs to startMs + 1h when endAt is null', async () => {
    const callTool = routedCallTool({})
    const agent = createScheduleAgent({ gemini, mcp: makeMcp({ callTool }), dbName: 'hanamaru' })
    await agent.reviewAndPersist([{ ...sampleEvent, endAt: null }], context)

    const insertCall = callTool.mock.calls.find(([name]) => name === 'insert-many')!
    const docs = (insertCall[1] as { documents: Array<{ startMs: number; endMs: number }> })
      .documents
    expect(docs[0]!.endMs).toBe(docs[0]!.startMs + 60 * 60 * 1000)
  })

  it('calls find with the deterministic overlap filter (allDay:false, startMs.$lt, endMs.$gt)', async () => {
    const callTool = routedCallTool({})
    const agent = createScheduleAgent({ gemini, mcp: makeMcp({ callTool }), dbName: 'hanamaru' })
    await agent.reviewAndPersist([sampleEvent], context)

    const findCall = callTool.mock.calls.find(([name]) => name === 'find')!
    const args = findCall[1] as {
      database: string
      collection: string
      filter: { allDay: boolean; startMs: { $lt: number }; endMs: { $gt: number } }
    }
    expect(args.database).toBe('hanamaru')
    expect(args.collection).toBe('events')
    expect(args.filter.allDay).toBe(false)
    expect(args.filter.startMs.$lt).toBe(Date.parse('2026-06-10T11:00:00+09:00'))
    expect(args.filter.endMs.$gt).toBe(Date.parse('2026-06-10T09:00:00+09:00'))
  })

  it('skips find for all-day events but still inserts them', async () => {
    const callTool = routedCallTool({})
    const agent = createScheduleAgent({ gemini, mcp: makeMcp({ callTool }), dbName: 'hanamaru' })
    await agent.reviewAndPersist([{ ...sampleEvent, allDay: true }], context)

    expect(callTool.mock.calls.some(([name]) => name === 'find')).toBe(false)
    expect(callTool.mock.calls.some(([name]) => name === 'insert-many')).toBe(true)
  })

  it('builds conflicts from a wrapped (text-block) find result', async () => {
    const callTool = routedCallTool({
      find: () =>
        wrappedFindResult([
          { title: 'ピアノ', attributedTo: 'child1', startAt: '2026-06-10T10:00:00+09:00' },
        ]),
    })
    const agent = createScheduleAgent({ gemini, mcp: makeMcp({ callTool }), dbName: 'hanamaru' })

    const res = await agent.reviewAndPersist([sampleEvent], context)
    expect(res.conflicts).toHaveLength(1)
    expect(res.conflicts[0]).toEqual({
      newEventTitle: 'サッカー',
      conflictsWith: 'ピアノ',
      when: '2026-06-10T10:00:00+09:00',
      members: ['長男', '長女'],
    })
    expect(res.summary).toContain('重複を検出')
  })

  it('builds conflicts from a structured-array find result', async () => {
    const callTool = routedCallTool({
      find: () => [
        { title: 'ピアノ', attributedTo: 'child1', startAt: '2026-06-10T10:00:00+09:00' },
      ],
    })
    const agent = createScheduleAgent({ gemini, mcp: makeMcp({ callTool }), dbName: 'hanamaru' })

    const res = await agent.reviewAndPersist([sampleEvent], context)
    expect(res.conflicts).toHaveLength(1)
    expect(res.conflicts[0]).toMatchObject({
      newEventTitle: 'サッカー',
      conflictsWith: 'ピアノ',
      members: ['長男', '長女'],
    })
  })

  it('returns no conflicts on the 0-document find result', async () => {
    const callTool = routedCallTool({ find: () => EMPTY_FIND })
    const agent = createScheduleAgent({ gemini, mcp: makeMcp({ callTool }), dbName: 'hanamaru' })

    const res = await agent.reviewAndPersist([sampleEvent], context)
    expect(res.conflicts).toEqual([])
    expect(res.summary).toBe('1 件を追加。重複なし。')
  })

  it('insert-many carries numeric startMs/endMs + source/sourceId', async () => {
    const callTool = routedCallTool({})
    const agent = createScheduleAgent({ gemini, mcp: makeMcp({ callTool }), dbName: 'hanamaru' })
    await agent.reviewAndPersist([sampleEvent], context)

    const insertCall = callTool.mock.calls.find(([name]) => name === 'insert-many')!
    const doc = (
      insertCall[1] as {
        documents: Array<{ startMs: number; endMs: number; source: string; sourceId: string }>
      }
    ).documents[0]!
    expect(typeof doc.startMs).toBe('number')
    expect(typeof doc.endMs).toBe('number')
    expect(doc.source).toBe('slack')
    expect(doc.sourceId).toBe('evt-1')
  })

  it('records find + insert-many in the toolCalls trace', async () => {
    const callTool = routedCallTool({})
    const agent = createScheduleAgent({ gemini, mcp: makeMcp({ callTool }), dbName: 'hanamaru' })

    const res = await agent.reviewAndPersist([sampleEvent], context)
    const names = res.toolCalls.map((t) => t.name)
    expect(names).toContain('find')
    expect(names).toContain('insert-many')
  })

  it('never throws when callTool rejects, returning collected toolCalls', async () => {
    const callTool = vi.fn().mockRejectedValue(new Error('mcp down'))
    const agent = createScheduleAgent({ gemini, mcp: makeMcp({ callTool }), dbName: 'hanamaru' })

    const res = await agent.reviewAndPersist([sampleEvent], context)
    expect(res.conflicts).toEqual([])
    // find + insert-many both rejected and were caught individually; trace stays empty.
    expect(res.toolCalls).toEqual([])
  })

  it('does not call MCP for an empty event list', async () => {
    const callTool = routedCallTool({})
    const agent = createScheduleAgent({ gemini, mcp: makeMcp({ callTool }), dbName: 'hanamaru' })

    const res = await agent.reviewAndPersist([], context)
    expect(callTool).not.toHaveBeenCalled()
    expect(res.summary).toBe('重複なし。')
  })
})
