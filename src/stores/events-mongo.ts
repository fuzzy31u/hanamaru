/**
 * PHASE-2 GROUNDWORK — NOT YET WIRED INTO THE RUNTIME.
 *
 * This is a deterministic, direct-driver (`mongodb`) event store. It is fully
 * unit-tested but is intentionally NOT imported anywhere in `src/`: the live
 * persistence path runs through the MongoDB MCP agent in `src/pipeline/agent.ts`
 * (the Gemini tool-calling loop writes events via the `mongodb-mcp-server`),
 * not through this store.
 *
 * It is retained as groundwork for a more reliable Phase-2 path where conflict
 * detection and inserts run as deterministic code rather than relying on the LLM
 * agent honoring the MCP tool instructions.
 *
 * IMPORTANT before activating: the document schema written here
 * (`startMs`/`endMs`/`source`/`slackEventId`/`calendarEventId`/`createdAt`) must
 * be reconciled with what the MCP agent actually writes, so the two paths do not
 * produce divergent document shapes in the same `events` collection.
 */
import { type Collection, type MongoClient, MongoClient as MongoClientCtor } from 'mongodb'
import type { ChildId, ExtractedEvent } from '~/config/schema'

/**
 * 家族全体の予定履歴を MongoDB Atlas に蓄積するストア。
 * Firestore のホットパス state とは別に、追加的・feature-flag 前提で利用する。
 */
export type EventRecord = ExtractedEvent & {
  /** string | undefined (populated on records read back from the store) */
  _id?: string
  source: 'slack' | 'web'
  slackEventId: string | null
  calendarEventId: string | null
  createdAt: Date
}

export type InsertMeta = {
  source: 'slack' | 'web'
  slackEventId: string | null
}

export type EventsStore = {
  insertEvents(events: ExtractedEvent[], meta: InsertMeta): Promise<string[]>
  /**
   * Returns events whose START time falls within [startIso, endIso).
   * Events that start before the window but end inside it are NOT included —
   * this is intentional, the method is for 'upcoming events starting in this window'
   * views, not full calendar-overlap rendering.
   */
  findByDateRange(startIso: string, endIso: string, childId?: ChildId): Promise<EventRecord[]>
  findConflicts(event: ExtractedEvent): Promise<EventRecord[]>
  /**
   * Closes the underlying MongoDB connection.
   * close() must only be called during shutdown when no store methods are in-flight.
   */
  close(): Promise<void>
}

const DEFAULT_COLLECTION = 'events'
const DEFAULT_DURATION_MS = 60 * 60 * 1000

/** startAt/endAt の ISO 文字列を source-of-truth に保ちつつ、クエリ用に派生させる epoch ms 表現。 */
type StoredEvent = EventRecord & { startMs: number; endMs: number }

function durationEndMs(startMs: number, endAt: string | null): number {
  return endAt ? new Date(endAt).getTime() : startMs + DEFAULT_DURATION_MS
}

function toRecord(stored: StoredEvent): EventRecord {
  // クエリ専用の派生フィールドは公開 API のレコードから除外する。
  const { startMs: _startMs, endMs: _endMs, ...record } = stored
  return record
}

export type CreateEventsStoreOptions = {
  connectionString: string
  dbName: string
  collectionName?: string
}

export function createEventsStore(opts: CreateEventsStoreOptions): EventsStore {
  const collectionName = opts.collectionName ?? DEFAULT_COLLECTION
  let client: MongoClient | null = null
  let collectionPromise: Promise<Collection<StoredEvent>> | null = null

  async function getCollection(): Promise<Collection<StoredEvent>> {
    if (!collectionPromise) {
      collectionPromise = (async () => {
        client = new MongoClientCtor(opts.connectionString)
        await client.connect()
        return client.db(opts.dbName).collection<StoredEvent>(collectionName)
      })()
    }
    return collectionPromise
  }

  return {
    async insertEvents(events, meta) {
      if (events.length === 0) return []
      const col = await getCollection()
      const createdAt = new Date()
      const docs = events.map((event): StoredEvent => {
        const startMs = new Date(event.startAt).getTime()
        return {
          ...event,
          source: meta.source,
          slackEventId: meta.slackEventId,
          calendarEventId: null,
          createdAt,
          startMs,
          endMs: durationEndMs(startMs, event.endAt),
        }
      })
      const result = await col.insertMany(docs)
      return Object.values(result.insertedIds).map((id) => id.toString())
    },

    async findByDateRange(startIso, endIso, childId) {
      const col = await getCollection()
      const filter: Record<string, unknown> = {
        startMs: { $gte: new Date(startIso).getTime(), $lt: new Date(endIso).getTime() },
      }
      if (childId) filter.attributedTo = childId
      const docs = await col.find(filter).sort({ startMs: 1 }).toArray()
      return docs.map((d) => toRecord({ ...d, _id: d._id.toString() }))
    },

    async findConflicts(event) {
      // 終日予定は時間帯を持たないため時間衝突から除外する（シンプルかつ正しい規則）。
      if (event.allDay) return []
      const col = await getCollection()
      const startMs = new Date(event.startAt).getTime()
      const endMs = durationEndMs(startMs, event.endAt)
      // 区間 [startMs, endMs) が重なる条件: 既存.start < 新規.end かつ 既存.end > 新規.start。
      // 家族全体（任意メンバー）が対象なので attributedTo では絞らない。
      const docs = await col
        .find({ allDay: false, startMs: { $lt: endMs }, endMs: { $gt: startMs } })
        .sort({ startMs: 1 })
        .toArray()
      return docs.map((d) => toRecord({ ...d, _id: d._id.toString() }))
    },

    async close() {
      if (client) {
        await client.close()
        client = null
        collectionPromise = null
      }
    },
  }
}
