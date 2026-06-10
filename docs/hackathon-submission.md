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

**Gemini's role is multimodal extraction** (`src/adapters/gemini.ts` `extract()`): a single
`generateContent` call with a JSON Schema `responseSchema`. Gemini reads the newsletter image
and/or text and returns a typed array of calendar events — each with a title, start/end datetime,
attributed family member, and confidence score — in one shot. This is the AI layer of the pipeline:
all unstructured-to-structured reasoning lives here.

The codebase also contains a general-purpose `runWithTools()` function in `src/adapters/gemini.ts`
that implements a multi-step Gemini function-calling loop (up to 10 steps, with correct
`functionCall` / `functionResponse` conversation history and per-step retry). However, the schedule
agent **no longer relies on `runWithTools` for the persist + conflict-detect workflow**. After the
refactor, persisting events to MongoDB and detecting conflicts is orchestrated deterministically in
TypeScript (see "How We Used the MongoDB MCP Server" below) — the model does not compose MongoDB
filter documents or compute epoch-millisecond timestamps.

Both `extract()` and `runWithTools()` share the same retry / back-off policy (`generateWithRetry`,
up to 3 attempts with exponential back-off) so both are equally resilient to transient Vertex AI
errors.

Cloud Run provides the serverless container runtime with scale-to-zero. Firestore holds session
state (idempotency keys and pending confirmation records) so that the agent can handle Slack
retries and out-of-order reactions correctly.

---

## How We Used the MongoDB MCP Server

MongoDB Atlas stores every family event extracted by the agent. The schedule agent accesses Atlas
through the **official `mongodb-mcp-server`** (package `mongodb-mcp-server`, spawned as a
subprocess over stdio via `@modelcontextprotocol/sdk`). The MCP tool calls are made
**deterministically from TypeScript code** — not by the LLM — making conflict detection reliable
and reproducible.

**Integration path** (`src/adapters/mcp-mongodb.ts`):

- `createMongoMcpClient` wraps `@modelcontextprotocol/sdk`'s `Client` + `StdioClientTransport`.
- The MCP server process is spawned with `MDB_MCP_CONNECTION_STRING` set to the Atlas URI (read
  from Secret Manager in production).
- `listTools()` enumerates the server's tool manifest.
- `callTool(name, args)` sends a single MCP tool call and returns the result (preferring
  `structuredContent` over raw content blocks when the server provides it).
- The adapter is lazy-connecting: the subprocess is not spawned until the first `listTools` or
  `callTool` call, so startup time is unaffected when the flag is off.

**During a typical agent run** (`src/pipeline/agent.ts`):

1. The TypeScript code converts each extracted event's start/end datetimes to numeric epoch
   milliseconds (`startMs` / `endMs`) before any database interaction.
2. The code calls the MCP `insert-many` tool directly, passing the fully-formed event documents
   (including the pre-computed `startMs`/`endMs`) to persist them in the Atlas `events` collection.
3. The code calls the MCP `find` tool with a code-built time-overlap filter:
   `{ startMs: { $lt: newEndMs }, endMs: { $gt: newStartMs } }` — the half-open interval condition
   `startMs < newEnd && endMs > newStart` — to detect existing family events that conflict with the
   newly inserted ones.
4. The agent returns a structured result `{ conflicts: [...], summary: "..." }` which the
   orchestrator uses to post conflict notes back to Slack.

The MCP tool invocations and the overlap-filter math are orchestrated in TypeScript, not by the LLM.
Gemini's job is extraction; the code's job is persistence and conflict detection. This separation
makes the conflict check deterministic and avoids the failure modes of asking a language model to
compute epoch-millisecond arithmetic and compose MongoDB filter documents under prompt pressure.

The integration satisfies the hackathon "integrate a Partner MCP server" requirement: real MCP
`find` and `insert-many` tool calls go to the official `mongodb-mcp-server` process over stdio via
`@modelcontextprotocol/sdk` on every `/api/extract` request.

---

## Judging Criteria

### Technological Implementation

The project combines three distinct integration layers:

- **Vertex AI Gemini multimodal extraction** — a single `generateContent` call with a JSON Schema
  `responseSchema` on the `@google/genai` SDK. Gemini reads the newsletter image and/or text and
  returns a typed array of calendar events with title, datetimes, family-member attribution, and
  confidence. A general-purpose `runWithTools` function-calling loop is also implemented (correct
  `functionCall` / `functionResponse` history, per-step retry, `maxSteps` cap) but is not used for
  the persist+conflict workflow.
- **MCP protocol over stdio — deterministic orchestration** — a typed adapter over
  `@modelcontextprotocol/sdk` spawns the official `mongodb-mcp-server` as a child process. The
  TypeScript schedule agent calls `insert-many` (with code-computed `startMs`/`endMs`) and `find`
  (with a code-built half-open overlap filter `startMs < newEnd && endMs > newStart`) directly from
  code. The LLM does not compose MongoDB filter documents or compute epoch-millisecond values.
- **Production-quality Node.js service** — TypeScript strict mode, Hono framework, Cloud Run
  deployment, Firestore for hot-path state, Terraform IaC, Secret Manager, 94 unit tests, and
  graceful SIGTERM shutdown that terminates the MCP subprocess cleanly.

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

The insight is that Gemini and a MongoDB MCP server are a natural fit for this problem: the
newsletter content is unstructured (requires LLM reasoning for extraction), but conflict detection
and persistence require reliable, deterministic logic. The architecture assigns each layer what it
does best — Gemini handles the multimodal extraction, while TypeScript code orchestrates the MCP
`find` and `insert-many` tool calls with pre-computed values and a precise overlap filter. This is
a genuine use of the MCP integration paradigm rather than a thin wrapper: real tool calls go to the
official `mongodb-mcp-server` over stdio on every request.

The web demo is designed explicitly so that hackathon judges can test the full pipeline — including
the live MongoDB MCP tool-call trace — without a Slack workspace, a Google Calendar, or any local
setup.

---

## Known Limitations / Next Steps

In the interest of honesty about the current state of the build:

- **Conflict detection is deterministic in code** — the schedule agent (`src/pipeline/agent.ts`)
  computes `startMs`/`endMs` in TypeScript and calls the MCP `find` tool with a code-built
  half-open overlap filter. The Gemini model is not asked to compose MongoDB query documents or
  compute epoch-millisecond values.
- **Operating model — two-branch + tagged-revision** — the MongoDB MCP feature is hackathon-scoped
  and runs behind the `ENABLE_MONGO_MCP` flag on a **separate tagged Cloud Run revision** built
  from the `feature/hackathon-mongodb-alignment` branch (PR #2). The main/production service used
  by the family runs the stable build on the `main` branch **without** MongoDB and is completely
  unaffected by this hackathon work. The tagged revision (`mcpfix---hanamaru-ogvbt3nyqa-an.a.run.app`)
  is the demo entry point for judges.
- **The `/api/extract` demo endpoint is unauthenticated** and intended for judging / demo use only.
  It is a dry-run surface (no Calendar or Firestore writes), but it would need auth before any
  non-demo exposure.
- **Schema unification** between the documents the MCP agent writes and the shape the direct
  `events-mongo` store expects (`startMs`/`endMs`/`source`/`slackEventId`/`calendarEventId`/
  `createdAt`) has been completed as part of the hackathon refactor.

---

## Links

| | |
|---|---|
| **Hosted project URL** | https://mcpfix---hanamaru-ogvbt3nyqa-an.a.run.app — tagged Cloud Run revision serving the MongoDB-MCP build; hackathon demo entry point (web UI + live MCP tool-call trace) |
| **Public repository** | https://github.com/fuzzy31u/hanamaru (License: MIT) — hackathon code on branch `feature/hackathon-mongodb-alignment` (PR #2) |
| **Demo video (≤ 3 min)** | <!-- TODO: YouTube / Vimeo URL --> |

---

## What's Next

- Push notifications via Slack when a conflict is detected so families can resolve it immediately.
- Support for LINE and other messaging platforms popular in Japan.
- Multi-language newsletter parsing (Japanese kana/kanji, PDF handling).
- Recurring-event detection (weekly club activities, monthly PTA meetings).
- A shared family dashboard built on MongoDB Charts for a visual calendar overview.
