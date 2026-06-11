import { Firestore } from '@google-cloud/firestore'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChildrenMap } from '~/config/children'
import type { ExtractedEvent } from '~/config/schema'
import type { WriteResult } from '~/pipeline/calendar-writer'
import { createOrchestrator } from '~/pipeline/orchestrator'
import { createAttributionHintsStore } from '~/stores/attribution-hints'
import { createIdempotencyStore } from '~/stores/idempotency'
import { createPendingStore } from '~/stores/pending'

let firestore: Firestore

beforeAll(() => {
  process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8085'
  firestore = new Firestore({ projectId: 'hanamaru-test' })
})

const children: ChildrenMap = {
  child1: { label: '長女', calendarId: 'cal1', aliases: [], contexts: [] },
  child2: { label: '長男', calendarId: 'cal2', aliases: [], contexts: [] },
  child3: { label: '末っ子', calendarId: 'cal3', aliases: [], contexts: [] },
  self: { label: '自分', calendarId: 'self', aliases: [], contexts: [] },
}

const highConfidenceEvent: ExtractedEvent = {
  title: '遠足',
  startAt: '2026-06-10T09:00:00+09:00',
  endAt: '2026-06-10T14:00:00+09:00',
  allDay: false,
  location: '○○公園',
  description: null,
  attributedTo: 'child3',
  attributionConfidence: 0.95,
  datetimeConfidence: 0.95,
  rawExcerpt: '遠足のお知らせ',
}

const lowConfidenceEvent: ExtractedEvent = {
  ...highConfidenceEvent,
  attributedTo: 'unknown',
  attributionConfidence: 0.2,
  datetimeConfidence: 0.3,
  title: 'ピアノ発表会',
}

async function clearAll() {
  for (const col of ['processed_events', 'pending_confirmations', 'attribution_hints']) {
    const s = await firestore.collection(col).get()
    await Promise.all(s.docs.map((d) => d.ref.delete()))
  }
}

beforeEach(clearAll)
afterEach(clearAll)

function buildDeps(extractedEvents: ExtractedEvent[]) {
  const extractor = {
    extract: vi.fn().mockResolvedValue({ events: extractedEvents, summary: '' }),
  }
  const insertedResults: WriteResult[] = []
  const writer = {
    writeAll: vi.fn(async (events: ExtractedEvent[], slackEventId: string) => {
      const out = events.map((e, i) => ({
        eventId: `hnm-${slackEventId}-${i}`,
        htmlLink: `https://cal/${i}`,
        calendarId: children[e.attributedTo as 'child1' | 'child2' | 'child3' | 'self'].calendarId,
        child: e.attributedTo,
      }))
      insertedResults.push(...out)
      return out
    }),
    remove: vi.fn(),
  }
  const slack = {
    postThreadMessage: vi.fn(async () => ({ ts: '1000.0' })),
    postChannelMessage: vi.fn(),
    postDirectMessage: vi.fn(),
    getFileBytes: vi.fn(),
  }
  return {
    extractor,
    writer,
    slack,
    idempotency: createIdempotencyStore(firestore),
    pending: createPendingStore(firestore),
    hints: createAttributionHintsStore(firestore),
    children,
    thresholds: { attribution: 0.8, datetime: 0.8 },
    insertedResults,
  }
}

describe('orchestrator', () => {
  it('auto-registers a high-confidence event', async () => {
    const d = buildDeps([highConfidenceEvent])
    const orch = createOrchestrator(d)
    const result = await orch.process(
      {
        postedAt: '2026-06-09T20:00:00+09:00',
        authorUserId: 'U1',
        channelId: 'C1',
        threadTs: '0.0',
        text: 'お便り',
        prefixHint: null,
        modeHint: null,
        images: [],
      },
      'evt-1',
    )
    expect(result.kind).toBe('created')
    expect(d.writer.writeAll).toHaveBeenCalledOnce()
    expect(d.slack.postThreadMessage).toHaveBeenCalled()
  })

  it('asks for confirmation on low-confidence event', async () => {
    const d = buildDeps([lowConfidenceEvent])
    const orch = createOrchestrator(d)
    const result = await orch.process(
      {
        postedAt: '2026-06-09T20:00:00+09:00',
        authorUserId: 'U1',
        channelId: 'C1',
        threadTs: '0.0',
        text: '来月どこかでピアノ発表会',
        prefixHint: null,
        modeHint: null,
        images: [],
      },
      'evt-2',
    )
    expect(result.kind).toBe('asked')
    expect(d.writer.writeAll).not.toHaveBeenCalled()
  })

  it('skips on duplicate slack event id', async () => {
    const d = buildDeps([highConfidenceEvent])
    const orch = createOrchestrator(d)
    await orch.process(
      {
        postedAt: '2026-06-09T20:00:00+09:00',
        authorUserId: 'U1',
        channelId: 'C1',
        threadTs: '0.0',
        text: '',
        prefixHint: null,
        modeHint: null,
        images: [],
      },
      'evt-dup',
    )
    const second = await orch.process(
      {
        postedAt: '2026-06-09T20:00:00+09:00',
        authorUserId: 'U1',
        channelId: 'C1',
        threadTs: '0.0',
        text: '',
        prefixHint: null,
        modeHint: null,
        images: [],
      },
      'evt-dup',
    )
    expect(second.kind).toBe('duplicate')
    expect(d.writer.writeAll).toHaveBeenCalledOnce()
  })

  it('posts a conflict note when the agent reports conflicts', async () => {
    const d = buildDeps([highConfidenceEvent])
    const agent = {
      reviewAndPersist: vi.fn().mockResolvedValue({
        conflicts: [
          {
            newEventTitle: '遠足',
            conflictsWith: 'ピアノ',
            when: '2026-06-10T09:00:00+09:00',
            members: ['末っ子'],
          },
        ],
        toolCalls: [],
        summary: '重複あり',
      }),
    }
    const orch = createOrchestrator({ ...d, agent })
    const result = await orch.process(
      {
        postedAt: '2026-06-09T20:00:00+09:00',
        authorUserId: 'U1',
        channelId: 'C1',
        threadTs: '0.0',
        text: 'お便り',
        prefixHint: null,
        modeHint: null,
        images: [],
      },
      'evt-conflict',
    )
    expect(result.kind).toBe('created')
    expect(agent.reviewAndPersist).toHaveBeenCalledOnce()
    // auto-register message + conflict note = 2 thread posts
    expect(d.slack.postThreadMessage).toHaveBeenCalledTimes(2)
    const calls = d.slack.postThreadMessage.mock.calls
    const lastCall = calls[calls.length - 1] as unknown[]
    expect(lastCall[2]).toContain('スケジュールの重複の可能性')
  })

  it('does not post an extra message when the agent reports no conflicts', async () => {
    const d = buildDeps([highConfidenceEvent])
    const agent = {
      reviewAndPersist: vi.fn().mockResolvedValue({ conflicts: [], toolCalls: [], summary: 'ok' }),
    }
    const orch = createOrchestrator({ ...d, agent })
    await orch.process(
      {
        postedAt: '2026-06-09T20:00:00+09:00',
        authorUserId: 'U1',
        channelId: 'C1',
        threadTs: '0.0',
        text: 'お便り',
        prefixHint: null,
        modeHint: null,
        images: [],
      },
      'evt-noconflict',
    )
    expect(agent.reviewAndPersist).toHaveBeenCalledOnce()
    // only the auto-register message
    expect(d.slack.postThreadMessage).toHaveBeenCalledTimes(1)
  })

  it('behaves unchanged with no agent dep (no extra post)', async () => {
    const d = buildDeps([highConfidenceEvent])
    const orch = createOrchestrator(d)
    await orch.process(
      {
        postedAt: '2026-06-09T20:00:00+09:00',
        authorUserId: 'U1',
        channelId: 'C1',
        threadTs: '0.0',
        text: 'お便り',
        prefixHint: null,
        modeHint: null,
        images: [],
      },
      'evt-noagent',
    )
    expect(d.slack.postThreadMessage).toHaveBeenCalledTimes(1)
  })

  it('returns empty when extractor finds no events', async () => {
    const d = buildDeps([])
    const orch = createOrchestrator(d)
    const result = await orch.process(
      {
        postedAt: '2026-06-09T20:00:00+09:00',
        authorUserId: 'U1',
        channelId: 'C1',
        threadTs: '0.0',
        text: '雑談',
        prefixHint: null,
        modeHint: null,
        images: [],
      },
      'evt-empty',
    )
    expect(result.kind).toBe('empty')
  })
})
