import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { McpToolError } from '~/lib/errors'
import { logger } from '~/lib/logger'

const DEFAULT_COMMAND = 'npx'
const DEFAULT_ARGS = ['-y', 'mongodb-mcp-server']
const CLIENT_NAME = 'hanamaru'
const CLIENT_VERSION = '0.1.0'

export type McpMongoConfig = {
  /** Standard mongodb+srv connection string passed to the server via MDB_MCP_CONNECTION_STRING. */
  connectionString: string
  /** Command used to spawn the MCP server. Defaults to `npx`. */
  command?: string
  /** Arguments for the spawn command. Defaults to `['-y', 'mongodb-mcp-server']`. */
  args?: string[]
}

/** Describes an MCP tool, suitable for converting into Gemini function declarations later. */
export type McpToolInfo = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export type MongoMcpClient = {
  connect(): Promise<void>
  listTools(): Promise<McpToolInfo[]>
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>
  close(): Promise<void>
}

/** A single content block of an MCP tool result. */
type ToolResultContent = { type: string; text?: string; [key: string]: unknown }

type CallToolResult = {
  content?: ToolResultContent[]
  structuredContent?: unknown
  isError?: boolean
}

function extractErrorText(content: ToolResultContent[] | undefined): string {
  if (!content || content.length === 0) return 'unknown MCP tool error'
  return content
    .map((block) => block.text ?? JSON.stringify(block))
    .join('\n')
    .trim()
}

/**
 * Creates an MCP client adapter that talks to the official `mongodb-mcp-server`
 * over stdio. Keeps the surface generic (transport + tool listing/calling) so the
 * Gemini agent loop can be layered on top elsewhere.
 */
export function createMongoMcpClient(config: McpMongoConfig): MongoMcpClient {
  const command = config.command ?? DEFAULT_COMMAND
  const args = config.args ?? DEFAULT_ARGS

  let client: Client | null = null
  let connecting: Promise<void> | null = null

  async function ensureConnected(): Promise<void> {
    if (client) return
    if (connecting) return connecting

    connecting = (async () => {
      const t = new StdioClientTransport({
        command,
        args,
        env: { MDB_MCP_CONNECTION_STRING: config.connectionString },
      })
      const c = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION }, { capabilities: {} })
      try {
        await c.connect(t)
      } catch (err) {
        logger.error('mcpMongo.connectFailed', {
          error: err instanceof Error ? err.message : String(err),
        })
        // Leave the adapter unconnected so a retry can spawn a fresh transport.
        throw err
      }
      client = c
      logger.info('mcpMongo.connected', { command })
    })()

    try {
      await connecting
    } finally {
      connecting = null
    }
  }

  return {
    async connect() {
      await ensureConnected()
    },

    async listTools() {
      await ensureConnected()
      if (!client) throw new McpToolError('MCP client not connected')
      const { tools } = await client.listTools()
      return tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
      }))
    },

    async callTool(name, args) {
      await ensureConnected()
      if (!client) throw new McpToolError('MCP client not connected')

      const result = (await client.callTool({ name, arguments: args })) as CallToolResult

      if (result.isError) {
        throw new McpToolError(`MCP tool "${name}" failed: ${extractErrorText(result.content)}`)
      }

      // Prefer structured output when the server provides it; otherwise return
      // the raw content blocks for the caller to interpret.
      if (result.structuredContent !== undefined) return result.structuredContent
      return result.content ?? []
    },

    async close() {
      if (!client) return
      try {
        await client.close()
      } catch (err) {
        logger.warn('mcpMongo.closeFailed', {
          error: err instanceof Error ? err.message : String(err),
        })
      } finally {
        client = null
      }
    },
  }
}
