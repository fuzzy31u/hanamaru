import { Firestore } from '@google-cloud/firestore'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ExtractedEvent } from '~/config/schema'
import { createPendingStore } from '~/stores/pending'

let firestore: Firestore

beforeAll(() => {
  process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8085'
  firestore = new Firestore({ projectId: 'hanamaru-test' })
})

const sampleEvent: ExtractedEvent = {
  title: 'ピアノ発表会',
  startAt: '2026-07-01T00:00:00+09:00',
  endAt: null,
  allDay: true,
  location: null,
  description: null,
  attributedTo: 'unknown',
  attributionConfidence: 0.3,
  datetimeConfidence: 0.3,
  rawExcerpt: '来月のどこかで発表会',
}

async function clearCollection() {
  const snapshot = await firestore.collection('pending_confirmations').get()
  await Promise.all(snapshot.docs.map((d) => d.ref.delete()))
}

beforeEach(clearCollection)
afterEach(clearCollection)

describe('pending store', () => {
  it('creates and retrieves a pending record', async () => {
    const store = createPendingStore(firestore)
    const id = await store.create({
      slackChannelId: 'C123',
      slackThreadTs: '1.0',
      slackMessageTs: '2.0',
      events: [sampleEvent],
    })
    const fetched = await store.getById(id)
    expect(fetched?.status).toBe('awaiting')
    expect(fetched?.events).toHaveLength(1)
  })

  it('finds by message ts (for reactions)', async () => {
    const store = createPendingStore(firestore)
    await store.create({
      slackChannelId: 'C123',
      slackThreadTs: '1.0',
      slackMessageTs: 'unique-3.0',
      events: [sampleEvent],
    })
    const found = await store.findByMessageTs('C123', 'unique-3.0')
    expect(found).not.toBeNull()
  })

  it('updates status to approved', async () => {
    const store = createPendingStore(firestore)
    const id = await store.create({
      slackChannelId: 'C123',
      slackThreadTs: '1.0',
      slackMessageTs: '4.0',
      events: [sampleEvent],
    })
    await store.updateStatus(id, 'approved')
    const fetched = await store.getById(id)
    expect(fetched?.status).toBe('approved')
  })
})
