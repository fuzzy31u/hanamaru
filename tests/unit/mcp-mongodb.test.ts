import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock the MCP SDK Client and StdioClientTransport so no real subprocess/MongoDB is needed.
const connectMock = vi.fn()
const listToolsMock = vi.fn()
const callToolMock = vi.fn()
const clientCloseMock = vi.fn()
const ClientCtor = vi.fn()
const TransportCtor = vi.fn()

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = connectMock
    listTools = listToolsMock
    callTool = callToolMock
    close = clientCloseMock
    constructor(...args: unknown[]) {
      ClientCtor(...args)
    }
  },
}))

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    constructor(...args: unknown[]) {
      TransportCtor(...args)
    }
  },
}))

import { createMongoMcpClient } from '~/adapters/mcp-mongodb'

const CONN = 'mongodb+srv://user:pass@cluster.example.net/'

beforeEach(() => {
  vi.clearAllMocks()
  connectMock.mockResolvedValue(undefined)
  listToolsMock.mockResolvedValue({ tools: [] })
  callToolMock.mockResolvedValue({ content: [] })
  clientCloseMock.mockResolvedValue(undefined)
})

describe('createMongoMcpClient', () => {
  it('spawns the server with the connection string in env and connects', async () => {
    const client = createMongoMcpClient({ connectionString: CONN })
    await client.connect()

    expect(TransportCtor).toHaveBeenCalledTimes(1)
    const transportArg = TransportCtor.mock.calls[0]?.[0] as {
      command: string
      args: string[]
      env: Record<string, string>
    }
    expect(transportArg.command).toBe('npx')
    expect(transportArg.args).toEqual(['-y', 'mongodb-mcp-server'])
    expect(transportArg.env.MDB_MCP_CONNECTION_STRING).toBe(CONN)
    expect(connectMock).toHaveBeenCalledTimes(1)
  })

  it('honors custom command and args', async () => {
    const client = createMongoMcpClient({
      connectionString: CONN,
      command: 'node',
      args: ['server.js'],
    })
    await client.connect()
    const transportArg = TransportCtor.mock.calls[0]?.[0] as { command: string; args: string[] }
    expect(transportArg.command).toBe('node')
    expect(transportArg.args).toEqual(['server.js'])
  })

  it('is idempotent: connecting twice only connects once', async () => {
    const client = createMongoMcpClient({ connectionString: CONN })
    await client.connect()
    await client.connect()
    expect(connectMock).toHaveBeenCalledTimes(1)
    expect(TransportCtor).toHaveBeenCalledTimes(1)
  })

  it('lists tools with name, description and input schema', async () => {
    listToolsMock.mockResolvedValue({
      tools: [
        {
          name: 'find',
          description: 'Run a find query against a MongoDB collection',
          inputSchema: { type: 'object', properties: { database: { type: 'string' } } },
        },
        { name: 'list-databases', inputSchema: { type: 'object' } },
      ],
    })
    const client = createMongoMcpClient({ connectionString: CONN })
    await client.connect()
    const tools = await client.listTools()
    expect(tools).toEqual([
      {
        name: 'find',
        description: 'Run a find query against a MongoDB collection',
        inputSchema: { type: 'object', properties: { database: { type: 'string' } } },
      },
      { name: 'list-databases', description: '', inputSchema: { type: 'object' } },
    ])
  })

  it('auto-connects when listTools is called before connect', async () => {
    const client = createMongoMcpClient({ connectionString: CONN })
    await client.listTools()
    expect(connectMock).toHaveBeenCalledTimes(1)
  })

  it('forwards name and args to callTool and returns parsed content', async () => {
    callToolMock.mockResolvedValue({
      content: [{ type: 'text', text: '{"count":3}' }],
    })
    const client = createMongoMcpClient({ connectionString: CONN })
    await client.connect()
    const result = await client.callTool('count', { database: 'hanamaru', collection: 'events' })

    expect(callToolMock).toHaveBeenCalledWith({
      name: 'count',
      arguments: { database: 'hanamaru', collection: 'events' },
    })
    expect(result).toEqual([{ type: 'text', text: '{"count":3}' }])
  })

  it('returns structuredContent when present', async () => {
    callToolMock.mockResolvedValue({
      content: [{ type: 'text', text: 'ignored' }],
      structuredContent: { databases: ['a', 'b'] },
    })
    const client = createMongoMcpClient({ connectionString: CONN })
    await client.connect()
    const result = await client.callTool('list-databases', {})
    expect(result).toEqual({ databases: ['a', 'b'] })
  })

  it('throws a clear error when the tool result is flagged isError', async () => {
    callToolMock.mockResolvedValue({
      content: [{ type: 'text', text: 'collection not found' }],
      isError: true,
    })
    const client = createMongoMcpClient({ connectionString: CONN })
    await client.connect()
    await expect(client.callTool('find', { database: 'x' })).rejects.toThrow(
      /find.*collection not found/i,
    )
  })

  it('propagates transport/connect errors', async () => {
    connectMock.mockRejectedValue(new Error('spawn npx ENOENT'))
    const client = createMongoMcpClient({ connectionString: CONN })
    await expect(client.connect()).rejects.toThrow(/ENOENT/)
  })

  it('closes the client and is safe when never connected', async () => {
    const client = createMongoMcpClient({ connectionString: CONN })
    await client.close() // never connected -> no throw, no client.close call
    expect(clientCloseMock).not.toHaveBeenCalled()

    await client.connect()
    await client.close()
    expect(clientCloseMock).toHaveBeenCalledTimes(1)
  })

  it('allows reconnect after close', async () => {
    const client = createMongoMcpClient({ connectionString: CONN })
    await client.connect()
    await client.close()
    await client.connect()
    expect(connectMock).toHaveBeenCalledTimes(2)
  })
})
