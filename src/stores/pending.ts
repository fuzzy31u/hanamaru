import type { Firestore } from '@google-cloud/firestore'
import type { ExtractedEvent } from '~/config/schema'

export type PendingStatus = 'awaiting' | 'approved' | 'rejected' | 'expired'

export type PendingRecord = {
  id: string
  slackChannelId: string
  slackThreadTs: string
  slackMessageTs: string
  events: ExtractedEvent[]
  createdAt: Date
  expiresAt: Date
  status: PendingStatus
}

export type CreatePendingInput = Omit<PendingRecord, 'id' | 'createdAt' | 'expiresAt' | 'status'>

export type PendingStore = {
  create(input: CreatePendingInput): Promise<string>
  getById(id: string): Promise<PendingRecord | null>
  findByMessageTs(channelId: string, messageTs: string): Promise<PendingRecord | null>
  updateStatus(id: string, status: PendingStatus): Promise<void>
}

const COLLECTION = 'pending_confirmations'
const EXPIRY_DAYS = 7

function expiryDate(): Date {
  return new Date(Date.now() + EXPIRY_DAYS * 24 * 60 * 60 * 1000)
}

export function createPendingStore(firestore: Firestore): PendingStore {
  const col = firestore.collection(COLLECTION)

  return {
    async create(input) {
      const ref = col.doc()
      const record: Omit<PendingRecord, 'id'> = {
        ...input,
        createdAt: new Date(),
        expiresAt: expiryDate(),
        status: 'awaiting',
      }
      await ref.set(record)
      return ref.id
    },

    async getById(id) {
      const snap = await col.doc(id).get()
      if (!snap.exists) return null
      return { id: snap.id, ...(snap.data() as Omit<PendingRecord, 'id'>) }
    },

    async findByMessageTs(channelId, messageTs) {
      const q = await col
        .where('slackChannelId', '==', channelId)
        .where('slackMessageTs', '==', messageTs)
        .limit(1)
        .get()
      const doc = q.docs[0]
      if (!doc) return null
      return { id: doc.id, ...(doc.data() as Omit<PendingRecord, 'id'>) }
    },

    async updateStatus(id, status) {
      await col.doc(id).update({ status })
    },
  }
}
