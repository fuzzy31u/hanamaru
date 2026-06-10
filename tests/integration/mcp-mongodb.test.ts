import { describe, expect, it } from 'vitest'
import { createMongoMcpClient } from '~/adapters/mcp-mongodb'

const connStr = process.env.MDB_MCP_CONNECTION_STRING

// Only runs when a real connection string is provided. Skipped by default so CI
// and local runs pass without network access or MongoDB credentials.
describe('mongodb-mcp-server integration', () => {
  it.skipIf(!connStr)(
    'spawns the real server and lists databases',
    async () => {
      const client = createMongoMcpClient({ connectionString: connStr as string })
      try {
        await client.connect()

        const tools = await client.listTools()
        const names = tools.map((t) => t.name)
        expect(names).toContain('list-databases')
        expect(names).toContain('find')

        const result = await client.callTool('list-databases', {})
        expect(result).toBeDefined()
      } finally {
        await client.close()
      }
    },
    60_000,
  )
})
