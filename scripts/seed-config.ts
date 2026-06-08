import { Firestore } from '@google-cloud/firestore'
import { buildChildren } from '~/config/children'
import { createAttributionHintsStore } from '~/stores/attribution-hints'

async function main() {
  const projectId = process.env.GCP_PROJECT_ID
  if (!projectId) throw new Error('GCP_PROJECT_ID is required')

  const firestore = new Firestore({ projectId })
  const hints = createAttributionHintsStore(firestore)
  const children = buildChildren(process.env)

  for (const id of ['child1', 'child2', 'child3', 'self'] as const) {
    for (const ctx of children[id].contexts) {
      await hints.upsert({ key: ctx, childId: id, source: 'config' })
      console.log(`upsert: ${ctx} -> ${id}`)
    }
  }
  console.log('Done.')
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
