import { Firestore } from '@google-cloud/firestore'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  type IdempotencyResult,
  createIdempotencyStore,
} from '~/stores/idempotency'

let firestore: Firestore

beforeAll(() => {
  process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8085'
  firestore = new Firestore({ projectId: 'hanamaru-test' })
})

async function clearCollection() {
  const snapshot = await firestore.collection('processed_events').get()
  await Promise.all(snapshot.docs.map((d) => d.ref.delete()))
}

beforeEach(clearCollection)
afterEach(clearCollection)

describe('idempotency store', () => {
  it('returns null on first lookup', async () => {
    const store = createIdempotencyStore(firestore)
    const result = await store.get('team1:event1')
    expect(result).toBeNull()
  })

  it('tryAcquire succeeds on first attempt, fails on second', async () => {
    const store = createIdempotencyStore(firestore)
    const first = await store.tryAcquire('team1:event1')
    expect(first).toBe(true)
    const second = await store.tryAcquire('team1:event1')
    expect(second).toBe(false)
  })

  it('complete writes the result and get returns it', async () => {
    const store = createIdempotencyStore(firestore)
    await store.tryAcquire('team1:event1')
    const result: IdempotencyResult = {
      resultSummary: 'created',
      createdEventIds: ['hnm-event1-0'],
    }
    await store.complete('team1:event1', result)
    const fetched = await store.get('team1:event1')
    expect(fetched).toMatchObject(result)
  })

  it('markFailed records the error reason', async () => {
    const store = createIdempotencyStore(firestore)
    await store.tryAcquire('team1:event1')
    await store.markFailed('team1:event1', new Error('boom'))
    const fetched = await store.get('team1:event1')
    expect(fetched?.resultSummary).toBe('failed')
  })
})
