import type { Firestore } from '@google-cloud/firestore'
import type { ChildId } from '~/config/schema'

export type HintSource = 'manual' | 'learned' | 'config'

export type HintRecord = {
  key: string
  childId: Exclude<ChildId, 'unknown'>
  source: HintSource
  hitCount: number
  lastUsedAt: Date
}

export type AttributionHintsStore = {
  lookup(text: string): Promise<Exclude<ChildId, 'unknown'> | null>
  upsert(input: {
    key: string
    childId: Exclude<ChildId, 'unknown'>
    source: HintSource
  }): Promise<void>
  bumpHit(key: string): Promise<void>
  listAll(): Promise<HintRecord[]>
}

const COLLECTION = 'attribution_hints'

function normalize(key: string): string {
  return key.normalize('NFKC').trim()
}

function docId(key: string): string {
  return Buffer.from(normalize(key)).toString('base64url')
}

export function createAttributionHintsStore(firestore: Firestore): AttributionHintsStore {
  const col = firestore.collection(COLLECTION)

  return {
    async lookup(text) {
      const snap = await col.get()
      const normalized = normalize(text)
      for (const doc of snap.docs) {
        const data = doc.data() as HintRecord
        if (normalized.includes(normalize(data.key))) {
          return data.childId
        }
      }
      return null
    },

    async upsert({ key, childId, source }) {
      const id = docId(key)
      await col.doc(id).set(
        {
          key: normalize(key),
          childId,
          source,
          hitCount: 0,
          lastUsedAt: new Date(),
        } satisfies HintRecord,
        { merge: true },
      )
    },

    async bumpHit(key) {
      const ref = col.doc(docId(key))
      await firestore.runTransaction(async (tx) => {
        const snap = await tx.get(ref)
        if (!snap.exists) return
        const current = snap.data() as HintRecord
        tx.update(ref, { hitCount: current.hitCount + 1, lastUsedAt: new Date() })
      })
    },

    async listAll() {
      const snap = await col.get()
      return snap.docs.map((d) => d.data() as HintRecord)
    },
  }
}
