import { Firestore } from '@google-cloud/firestore'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createAttributionHintsStore } from '~/stores/attribution-hints'

let firestore: Firestore

beforeAll(() => {
  process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8085'
  firestore = new Firestore({ projectId: 'hanamaru-test' })
})

async function clearCollection() {
  const snapshot = await firestore.collection('attribution_hints').get()
  await Promise.all(snapshot.docs.map((d) => d.ref.delete()))
}

beforeEach(clearCollection)
afterEach(clearCollection)

describe('attribution hints store', () => {
  it('returns null when no hint matches', async () => {
    const store = createAttributionHintsStore(firestore)
    expect(await store.lookup('近所のスーパー')).toBeNull()
  })

  it('upserts and looks up by key', async () => {
    const store = createAttributionHintsStore(firestore)
    await store.upsert({ key: 'ピアノ教室', childId: 'child2', source: 'manual' })
    expect(await store.lookup('明日のピアノ教室のレッスン')).toBe('child2')
  })

  it('increments hitCount on bump', async () => {
    const store = createAttributionHintsStore(firestore)
    await store.upsert({ key: 'スイミング', childId: 'child3', source: 'learned' })
    await store.bumpHit('スイミング')
    await store.bumpHit('スイミング')
    const all = await store.listAll()
    const sw = all.find((r) => r.key === 'スイミング')
    expect(sw?.hitCount).toBe(2)
  })
})
