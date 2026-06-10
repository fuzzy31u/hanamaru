import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { createGeminiClient } from '~/adapters/gemini'
import { createCalendarClient } from '~/adapters/google-calendar'
import { createMongoMcpClient } from '~/adapters/mcp-mongodb'
import { readSecret } from '~/adapters/secrets'
import { createSlackClient } from '~/adapters/slack'
import { buildChildren } from '~/config/children'
import { loadThresholdsFromEnv } from '~/config/thresholds'
import { type SlackEventCallback, handleSlackEvent } from '~/handlers/slack-events'
import { type ReactionAddedEvent, handleReaction } from '~/handlers/slack-reactions'
import { createWebExtractHandler } from '~/handlers/web-extract'
import { logger } from '~/lib/logger'
import { verifySlackSignature } from '~/lib/slack-signature'
import { type ScheduleAgent, createScheduleAgent } from '~/pipeline/agent'
import { createCalendarWriter } from '~/pipeline/calendar-writer'
import { createExtractor } from '~/pipeline/extractor'
import { createOrchestrator } from '~/pipeline/orchestrator'
import { createAttributionHintsStore } from '~/stores/attribution-hints'
import { getFirestore } from '~/stores/firestore-client'
import { createIdempotencyStore } from '~/stores/idempotency'
import { createPendingStore } from '~/stores/pending'

/**
 * Loads the web demo HTML once at startup.
 *
 * Path strategy: the build copies src/web/index.html to dist/index.html (see the
 * `build` script and Dockerfile). We resolve relative to this module's directory
 * and try both layouts so the same code works in `pnpm dev` (tsx runs from
 * src/server.ts → ../web/index.html) and in the bundled container (dist/server.js
 * → ./index.html). The first readable candidate wins.
 */
function loadWebHtml(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    resolve(here, 'index.html'), // bundled: dist/index.html (next to dist/server.js)
    resolve(here, 'web/index.html'), // bundled alt: dist/web/index.html
    resolve(here, '../web/index.html'), // dev: src/server.ts → src/web/index.html
  ]
  for (const path of candidates) {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      // try next candidate
    }
  }
  logger.warn('server.webHtmlMissing', { candidates })
  return '<!doctype html><meta charset="utf-8"><title>Hanamaru</title><p>Web demo asset not found.</p>'
}

async function bootstrap() {
  const projectId = process.env.GCP_PROJECT_ID
  if (!projectId) throw new Error('GCP_PROJECT_ID is required')

  const region = process.env.GCP_REGION ?? 'asia-northeast1'
  const useSecretManager = process.env.NODE_ENV === 'production'

  const readEnvOrSecret = async (envKey: string, secretName: string): Promise<string> => {
    if (useSecretManager) return readSecret(projectId, secretName)
    const value = process.env[envKey]
    if (!value) throw new Error(`Env var missing: ${envKey}`)
    return value
  }

  const slackSigningSecret = await readEnvOrSecret('SLACK_SIGNING_SECRET', 'slack-signing-secret')
  const slackBotToken = await readEnvOrSecret('SLACK_BOT_TOKEN', 'slack-bot-token')
  const googleClientId = await readEnvOrSecret('GOOGLE_OAUTH_CLIENT_ID', 'google-oauth-client-id')
  const googleClientSecret = await readEnvOrSecret(
    'GOOGLE_OAUTH_CLIENT_SECRET',
    'google-oauth-client-secret',
  )
  const googleRefreshToken = await readEnvOrSecret(
    'GOOGLE_CALENDAR_REFRESH_TOKEN',
    'google-calendar-refresh-token',
  )

  const children = buildChildren(process.env)
  const thresholds = loadThresholdsFromEnv(process.env)

  // Live demo calendar: when set, the web /api/extract endpoint writes
  // auto-register events to this Google Calendar and the web page embeds it.
  const demoCalendarId = process.env.DEMO_CALENDAR_ID

  const slack = createSlackClient({ botToken: slackBotToken })
  const gemini = createGeminiClient({
    projectId,
    location: process.env.GEMINI_LOCATION ?? region,
    model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
    children,
  })
  const calendar = createCalendarClient({
    clientId: googleClientId,
    clientSecret: googleClientSecret,
    refreshToken: googleRefreshToken,
  })

  const firestore = getFirestore(projectId)
  const idempotency = createIdempotencyStore(firestore)
  const pending = createPendingStore(firestore)
  const hints = createAttributionHintsStore(firestore)

  const extractor = createExtractor(gemini)
  const writer = createCalendarWriter(calendar, children)

  // Feature-flagged MongoDB-MCP schedule agent. Construction is guarded so a
  // missing/misconfigured connection string when the flag is OFF cannot break boot.
  // We do NOT block bootstrap on a network connect; listTools/callTool auto-connect lazily.
  let agent: ScheduleAgent | undefined
  let mcpClient: ReturnType<typeof createMongoMcpClient> | undefined
  if (process.env.ENABLE_MONGO_MCP === 'true') {
    try {
      const connectionString = await readEnvOrSecret(
        'MDB_MCP_CONNECTION_STRING',
        'mdb-mcp-connection-string',
      )
      mcpClient = createMongoMcpClient({ connectionString })
      agent = createScheduleAgent({
        gemini,
        mcp: mcpClient,
        dbName: process.env.MONGO_DB_NAME ?? 'hanamaru',
      })
      logger.info('server.mongoMcpEnabled', { dbName: process.env.MONGO_DB_NAME ?? 'hanamaru' })
    } catch (err) {
      logger.error('server.mongoMcpInitFailed', { err: String(err) })
    }
  }

  // Graceful shutdown: on Cloud Run SIGTERM, close the MCP client so the
  // mongodb-mcp-server subprocess is terminated before the container exits.
  if (mcpClient) {
    const client = mcpClient
    process.once('SIGTERM', () => {
      void client.close().finally(() => process.exit(0))
    })
  }

  const orchestrator = createOrchestrator({
    extractor,
    writer,
    slack,
    idempotency,
    pending,
    hints,
    children,
    thresholds,
    agent,
  })

  const allowedUserIds = new Set(
    (process.env.ALLOWED_USER_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )

  const app = new Hono()

  app.get('/healthz', (c) => c.text('ok'))

  // Web demo: serve the single-page UI and its headless extract API.
  // Inject the demo calendar id so the client knows which calendar to embed.
  const webHtml = loadWebHtml().replaceAll('__DEMO_CALENDAR_ID__', demoCalendarId ?? '')
  app.get('/', (c) => c.html(webHtml))
  app.post(
    '/api/extract',
    createWebExtractHandler({
      extractor,
      children,
      thresholds,
      agent,
      hints,
      calendar,
      demoCalendarId,
    }),
  )

  app.post('/slack/events', async (c) => {
    const rawBody = await c.req.text()
    const ts = c.req.header('x-slack-request-timestamp') ?? null
    const sig = c.req.header('x-slack-signature') ?? null

    if (!verifySlackSignature(rawBody, ts, sig, slackSigningSecret)) {
      logger.warn('slack.signatureInvalid')
      return c.body(null, 401)
    }

    let payload: SlackEventCallback
    try {
      payload = JSON.parse(rawBody) as SlackEventCallback
    } catch {
      return c.body(null, 400)
    }

    if (payload.type === 'url_verification') {
      return c.json({ challenge: payload.challenge })
    }

    if (payload.event?.type === 'reaction_added') {
      const reaction = payload.event as unknown as ReactionAddedEvent
      void handleReaction(reaction, { slack, pending, writer, allowedUserIds }).catch((err) =>
        logger.error('reactions.failed', { err: String(err) }),
      )
      return c.body(null, 200)
    }

    return handleSlackEvent(c, payload, {
      slack,
      allowedUserIds,
      process: (input, eventId) => orchestrator.process(input, eventId),
    })
  })

  const port = Number(process.env.PORT ?? 8080)
  serve({ fetch: app.fetch, port }, ({ port }) => {
    logger.info('server.listening', { port })
  })
}

void bootstrap().catch((err) => {
  logger.error('server.bootstrapFailed', { err: String(err) })
  process.exit(1)
})
