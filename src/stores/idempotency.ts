import type { Firestore } from '@google-cloud/firestore'

export type IdempotencyResult = {
  resultSummary: 'created' | 'pending' | 'rejected' | 'failed'
  createdEventIds: string[]
}

export type IdempotencyRecord = IdempotencyResult & {
  slackEventId: string
  processedAt: FirebaseFirestore.Timestamp | Date
  ttlAt: FirebaseFirestore.Timestamp | Date
  failureReason?: string
}

export type IdempotencyStore = {
  get(key: string): Promise<IdempotencyRecord | null>
  tryAcquire(key: string, options?: { reclaimStalePendingAfterMs?: number }): Promise<boolean>
  complete(key: string, result: IdempotencyResult): Promise<void>
  markFailed(key: string, err: unknown): Promise<void>
}

const COLLECTION = 'processed_events'
const TTL_DAYS = 30
const DEFAULT_STALE_PENDING_MS = 5 * 60 * 1000 // 5 分以上 pending のままなら zombie 扱い

function ttlDate(): Date {
  return new Date(Date.now() + TTL_DAYS * 24 * 60 * 60 * 1000)
}

function toDate(value: FirebaseFirestore.Timestamp | Date): Date {
  return value instanceof Date ? value : value.toDate()
}

export function createIdempotencyStore(firestore: Firestore): IdempotencyStore {
  const col = firestore.collection(COLLECTION)

  return {
    async get(key) {
      const snap = await col.doc(key).get()
      if (!snap.exists) return null
      return snap.data() as IdempotencyRecord
    },

    async tryAcquire(key, options) {
      const ref = col.doc(key)
      const staleAfterMs = options?.reclaimStalePendingAfterMs ?? DEFAULT_STALE_PENDING_MS
      try {
        await firestore.runTransaction(async (tx) => {
          const existing = await tx.get(ref)
          if (existing.exists) {
            const data = existing.data() as IdempotencyRecord
            const isReclaimable =
              data.resultSummary === 'pending' &&
              Date.now() - toDate(data.processedAt).getTime() > staleAfterMs
            if (!isReclaimable) {
              throw new Error('already-acquired')
            }
            // stale な pending を上書き取得（zombie reclaim）
          }
          tx.set(ref, {
            slackEventId: key,
            processedAt: new Date(),
            resultSummary: 'pending',
            createdEventIds: [],
            ttlAt: ttlDate(),
          } satisfies IdempotencyRecord)
        })
        return true
      } catch (err) {
        if ((err as Error).message === 'already-acquired') return false
        throw err
      }
    },

    async complete(key, result) {
      await col.doc(key).set(
        {
          slackEventId: key,
          processedAt: new Date(),
          resultSummary: result.resultSummary,
          createdEventIds: result.createdEventIds,
          ttlAt: ttlDate(),
        } satisfies IdempotencyRecord,
        { merge: true },
      )
    },

    async markFailed(key, err) {
      await col.doc(key).set(
        {
          resultSummary: 'failed',
          failureReason: err instanceof Error ? err.message : String(err),
        },
        { merge: true },
      )
    },
  }
}
