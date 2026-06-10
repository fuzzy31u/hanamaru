# Hanamaru — Google Cloud Rapid Agent Hackathon Submission

**Hackathon:** [Google Cloud Rapid Agent Hackathon](https://rapid-agent.devpost.com)
**Partner track:** MongoDB

---

## Elevator Pitch

Hanamaru is a family-calendar AI agent that reads a child's school newsletter (photo or text) posted to Slack or a web UI, extracts every event, attributes each event to the right family member, detects schedule conflicts, and writes them directly to Google Calendar — with no manual data entry.

---

## What It Does

Parents and caregivers constantly transcribe paper and PDF newsletters into family calendars by hand. Hanamaru eliminates that friction:

1. A parent posts a photo or text snippet of a school newsletter to Slack (or the Hanamaru web UI).
2. The agent reads the message (text + image) using Gemini's multimodal capability.
3. It extracts structured events (title, date/time, location, attendees).
4. It attributes each event to the correct family member (child, parent, etc.).
5. It checks for scheduling conflicts across the whole family using MongoDB Atlas as the event store.
6. It writes confirmed events to the appropriate Google Calendar entries.

The result: a single photo → a fully-populated family calendar in under ten seconds.

---

## How We Built It

### Google Cloud

| Component | Detail |
|---|---|
| **Compute** | Cloud Run (asia-northeast1, fully managed, scale-to-zero) |
| **AI model** | Vertex AI — **Gemini 2.5 Flash** (multimodal extraction + tool-calling agent loop) |
| **Hot-path state** | Cloud Firestore (session context, idempotency keys) |
| **Secrets** | Secret Manager (API keys, OAuth tokens) |

### MongoDB Track

| Component | Detail |
|---|---|
| **Event store** | **MongoDB Atlas** — persists all extracted family events with rich metadata |
| **Agent access** | **MongoDB MCP server** — the Gemini agent calls `find`, `aggregate`, and `insertMany` tools through the official MCP server to read existing events, detect conflicts, and persist new ones |

### Application Stack

- **Runtime:** Node.js 22 on Cloud Run
- **Framework:** Hono (lightweight HTTP framework, edge-ready)
- **Language:** TypeScript (strict mode)
- **Linter/formatter:** Biome

---

## How We Used Google Cloud + Gemini

All AI inference runs on **Vertex AI Gemini 2.5 Flash**, chosen for its large context window and native multimodal support. The agent loop is built with Gemini's tool-calling API: Gemini decides which tools to invoke (MongoDB MCP tools, Google Calendar write tool), interprets the results, and continues reasoning until the task is complete. There is no hand-written orchestration logic — the model drives the entire workflow. Cloud Run provides the serverless container runtime; Firestore holds the conversation state so that the agent can resume interrupted sessions.

This architecture satisfies the hackathon requirement: **Gemini running on Google Cloud, with Google Cloud AI tools only**.

---

## How We Used the MongoDB MCP Server

MongoDB Atlas stores every family event extracted by the agent. The Gemini agent accesses this data through the **official MongoDB MCP server** (`@mongodb-js/mongodb-mcp-server`), which exposes the Atlas cluster as a set of MCP tools.

During a typical run the agent:

1. Calls `find` to fetch existing events for the relevant family members and date range.
2. Calls `aggregate` to detect time overlaps (conflict detection pipeline).
3. Calls `insertMany` to persist the newly extracted events once conflicts are resolved.

Using an MCP server rather than a bespoke SDK integration means the agent can reason about the database in natural language through structured tool calls — no custom query-builder code required. This satisfies the hackathon requirement: **integrate a Partner MCP server**.

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
