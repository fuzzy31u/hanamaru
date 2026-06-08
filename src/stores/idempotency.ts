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
  tryAcquire(key: string): Promise<boolean>
  complete(key: string, result: IdempotencyResult): Promise<void>
  markFailed(key: string, err: unknown): Promise<void>
}

const COLLECTION = 'processed_events'
const TTL_DAYS = 30

function ttlDate(): Date {
  return new Date(Date.now() + TTL_DAYS * 24 * 60 * 60 * 1000)
}

export function createIdempotencyStore(firestore: Firestore): IdempotencyStore {
  const col = firestore.collection(COLLECTION)

  return {
    async get(key) {
      const snap = await col.doc(key).get()
      if (!snap.exists) return null
      return snap.data() as IdempotencyRecord
    },

    async tryAcquire(key) {
      const ref = col.doc(key)
      try {
        await firestore.runTransaction(async (tx) => {
          const existing = await tx.get(ref)
          if (existing.exists) {
            throw new Error('already-acquired')
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
