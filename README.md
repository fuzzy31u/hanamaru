# Hanamaru 🌸

AI scheduling agent that watches Slack and writes Google Calendar entries for the family.

## What it does

Post a photo of your child's school newsletter to a Slack channel (or the web UI). Hanamaru reads
it (text + image), extracts every event, attributes each one to the right family member, detects
schedule conflicts across the whole family, and writes the events to the appropriate Google
Calendar. High-confidence extractions go straight to the calendar; ambiguous ones ask for your
confirmation in the same Slack thread.

## Key capabilities

The MongoDB integration is behind the `ENABLE_MONGO_MCP` feature flag:

- **MongoDB Atlas events store** — every extracted family event is persisted in Atlas with rich
  metadata (`source`, `startMs`/`endMs` for range queries, `calendarEventId`, etc.).
- **MongoDB MCP client** (`src/adapters/mcp-mongodb.ts`) — connects to the official
  `mongodb-mcp-server` over stdio via `@modelcontextprotocol/sdk`, exposing `find` and
  `insert-many` tools to the schedule agent.
- **Schedule agent** (`src/pipeline/agent.ts`) — orchestrates persist + conflict detection
  deterministically: TypeScript code computes `startMs`/`endMs`, calls MCP `insert-many` to
  persist events, then calls MCP `find` with a code-built half-open overlap filter
  (`startMs < newEnd && endMs > newStart`) to detect family schedule conflicts. Conflict notes are
  posted back to the Slack thread.
- **Gemini multimodal extraction** (`src/adapters/gemini.ts` `extract()`) — a single
  `generateContent` call where Gemini reads the newsletter image/text and returns structured
  calendar events (title, datetimes, family-member attribution, confidence). Gemini's role is
  extraction only; it does not compose MongoDB queries or compute epoch-millisecond values.
- **Web demo UI** (`GET /`) — paste newsletter text or upload an image, see extracted events,
  detected conflicts, and the live MongoDB MCP `find`/`insert-many` tool-call trace. Dry-run only
  (no calendar write).

## Architecture

```
Slack post (text/image)          Web demo (GET /)
         │                               │
         └─────────────┬─────────────────┘
                       ▼
              [ Orchestrator / Handler ]
                       │
          ┌────────────┴────────────────┐
          │                             │
          ▼                             ▼
 [ Vertex AI Gemini 2.5 Flash ]   [ Firestore ]
   (multimodal extraction only)   (idempotency,
          │                        confirmations,
          │  structured events     hints)
          ▼
 [ Schedule Agent (TypeScript) ]
   code computes startMs/endMs,
   builds overlap filter in code
          │
          ▼
 [ MongoDB MCP Server (stdio) ]
   find + insert-many tool calls
          │
          ▼
  [ MongoDB Atlas ]          ← family event history,
  events collection             deterministic conflict detection

          │ (confirmed events)
          ▼
  [ Google Calendar API ]    ← one calendar per child
```

The `ENABLE_MONGO_MCP` flag gates the entire Atlas / MCP path. With the flag off, the service
starts and the Slack + Calendar pipeline works normally without a MongoDB connection.

## Stack

- TypeScript + Hono on Cloud Run (asia-northeast1)
- Vertex AI Gemini 2.5 Flash — multimodal extraction (vision + structured output); persist + conflict detection is code-orchestrated, not LLM-driven
- MongoDB Atlas + official `mongodb-mcp-server` — family event history and conflict detection
- Firestore — idempotency keys, pending confirmations, attribution hints (hot-path state)
- Slack Events API
- Google Calendar API
- All auth via GCP ADC; only Slack, OAuth, and MongoDB secrets in Secret Manager

## Quickstart (local dev)

```bash
pnpm install
cp .env.example .env.local && $EDITOR .env.local

# Start Firestore emulator (separate terminal)
pnpm emulator:firestore

# Dev server with hot reload (serves web demo at http://localhost:8080)
pnpm dev

# Forward to Slack via ngrok
ngrok http 8080
```

To enable the MongoDB MCP feature locally, add to `.env.local`:

```bash
ENABLE_MONGO_MCP=true
MDB_MCP_CONNECTION_STRING=mongodb+srv://<user>:<pass>@<cluster>/
MONGO_DB_NAME=hanamaru
```

## Tests

```bash
pnpm test          # unit + integration (emulator required)
pnpm test:unit     # fast, no emulator
```

## Deployment

See `docs/operations.md` for the full runbook, including the MongoDB MCP setup steps.

## Docs

- [Design spec](docs/superpowers/specs/2026-06-06-hanamaru-design.md)
- [Implementation plan](docs/superpowers/plans/2026-06-07-hanamaru-phase1.md)
- [Operations runbook](docs/operations.md)

## License

MIT
