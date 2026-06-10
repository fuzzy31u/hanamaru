# Hanamaru — Google Cloud Rapid Agent Hackathon Submission

**Hackathon:** [Google Cloud Rapid Agent Hackathon](https://rapid-agent.devpost.com)
**Partner track:** MongoDB

---

## Elevator Pitch

Hanamaru is a family-calendar AI agent that reads a child's school newsletter (photo or text)
posted to Slack or a web UI, extracts every event, attributes each event to the right family
member, detects schedule conflicts across the whole family, and writes them directly to Google
Calendar — with no manual data entry.

---

## What It Does

Parents and caregivers constantly transcribe paper and PDF newsletters into family calendars by
hand. Hanamaru eliminates that friction:

1. A parent posts a photo or text snippet of a school newsletter to Slack (or the Hanamaru web UI).
2. The agent reads the message (text + image) using Gemini's multimodal capability.
3. It extracts structured events (title, date/time, location, attendees).
4. It attributes each event to the correct family member (child, parent, etc.).
5. It persists the new events in MongoDB Atlas and checks for scheduling conflicts across the whole
   family using the MongoDB MCP server.
6. It writes confirmed events to the appropriate Google Calendar entries.
7. If conflicts are found, a note is posted back to the Slack thread.

The result: a single photo → a fully-populated family calendar in under ten seconds.

---

## How We Built It

### Google Cloud

| Component | Detail |
|---|---|
| **Compute** | Cloud Run (asia-northeast1, fully managed, scale-to-zero) |
| **AI model** | Vertex AI — **Gemini 2.5 Flash** (multimodal extraction + tool-calling agent loop) |
| **Hot-path state** | Cloud Firestore (idempotency keys, pending confirmations, attribution hints) |
| **Secrets** | Secret Manager (Slack keys, OAuth tokens, MongoDB connection string) |
| **IaC** | Terraform manages all Cloud Run, Firestore, Secret Manager, and IAM resources |

### MongoDB Track

| Component | Detail |
|---|---|
| **Event store** | **MongoDB Atlas** — persists all extracted family events with rich metadata (`source`, `slackEventId`, `calendarEventId`, numeric `startMs`/`endMs` for range queries) |
| **Agent access** | **Official `mongodb-mcp-server`** — the Gemini agent calls `find`, `aggregate`, `count`, and `insert-many` tools through the MCP server over stdio, with no bespoke MongoDB SDK code in the agent layer |

### Application Stack

- **Runtime:** Node.js 22 on Cloud Run
- **Framework:** Hono (lightweight, edge-ready HTTP framework)
- **Language:** TypeScript (strict mode)
- **Linter/formatter:** Biome
- **Tests:** 94 unit tests (Vitest)

### Feature Flag

The entire MongoDB / MCP path is gated behind the `ENABLE_MONGO_MCP` environment variable.
When the flag is off, the Slack pipeline and Google Calendar writes work normally with no
MongoDB dependency. This lets us ship the feature without risk to the production calendar flow.

---

## How We Used Google Cloud + Gemini

All AI inference runs on **Vertex AI Gemini 2.5 Flash**, chosen for its large context window,
native multimodal (vision) support, and function-calling capability.

**Two distinct Gemini usage patterns exist in the codebase:**

1. **Structured extraction** (`src/adapters/gemini.ts` `extract()`): a single `generateContent`
   call with a JSON Schema `responseSchema`. Gemini reads the newsletter image and/or text and
   returns a typed array of calendar events in one shot.

2. **Tool-calling agent loop** (`src/adapters/gemini.ts` `runWithTools()`): a multi-step loop
   where Gemini is given the MongoDB MCP tool declarations (`find`, `aggregate`, `count`,
   `insert-many`) and a system instruction describing the task. In each step, Gemini either calls
   one or more tools (the code dispatches them through the MCP client, feeds results back as
   `functionResponse` parts, and continues) or returns a final text answer. The loop runs for up
   to 10 steps. There is no hand-written orchestration logic — the model drives the entire
   persist + conflict-detect workflow.

Both patterns share the same retry/back-off policy (`generateWithRetry`, up to 3 attempts with
exponential back-off) so both are equally resilient to transient Vertex AI errors.

Cloud Run provides the serverless container runtime with scale-to-zero. Firestore holds session
state (idempotency keys and pending confirmation records) so that the agent can handle Slack
retries and out-of-order reactions correctly.

---

## How We Used the MongoDB MCP Server

MongoDB Atlas stores every family event extracted by the agent. The Gemini agent accesses this
data through the **official `mongodb-mcp-server`** (package `mongodb-mcp-server`, spawned as a
subprocess over stdio via `@modelcontextprotocol/sdk`).

**Integration path** (`src/adapters/mcp-mongodb.ts`):

- `createMongoMcpClient` wraps `@modelcontextprotocol/sdk`'s `Client` + `StdioClientTransport`.
- The MCP server process is spawned with `MDB_MCP_CONNECTION_STRING` set to the Atlas URI (read
  from Secret Manager in production).
- `listTools()` enumerates the server's tool manifest; the schedule agent filters to the four it
  needs: `find`, `aggregate`, `count`, `insert-many`.
- `callTool(name, args)` sends a single MCP tool call and returns the result (preferring
  `structuredContent` over raw content blocks when the server provides it).
- The adapter is lazy-connecting: the subprocess is not spawned until the first `listTools` or
  `callTool` call, so startup time is unaffected when the flag is off.

**During a typical agent run** (`src/pipeline/agent.ts`):

1. Gemini calls `insert-many` to persist the newly extracted events into the `events` collection,
   adding numeric `startMs` / `endMs` fields for efficient range queries.
2. Gemini calls `find` or `aggregate` with a time-overlap filter to detect existing family events
   that conflict with the new ones (`existing.startMs < new.endMs AND existing.endMs > new.startMs`).
3. Gemini calls `count` if it needs to verify totals before deciding whether to continue.
4. The agent returns a structured JSON answer `{"conflicts":[...],"summary":"..."}` which the
   orchestrator uses to post conflict notes back to Slack.

Using an MCP server rather than a bespoke SDK integration means the agent can reason about the
database schema and query structure in natural language through structured tool calls — Gemini
composes the filter documents itself, guided only by the system instruction and the tool's JSON
Schema parameters.

---

## Judging Criteria

### Technological Implementation

The project combines three distinct integration layers:

- **Vertex AI Gemini function-calling** — a full multi-step tool-calling loop implemented from
  scratch on top of the `@google/genai` SDK, with correct `functionCall` / `functionResponse`
  conversation history management and per-step retry.
- **MCP protocol over stdio** — a typed adapter over `@modelcontextprotocol/sdk` that spawns
  the official `mongodb-mcp-server` as a child process, lists its tools, and dispatches calls
  without any hard-coded MongoDB query code in the agent layer.
- **Production-quality Node.js service** — TypeScript strict mode, Hono framework, Cloud Run
  deployment, Firestore for hot-path state, Terraform IaC, Secret Manager, 94 unit tests, and
  graceful SIGTERM shutdown that terminates the MCP subprocess cleanly.

The Gemini tool-calling loop (`runWithTools`) feeds `functionResponse` parts back into the
conversation for each MCP result, handles dispatch errors without aborting the loop (the error
is fed back to the model so it can recover), and caps iteration at `maxSteps` to prevent runaway
usage.

### Design

The system is designed around two principles: **non-blocking** and **graceful degradation**.

- The `ENABLE_MONGO_MCP` feature flag lets the MongoDB path be toggled at runtime via a Cloud Run
  environment variable with zero code changes. A misconfigured connection string when the flag is
  off cannot break the boot sequence.
- The schedule agent (`createScheduleAgent`) never throws: it logs a warning and returns empty
  conflicts on any MCP or Gemini failure, so the Google Calendar write always completes even if
  the Atlas layer is unavailable.
- The web demo (`GET /`, `POST /api/extract`) is a **dry-run surface**: it runs the full Gemini
  extraction + MCP agent pipeline and returns the tool-call trace as JSON, but never writes to
  Google Calendar or Firestore. This makes it safe to expose publicly for judge evaluation.
- Firestore separates hot-path operational state (idempotency, pending confirmations) from the
  analytical event history in MongoDB Atlas — each store is used for what it is best at.

### Potential Impact

The core pain point is universal: millions of families with school-age children receive paper or
PDF newsletters every week and manually copy events into digital calendars. Hanamaru eliminates
that friction for the Slack-native household today, and the architecture is straightforward to
extend:

- **LINE / other platforms** — the `Extractor` and `ScheduleAgent` are platform-agnostic; only
  the Slack handler layer is platform-specific.
- **Multi-language** — Gemini 2.5 Flash handles Japanese kana/kanji natively; the extraction
  system instruction is already Japanese-first.
- **Family dashboard** — MongoDB Atlas is the natural foundation for a MongoDB Charts or custom
  React dashboard showing the whole family's calendar in one view.
- **Push notifications** — the conflict data returned by the agent is already structured; posting
  it to Slack is one use; push notifications are a straightforward next step.
- **Recurring-event detection** — Atlas aggregation pipelines can surface weekly or monthly
  patterns from the stored `events` collection with no schema changes.

### Quality of Idea

The insight is that a Gemini function-calling agent and a MongoDB MCP server are a natural fit for
this problem: the newsletter content is unstructured (requires LLM reasoning), but the conflict
detection and persistence require reliable, queryable storage. Rather than embedding MongoDB query
logic inside the prompt, exposing Atlas as MCP tools lets the model compose queries itself — a
genuine use of the agentic paradigm rather than a thin wrapper.

The web demo is designed explicitly so that hackathon judges can test the full pipeline — including
the live MongoDB MCP tool-call trace — without a Slack workspace, a Google Calendar, or any local
setup.

---

## Known Limitations / Next Steps

In the interest of honesty about the current state of the build:

- **Conflict detection relies on the LLM agent** honoring the MongoDB MCP tool
  instructions (the Gemini loop composes and runs the overlap queries itself). The
  deterministic direct-driver `events-mongo` store (`src/stores/events-mongo.ts`) is
  tested groundwork for a more reliable Phase-2 path, but is not yet wired into the
  runtime.
- **The `/api/extract` demo endpoint is unauthenticated** and intended for judging /
  demo use only. It is a dry-run surface (no Calendar or Firestore writes), but it
  would need auth before any non-demo exposure.
- **Schema unification is pending** between the documents the MCP agent writes and the
  shape the direct `events-mongo` store expects
  (`startMs`/`endMs`/`source`/`slackEventId`/`calendarEventId`/`createdAt`). These must
  be reconciled before the deterministic store is activated.

---

## Links

| | |
|---|---|
| **Hosted project URL** | <!-- TODO: Cloud Run URL --> |
| **Public repository** | <!-- TODO: GitHub URL --> (License: MIT) |
| **Demo video (≤ 3 min)** | <!-- TODO: YouTube / Vimeo URL --> |

---

## What's Next

- Push notifications via Slack when a conflict is detected so families can resolve it immediately.
- Support for LINE and other messaging platforms popular in Japan.
- Multi-language newsletter parsing (Japanese kana/kanji, PDF handling).
- Recurring-event detection (weekly club activities, monthly PTA meetings).
- A shared family dashboard built on MongoDB Charts for a visual calendar overview.
