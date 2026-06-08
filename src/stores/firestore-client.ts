import { Firestore } from '@google-cloud/firestore'

let cached: Firestore | null = null

export function getFirestore(projectId?: string): Firestore {
  if (cached === null) {
    cached = new Firestore({
      projectId: projectId ?? process.env.GCP_PROJECT_ID,
      databaseId: process.env.FIRESTORE_DATABASE ?? '(default)',
    })
  }
  return cached
}

export function resetFirestoreClientForTesting(): void {
  cached = null
}
