import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { McpToolError } from '~/lib/errors'
import { logger } from '~/lib/logger'

const PACKAGE_NAME = 'mongodb-mcp-server'

/**
 * Resolves the absolute path to the bundled `mongodb-mcp-server` executable
 * entry (its `bin`) from the installed package, with NO network access and NO
 * dependency on `npx`/PATH. Works under both `tsx` (pnpm dev) and the built
 * `dist` container.
 *
 * Strategy: resolve the package's main entry (its `.` export) via
 * `require.resolve`, walk up to the package root (the dir whose package.json
 * has the matching `name`), then join the package's `bin` entry. The `package.json`
 * subpath itself is not directly resolvable because the package restricts its
 * `exports`, hence the walk-up.
 */
function resolveServerEntry(): string {
  const require = createRequire(import.meta.url)
  // Resolves the package's '.' export (e.g. dist/cjs/lib.js) — this lands us
  // somewhere inside the installed package directory.
  const mainEntry = require.resolve(PACKAGE_NAME)
  let dir = dirname(mainEntry)
  while (dir !== dirname(dir)) {
    const pkgPath = join(dir, 'package.json')
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        name?: string
        bin?: string | Record<string, string>
        main?: string
      }
      if (pkg.name === PACKAGE_NAME) {
        const binRel = typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin?.[PACKAGE_NAME] ?? pkg.main)
        if (!binRel) {
          throw new Error('mongodb-mcp-server package.json has no usable bin/main entry')
        }
        return join(dir, binRel)
      }
    }
    dir = dirname(dir)
  }
  throw new Error(`Could not locate the ${PACKAGE_NAME} package root from ${mainEntry}`)
}

// Launch the locally installed server with the running Node binary so the
// MongoDB feature never depends on `npx` or a network download at runtime.
const DEFAULT_COMMAND = process.execPath
const DEFAULT_ARGS = [resolveServerEntry()]
const CLIENT_NAME = 'hanamaru'
const CLIENT_VERSION = '0.1.0'

export type McpMongoConfig = {
  /** Standard mongodb+srv connection string passed to the server via MDB_MCP_CONNECTION_STRING. */
  connectionString: string
  /** Command used to spawn the MCP server. Defaults to the running Node binary (`process.execPath`). */
  command?: string
  /** Arguments for the spawn command. Defaults to the resolved absolute path of the bundled `mongodb-mcp-server` entry. */
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
        // Terminate the already-spawned subprocess so it does not leak as a
        // zombie/orphan on Cloud Run retries, then leave the adapter
        // unconnected so a retry can spawn a fresh transport.
        await t.close().catch(() => {})
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
