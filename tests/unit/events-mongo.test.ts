import { MongoMemoryServer } from 'mongodb-memory-server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ExtractedEvent } from '~/config/schema'
import { type EventsStore, createEventsStore } from '~/stores/events-mongo'

function makeEvent(overrides: Partial<ExtractedEvent> = {}): ExtractedEvent {
  return {
    title: 'サッカー練習',
    startAt: '2026-07-01T10:00:00+09:00',
    endAt: '2026-07-01T11:00:00+09:00',
    allDay: false,
    location: null,
    description: null,
    attributedTo: 'child1',
    attributionConfidence: 0.9,
    datetimeConfidence: 0.9,
    rawExcerpt: 'サッカー練習 7/1 10時',
    ...overrides,
  }
}

describe('events-mongo store', () => {
  let mongod: MongoMemoryServer
  let store: EventsStore

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create()
    store = createEventsStore({
      connectionString: mongod.getUri(),
      dbName: 'hanamaru_test',
    })
  })

  afterAll(async () => {
    await store.close()
    await mongod.stop()
  })

  it('insertEvents returns ids and stores retrievable docs', async () => {
    const ids = await store.insertEvents([makeEvent()], {
      source: 'slack',
      slackEventId: 'evt-1',
    })
    expect(ids).toHaveLength(1)
    expect(typeof ids[0]).toBe('string')

    const found = await store.findByDateRange(
      '2026-07-01T00:00:00+09:00',
      '2026-07-02T00:00:00+09:00',
    )
    const inserted = found.find((e) => e._id === ids[0])
    expect(inserted).toBeDefined()
    expect(inserted?.title).toBe('サッカー練習')
    expect(inserted?.source).toBe('slack')
    expect(inserted?.slackEventId).toBe('evt-1')
    expect(inserted?.createdAt).toBeInstanceOf(Date)
  })

  it('findByDateRange filters by [start, end) and by childId', async () => {
    await store.insertEvents(
      [
        makeEvent({ title: 'A', startAt: '2026-08-10T09:00:00+09:00', attributedTo: 'child1' }),
        makeEvent({ title: 'B', startAt: '2026-08-10T20:00:00+09:00', attributedTo: 'child2' }),
        makeEvent({ title: 'C', startAt: '2026-08-12T09:00:00+09:00', attributedTo: 'child1' }),
      ],
      { source: 'slack', slackEventId: null },
    )

    const inRange = await store.findByDateRange(
      '2026-08-10T00:00:00+09:00',
      '2026-08-11T00:00:00+09:00',
    )
    const titles = inRange.map((e) => e.title).sort()
    expect(titles).toEqual(['A', 'B'])

    const child1Only = await store.findByDateRange(
      '2026-08-10T00:00:00+09:00',
      '2026-08-11T00:00:00+09:00',
      'child1',
    )
    expect(child1Only.map((e) => e.title)).toEqual(['A'])

    // end is exclusive
    const excludesEnd = await store.findByDateRange(
      '2026-08-10T00:00:00+09:00',
      '2026-08-10T20:00:00+09:00',
    )
    expect(excludesEnd.map((e) => e.title)).toEqual(['A'])
  })

  it('findConflicts detects overlap and ignores non-overlap', async () => {
    await store.insertEvents(
      [
        makeEvent({
          title: 'ピアノ',
          startAt: '2026-09-01T14:00:00+09:00',
          endAt: '2026-09-01T15:00:00+09:00',
          attributedTo: 'child2',
        }),
      ],
      { source: 'slack', slackEventId: 'conflict-base' },
    )

    // Overlapping (14:30-15:30 overlaps 14:00-15:00), even for a different family member.
    const overlapping = makeEvent({
      title: '歯医者',
      startAt: '2026-09-01T14:30:00+09:00',
      endAt: '2026-09-01T15:30:00+09:00',
      attributedTo: 'child1',
    })
    const conflicts = await store.findConflicts(overlapping)
    expect(conflicts.some((c) => c.title === 'ピアノ')).toBe(true)

    // Non-overlapping (16:00-17:00 is after 15:00).
    const nonOverlapping = makeEvent({
      title: '習い事',
      startAt: '2026-09-01T16:00:00+09:00',
      endAt: '2026-09-01T17:00:00+09:00',
    })
    const noConflicts = await store.findConflicts(nonOverlapping)
    expect(noConflicts.some((c) => c.title === 'ピアノ')).toBe(false)
  })

  it('findConflicts uses a 1h default duration when endAt is null', async () => {
    await store.insertEvents(
      [
        makeEvent({
          title: '塾',
          startAt: '2026-10-05T18:00:00+09:00',
          endAt: null,
          attributedTo: 'child1',
        }),
      ],
      { source: 'slack', slackEventId: 'no-end' },
    )

    // 18:30 falls within the implied 18:00-19:00 window.
    const overlapping = makeEvent({
      title: '夕食',
      startAt: '2026-10-05T18:30:00+09:00',
      endAt: null,
    })
    const conflicts = await store.findConflicts(overlapping)
    expect(conflicts.some((c) => c.title === '塾')).toBe(true)
  })

  it('findConflicts ignores all-day events', async () => {
    await store.insertEvents(
      [
        makeEvent({
          title: '運動会',
          startAt: '2026-11-03T00:00:00+09:00',
          endAt: null,
          allDay: true,
        }),
      ],
      { source: 'slack', slackEventId: 'all-day' },
    )

    const timed = makeEvent({
      title: '買い物',
      startAt: '2026-11-03T10:00:00+09:00',
      endAt: '2026-11-03T11:00:00+09:00',
    })
    const conflicts = await store.findConflicts(timed)
    expect(conflicts.some((c) => c.title === '運動会')).toBe(false)
  })
})
