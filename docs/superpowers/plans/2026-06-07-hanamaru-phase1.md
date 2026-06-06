# Hanamaru Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Slack 投稿（テキスト + 画像）から AI が家族の予定を抽出し、適切な Google Calendar に自動登録する、Cloud Run 上のエージェントを完成させる。

**Architecture:** TypeScript + Hono on Cloud Run + Firestore (asia-northeast1)。Vertex AI 上の Gemini 2.5 Flash で controlled generation による構造化抽出。Slack webhook を即時 ack し、後段で非同期処理。Secret Manager と ADC で認証を一元化。

**Tech Stack:** Node.js 22 / TypeScript 5 / pnpm / Hono / Vitest / Biome / Firestore Native / Vertex AI Node SDK (`@google/genai`) / `@slack/web-api` / `googleapis` / Terraform / GitHub Actions / Docker.

**Spec reference:** `docs/superpowers/specs/2026-06-06-hanamaru-design.md`

---

## File Map

このプランで作成・修正する全ファイル：

```
hanamaru/
├── package.json                                  # Task 1
├── pnpm-workspace.yaml                           # Task 1
├── tsconfig.json                                 # Task 1
├── vitest.config.ts                              # Task 1
├── biome.json                                    # Task 2
├── Dockerfile                                    # Task 3
├── .dockerignore                                 # Task 3
├── .env.example                                  # Task 4
├── .gitignore                                    # (already exists, updated Task 4)
├── src/
│   ├── server.ts                                 # Task 27
│   ├── handlers/
│   │   ├── slack-events.ts                       # Task 25
│   │   └── slack-reactions.ts                    # Task 26
│   ├── pipeline/
│   │   ├── orchestrator.ts                       # Task 23
│   │   ├── extractor.ts                          # Task 20
│   │   ├── attributor.ts                         # Task 8
│   │   ├── confidence.ts                         # Task 9
│   │   ├── prefix-parser.ts                      # Task 7
│   │   ├── calendar-writer.ts                    # Task 21
│   │   └── replier.ts                            # Task 22
│   ├── stores/
│   │   ├── firestore-client.ts                   # Task 16
│   │   ├── idempotency.ts                        # Task 17
│   │   ├── pending.ts                            # Task 18
│   │   └── attribution-hints.ts                  # Task 19
│   ├── adapters/
│   │   ├── secrets.ts                            # Task 12
│   │   ├── gemini.ts                             # Task 13
│   │   ├── google-calendar.ts                    # Task 14
│   │   └── slack.ts                              # Task 15
│   ├── config/
│   │   ├── children.ts                           # Task 6
│   │   ├── schema.ts                             # Task 5
│   │   └── thresholds.ts                         # Task 9
│   └── lib/
│       ├── logger.ts                             # Task 10
│       ├── errors.ts                             # Task 11
│       └── slack-signature.ts                    # Task 24
├── tests/
│   ├── unit/
│   │   ├── prefix-parser.test.ts                 # Task 7
│   │   ├── attributor.test.ts                    # Task 8
│   │   ├── confidence.test.ts                    # Task 9
│   │   ├── children.test.ts                      # Task 6
│   │   ├── replier.test.ts                       # Task 22
│   │   └── slack-signature.test.ts               # Task 24
│   ├── integration/
│   │   ├── idempotency.test.ts                   # Task 17
│   │   ├── pending.test.ts                       # Task 18
│   │   ├── attribution-hints.test.ts             # Task 19
│   │   └── orchestrator.test.ts                  # Task 23
│   └── fixtures/
│       ├── slack-events/                         # Task 25 onwards
│       └── gemini-responses/                     # Task 20 onwards
├── scripts/
│   ├── auth-google.ts                            # Task 32
│   ├── seed-config.ts                            # Task 33
│   └── deploy.sh                                 # Task 30
├── infra/
│   ├── terraform/                                # Task 28
│   │   ├── main.tf
│   │   ├── variables.tf
│   │   └── outputs.tf
│   └── slack-manifest.yaml                       # Task 31
├── .github/
│   └── workflows/
│       ├── ci.yml                                # Task 29
│       └── deploy.yml                            # Task 30
├── README.md                                     # Task 34
└── docs/
    └── operations.md                             # Task 35
```

**Build order (bottom-up, TDD where applicable):**

1. **Scaffolding** (Tasks 1-4): プロジェクト基盤
2. **Pure logic** (Tasks 5-9): スキーマと純粋関数（外部依存なし）
3. **Utilities** (Tasks 10-12): logger / errors / Secret Manager
4. **External adapters** (Tasks 13-15): Gemini / Calendar / Slack（モックでテスト）
5. **Stores** (Tasks 16-19): Firestore Emulator でテスト
6. **Pipeline** (Tasks 20-23): 統合ロジック
7. **Handlers + Server** (Tasks 24-27): HTTP 入り口
8. **Infrastructure** (Tasks 28-30): Terraform + CI/CD
9. **Scripts + Docs** (Tasks 31-35): 運用補助

**Milestone checkpoints:**

- After Task 9: 純粋ロジックがテスト済み（コミットでチェックポイント）
- After Task 19: 外部 I/O 層がテスト済み
- After Task 23: パイプラインがエンドツーエンドでテスト済み（モック使用）
- After Task 27: ローカル ngrok 経由で Slack に接続可能
- After Task 30: dev 環境にデプロイ可能
- After Task 35: 本番運用準備完了

---

## Task 1: TypeScript プロジェクトの初期化

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`

- [ ] **Step 1: pnpm プロジェクトを初期化**

```bash
cd /Users/a11621/Documents/development/hanamaru
pnpm init
```

これで `package.json` の雛形ができる。次のステップで上書きする。

- [ ] **Step 2: `package.json` を上書き**

```json
{
  "name": "hanamaru",
  "version": "0.1.0",
  "description": "AI scheduling agent that watches Slack and writes Google Calendar entries for the family",
  "type": "module",
  "private": true,
  "packageManager": "pnpm@9.0.0",
  "engines": {
    "node": ">=22.0.0"
  },
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc --noEmit && tsup src/server.ts --format esm --target node22 --out-dir dist",
    "start": "node dist/server.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:unit": "vitest run tests/unit",
    "test:integration": "vitest run tests/integration",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "format": "biome format --write .",
    "emulator:firestore": "gcloud beta emulators firestore start --host-port=localhost:8085"
  },
  "dependencies": {
    "@google-cloud/firestore": "^7.10.0",
    "@google-cloud/secret-manager": "^5.6.0",
    "@google/genai": "^0.3.0",
    "@hono/node-server": "^1.13.0",
    "@slack/web-api": "^7.7.0",
    "googleapis": "^144.0.0",
    "hono": "^4.6.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.0",
    "@types/node": "^22.7.0",
    "tsup": "^8.3.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 3: pnpm install で依存をインストール**

```bash
pnpm install
```

Expected: `node_modules/` が作成され、`pnpm-lock.yaml` が生成される。

- [ ] **Step 4: `tsconfig.json` を作成**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "resolveJsonModule": true,
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": false,
    "outDir": "dist",
    "rootDir": ".",
    "baseUrl": ".",
    "paths": {
      "~/*": ["src/*"]
    }
  },
  "include": ["src/**/*", "tests/**/*", "scripts/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 5: `vitest.config.ts` を作成**

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
    },
  },
  resolve: {
    alias: {
      '~': new URL('./src', import.meta.url).pathname,
    },
  },
})
```

- [ ] **Step 6: typecheck が通ることを確認**

```bash
pnpm typecheck
```

Expected: no output (success).

- [ ] **Step 7: コミット**

```bash
git add package.json pnpm-lock.yaml tsconfig.json vitest.config.ts
git commit -m "chore: initialize TypeScript project with Vitest"
```

---

## Task 2: Biome（lint + format）の設定

**Files:**
- Create: `biome.json`

- [ ] **Step 1: `biome.json` を作成**

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.0/schema.json",
  "vcs": {
    "enabled": true,
    "clientKind": "git",
    "useIgnoreFile": true
  },
  "files": {
    "ignoreUnknown": true,
    "ignore": ["dist", "node_modules", "*.log"]
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "single",
      "semicolons": "asNeeded",
      "trailingCommas": "all"
    }
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "style": {
        "noNonNullAssertion": "off"
      }
    }
  },
  "organizeImports": {
    "enabled": true
  }
}
```

- [ ] **Step 2: lint が通ることを確認**

```bash
pnpm lint
```

Expected: `Checked 0 files in...` (まだソースがない)

- [ ] **Step 3: コミット**

```bash
git add biome.json
git commit -m "chore: configure Biome for linting and formatting"
```

---

## Task 3: Dockerfile と Cloud Run 用設定

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`

- [ ] **Step 1: `Dockerfile` を作成（multi-stage build）**

```dockerfile
# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS builder
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=builder /app/dist ./dist
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["node", "dist/server.js"]
```

- [ ] **Step 2: `.dockerignore` を作成**

```
node_modules
dist
.git
.github
tests
docs
infra
scripts
*.log
.env*
!.env.example
```

- [ ] **Step 3: コミット**

```bash
git add Dockerfile .dockerignore
git commit -m "chore: add Dockerfile for Cloud Run deployment"
```

---

## Task 4: 環境変数のテンプレートと .gitignore の更新

**Files:**
- Create: `.env.example`
- Modify: `.gitignore`

- [ ] **Step 1: `.env.example` を作成（プレースホルダー）**

```bash
# GCP
GCP_PROJECT_ID=hanamaru-dev
GCP_REGION=asia-northeast1
FIRESTORE_DATABASE=(default)
FIRESTORE_EMULATOR_HOST=localhost:8085

# Slack
SLACK_SIGNING_SECRET=
SLACK_BOT_TOKEN=
SLACK_ADMIN_USER_ID=U00000000
ALLOWED_USER_IDS=U00000000

# Google Calendar
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
GOOGLE_CALENDAR_REFRESH_TOKEN=

# Family identifiers (匿名 ID で管理、実名は別 env)
CHILD1_NAME=
CHILD1_CALENDAR_ID=
CHILD1_SCHOOL=
CHILD1_JUKU=
CHILD2_NAME=
CHILD2_CALENDAR_ID=
CHILD2_SCHOOL=
CHILD2_JUKU=
CHILD3_NAME=
CHILD3_CALENDAR_ID=
CHILD3_DAYCARE=
SELF_CALENDAR_ID=

# AI
GEMINI_MODEL=gemini-2.5-flash
GEMINI_LOCATION=asia-northeast1

# Confidence thresholds (override possible via Firestore)
CONFIDENCE_THRESHOLD_ATTRIBUTION=0.8
CONFIDENCE_THRESHOLD_DATETIME=0.8
```

- [ ] **Step 2: 既存の `.gitignore` を確認**

```bash
cat .gitignore
```

Expected output (already exists from earlier commit):
```
node_modules/
dist/
.env
.env.*
!.env.example
tests/fixtures/private/
*.log
.DS_Store
```

すでに `.env.example` 以外の .env を除外しているので追加変更なし。

- [ ] **Step 3: コミット**

```bash
git add .env.example
git commit -m "chore: add .env.example with all required environment variables"
```

---

## Task 5: Zod スキーマの定義

**Files:**
- Create: `src/config/schema.ts`

- [ ] **Step 1: ディレクトリを作成**

```bash
mkdir -p src/config src/lib src/adapters src/pipeline src/stores src/handlers tests/unit tests/integration tests/fixtures
```

- [ ] **Step 2: `src/config/schema.ts` を作成**

```ts
import { z } from 'zod'

/** 家族メンバーの匿名 ID。コード上の識別子で実名は紐づけない。 */
export const ChildId = z.enum(['child1', 'child2', 'child3', 'self', 'unknown'])
export type ChildId = z.infer<typeof ChildId>

/** Gemini が返す 1 件の予定 */
export const ExtractedEvent = z.object({
  title: z.string().min(1),
  startAt: z.string().datetime(),
  endAt: z.string().datetime().nullable(),
  allDay: z.boolean(),
  location: z.string().nullable(),
  description: z.string().nullable(),
  attributedTo: ChildId,
  attributionConfidence: z.number().min(0).max(1),
  datetimeConfidence: z.number().min(0).max(1),
  rawExcerpt: z.string(),
})
export type ExtractedEvent = z.infer<typeof ExtractedEvent>

/** Gemini のレスポンス全体 */
export const ExtractionResponse = z.object({
  events: z.array(ExtractedEvent),
  summary: z.string(),
})
export type ExtractionResponse = z.infer<typeof ExtractionResponse>

/** prefix のモード */
export const PrefixMode = z.enum(['force-ask', 'force-auto'])
export type PrefixMode = z.infer<typeof PrefixMode>

/** prefix パース結果 */
export const PrefixParseResult = z.object({
  prefixHint: ChildId.exclude(['unknown']).nullable(),
  modeHint: PrefixMode.nullable(),
  remainingText: z.string(),
})
export type PrefixParseResult = z.infer<typeof PrefixParseResult>

/** パイプラインへの入力 */
export const ExtractionInput = z.object({
  postedAt: z.string().datetime(),
  authorUserId: z.string(),
  channelId: z.string(),
  threadTs: z.string(),
  text: z.string(),
  prefixHint: ChildId.exclude(['unknown']).nullable(),
  modeHint: PrefixMode.nullable(),
  images: z.array(z.object({
    base64: z.string(),
    mimeType: z.string(),
  })),
})
export type ExtractionInput = z.infer<typeof ExtractionInput>
```

- [ ] **Step 3: typecheck**

```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 4: コミット**

```bash
git add src/config/schema.ts
git commit -m "feat(schema): define Zod schemas for events, prefixes, and pipeline input"
```

---

## Task 6: 子の設定（CHILDREN）

**Files:**
- Create: `src/config/children.ts`
- Create: `tests/unit/children.test.ts`

- [ ] **Step 1: `tests/unit/children.test.ts` を先に書く**

```ts
import { describe, expect, it } from 'vitest'
import { buildChildren, lookupChildByContext } from '~/config/children'

describe('children config', () => {
  const env = {
    CHILD1_NAME: 'Alice',
    CHILD1_CALENDAR_ID: 'cal1@group.calendar.google.com',
    CHILD1_SCHOOL: '東京小学校',
    CHILD1_JUKU: 'SAPIX',
    CHILD2_NAME: 'Bob',
    CHILD2_CALENDAR_ID: 'cal2@group.calendar.google.com',
    CHILD2_SCHOOL: '東京小学校',
    CHILD2_JUKU: '早稲田アカデミー',
    CHILD3_NAME: 'Carol',
    CHILD3_CALENDAR_ID: 'cal3@group.calendar.google.com',
    CHILD3_DAYCARE: '○○保育園',
    SELF_CALENDAR_ID: 'self@gmail.com',
  }

  it('builds CHILDREN map with labels and calendar IDs from env', () => {
    const c = buildChildren(env)
    expect(c.child1.label).toBe('長女')
    expect(c.child1.calendarId).toBe('cal1@group.calendar.google.com')
    expect(c.child2.label).toBe('長男')
    expect(c.child3.label).toBe('末っ子')
    expect(c.self.label).toBe('自分')
    expect(c.self.calendarId).toBe('self@gmail.com')
  })

  it('includes aliases and contexts for matching', () => {
    const c = buildChildren(env)
    expect(c.child1.aliases).toContain('長女')
    expect(c.child1.aliases).toContain('Alice')
    expect(c.child1.contexts).toContain('東京小学校')
    expect(c.child1.contexts).toContain('SAPIX')
  })

  it('looks up child by exact context match', () => {
    const c = buildChildren(env)
    expect(lookupChildByContext('早稲田アカデミーから連絡', c)).toBe('child2')
    expect(lookupChildByContext('○○保育園のお知らせ', c)).toBe('child3')
  })

  it('returns null when no context matches', () => {
    const c = buildChildren(env)
    expect(lookupChildByContext('近所のスーパーで安売り', c)).toBeNull()
  })

  it('throws when required env var is missing', () => {
    expect(() => buildChildren({ ...env, CHILD1_CALENDAR_ID: '' })).toThrow(/CHILD1_CALENDAR_ID/)
  })
})
```

- [ ] **Step 2: テストを実行して FAIL を確認**

```bash
pnpm test:unit tests/unit/children.test.ts
```

Expected: FAIL with `Failed to resolve import "~/config/children"`.

- [ ] **Step 3: `src/config/children.ts` を実装**

```ts
import type { ChildId } from '~/config/schema'

export type ChildEntry = {
  label: string
  calendarId: string
  aliases: readonly string[]
  contexts: readonly string[]
}

export type ChildrenMap = {
  child1: ChildEntry
  child2: ChildEntry
  child3: ChildEntry
  self: ChildEntry
}

type Env = Record<string, string | undefined>

function requireEnv(env: Env, key: string): string {
  const value = env[key]
  if (!value) throw new Error(`Required env var missing: ${key}`)
  return value
}

function optionalEnv(env: Env, key: string): string | undefined {
  return env[key] || undefined
}

export function buildChildren(env: Env): ChildrenMap {
  const c1Name = optionalEnv(env, 'CHILD1_NAME')
  const c2Name = optionalEnv(env, 'CHILD2_NAME')
  const c3Name = optionalEnv(env, 'CHILD3_NAME')

  return {
    child1: {
      label: '長女',
      calendarId: requireEnv(env, 'CHILD1_CALENDAR_ID'),
      aliases: ['長女', '姉', ...(c1Name ? [c1Name] : [])],
      contexts: [
        optionalEnv(env, 'CHILD1_SCHOOL'),
        optionalEnv(env, 'CHILD1_JUKU'),
      ].filter((s): s is string => Boolean(s)),
    },
    child2: {
      label: '長男',
      calendarId: requireEnv(env, 'CHILD2_CALENDAR_ID'),
      aliases: ['長男', '兄', ...(c2Name ? [c2Name] : [])],
      contexts: [
        optionalEnv(env, 'CHILD2_SCHOOL'),
        optionalEnv(env, 'CHILD2_JUKU'),
      ].filter((s): s is string => Boolean(s)),
    },
    child3: {
      label: '末っ子',
      calendarId: requireEnv(env, 'CHILD3_CALENDAR_ID'),
      aliases: ['末っ子', '末', ...(c3Name ? [c3Name] : [])],
      contexts: [optionalEnv(env, 'CHILD3_DAYCARE')].filter((s): s is string => Boolean(s)),
    },
    self: {
      label: '自分',
      calendarId: requireEnv(env, 'SELF_CALENDAR_ID'),
      aliases: ['自分', '私', '俺'],
      contexts: [],
    },
  }
}

export function lookupChildByContext(
  text: string,
  children: ChildrenMap,
): Exclude<ChildId, 'unknown'> | null {
  const entries: Array<[Exclude<ChildId, 'unknown'>, ChildEntry]> = [
    ['child1', children.child1],
    ['child2', children.child2],
    ['child3', children.child3],
    ['self', children.self],
  ]
  for (const [id, entry] of entries) {
    for (const ctx of entry.contexts) {
      if (text.includes(ctx)) return id
    }
  }
  return null
}
```

- [ ] **Step 4: テストを実行して PASS を確認**

```bash
pnpm test:unit tests/unit/children.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 5: コミット**

```bash
git add src/config/children.ts tests/unit/children.test.ts
git commit -m "feat(config): add CHILDREN map with env-driven aliases and context lookup"
```

---

## Task 7: Prefix Parser

**Files:**
- Create: `src/pipeline/prefix-parser.ts`
- Create: `tests/unit/prefix-parser.test.ts`

- [ ] **Step 1: `tests/unit/prefix-parser.test.ts` を書く**

```ts
import { describe, expect, it } from 'vitest'
import { parsePrefix } from '~/pipeline/prefix-parser'

describe('parsePrefix', () => {
  it('returns null prefix when no marker present', () => {
    const r = parsePrefix('来週の遠足について')
    expect(r.prefixHint).toBeNull()
    expect(r.modeHint).toBeNull()
    expect(r.remainingText).toBe('来週の遠足について')
  })

  it('parses #長女 prefix to child1', () => {
    const r = parsePrefix('#長女 来週の発表会')
    expect(r.prefixHint).toBe('child1')
    expect(r.modeHint).toBeNull()
    expect(r.remainingText).toBe('来週の発表会')
  })

  it('parses #長男 prefix to child2', () => {
    const r = parsePrefix('#長男 塾の保護者会')
    expect(r.prefixHint).toBe('child2')
  })

  it('parses #末っ子 prefix to child3', () => {
    const r = parsePrefix('#末っ子 検診')
    expect(r.prefixHint).toBe('child3')
  })

  it('parses #自分 prefix to self', () => {
    const r = parsePrefix('#自分 出張')
    expect(r.prefixHint).toBe('self')
  })

  it('parses #? as force-ask mode', () => {
    const r = parsePrefix('#? 来月どこかで発表会')
    expect(r.modeHint).toBe('force-ask')
    expect(r.prefixHint).toBeNull()
    expect(r.remainingText).toBe('来月どこかで発表会')
  })

  it('parses #!! as force-auto mode', () => {
    const r = parsePrefix('#!! 6/10 14:00 ピアノ')
    expect(r.modeHint).toBe('force-auto')
  })

  it('combines child prefix with mode prefix', () => {
    const r = parsePrefix('#長女 #? 来週どこか')
    expect(r.prefixHint).toBe('child1')
    expect(r.modeHint).toBe('force-ask')
    expect(r.remainingText).toBe('来週どこか')
  })

  it('ignores hashtags after non-prefix text', () => {
    const r = parsePrefix('明日 #ピアノ 発表会')
    expect(r.prefixHint).toBeNull()
    expect(r.modeHint).toBeNull()
    expect(r.remainingText).toBe('明日 #ピアノ 発表会')
  })

  it('handles only-prefix message (no body)', () => {
    const r = parsePrefix('#長男')
    expect(r.prefixHint).toBe('child2')
    expect(r.remainingText).toBe('')
  })

  it('preserves order when child comes after mode prefix', () => {
    const r = parsePrefix('#!! #末っ子 6/10 検診')
    expect(r.modeHint).toBe('force-auto')
    expect(r.prefixHint).toBe('child3')
  })
})
```

- [ ] **Step 2: テストを実行して FAIL を確認**

```bash
pnpm test:unit tests/unit/prefix-parser.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: `src/pipeline/prefix-parser.ts` を実装**

```ts
import type { PrefixMode, PrefixParseResult } from '~/config/schema'
import type { ChildId } from '~/config/schema'

const CHILD_PREFIX_MAP: Record<string, Exclude<ChildId, 'unknown'>> = {
  '長女': 'child1',
  '長男': 'child2',
  '末っ子': 'child3',
  '自分': 'self',
}

const MODE_PREFIX_MAP: Record<string, PrefixMode> = {
  '?': 'force-ask',
  '!!': 'force-auto',
}

const PREFIX_TOKEN = /^#(長女|長男|末っ子|自分|\?|!!)(\s+|$)/

export function parsePrefix(text: string): PrefixParseResult {
  let prefixHint: Exclude<ChildId, 'unknown'> | null = null
  let modeHint: PrefixMode | null = null
  let remaining = text

  while (true) {
    const match = remaining.match(PREFIX_TOKEN)
    if (!match) break

    const token = match[1]!
    if (token in CHILD_PREFIX_MAP) {
      if (prefixHint === null) prefixHint = CHILD_PREFIX_MAP[token]!
    } else if (token in MODE_PREFIX_MAP) {
      if (modeHint === null) modeHint = MODE_PREFIX_MAP[token]!
    }
    remaining = remaining.slice(match[0].length)
  }

  return {
    prefixHint,
    modeHint,
    remainingText: remaining.trim() === '' ? remaining.trim() : remaining,
  }
}
```

- [ ] **Step 4: テスト PASS を確認**

```bash
pnpm test:unit tests/unit/prefix-parser.test.ts
```

Expected: 11 tests pass.

- [ ] **Step 5: コミット**

```bash
git add src/pipeline/prefix-parser.ts tests/unit/prefix-parser.test.ts
git commit -m "feat(pipeline): add prefix parser for #child and mode hints"
```

---

## Task 8: Attributor（属性決定ロジック）

**Files:**
- Create: `src/pipeline/attributor.ts`
- Create: `tests/unit/attributor.test.ts`

- [ ] **Step 1: `tests/unit/attributor.test.ts` を書く**

```ts
import { describe, expect, it } from 'vitest'
import { attributeEvents } from '~/pipeline/attributor'
import type { ExtractedEvent } from '~/config/schema'

const baseEvent: ExtractedEvent = {
  title: 'テスト',
  startAt: '2026-06-10T09:00:00+09:00',
  endAt: null,
  allDay: false,
  location: null,
  description: null,
  attributedTo: 'unknown',
  attributionConfidence: 0.2,
  datetimeConfidence: 1.0,
  rawExcerpt: '...',
}

describe('attributeEvents', () => {
  it('overrides AI judgement when prefix is given', () => {
    const events = [{ ...baseEvent, attributedTo: 'child1' as const, attributionConfidence: 0.5 }]
    const result = attributeEvents(events, { prefixHint: 'child3', hintsLookup: () => null })
    expect(result[0]?.attributedTo).toBe('child3')
    expect(result[0]?.attributionConfidence).toBe(1.0)
  })

  it('keeps AI judgement when no prefix and confidence is high', () => {
    const events = [{ ...baseEvent, attributedTo: 'child2' as const, attributionConfidence: 0.9 }]
    const result = attributeEvents(events, { prefixHint: null, hintsLookup: () => null })
    expect(result[0]?.attributedTo).toBe('child2')
    expect(result[0]?.attributionConfidence).toBe(0.9)
  })

  it('uses hints lookup when AI says unknown and hint matches', () => {
    const events = [{ ...baseEvent, attributedTo: 'unknown' as const, rawExcerpt: 'ピアノ教室' }]
    const result = attributeEvents(events, {
      prefixHint: null,
      hintsLookup: (text) => (text.includes('ピアノ') ? 'child2' : null),
    })
    expect(result[0]?.attributedTo).toBe('child2')
    expect(result[0]?.attributionConfidence).toBeGreaterThan(0.7)
  })

  it('uses hints lookup when AI confidence is low', () => {
    const events = [{ ...baseEvent, attributedTo: 'child1' as const, attributionConfidence: 0.3, rawExcerpt: '保育園' }]
    const result = attributeEvents(events, {
      prefixHint: null,
      hintsLookup: () => 'child3',
    })
    expect(result[0]?.attributedTo).toBe('child3')
  })

  it('leaves unknown when no prefix, no hint, and AI says unknown', () => {
    const events = [{ ...baseEvent, attributedTo: 'unknown' as const }]
    const result = attributeEvents(events, { prefixHint: null, hintsLookup: () => null })
    expect(result[0]?.attributedTo).toBe('unknown')
    expect(result[0]?.attributionConfidence).toBeLessThan(0.7)
  })

  it('applies prefix uniformly across multiple events', () => {
    const events = [
      { ...baseEvent, attributedTo: 'child1' as const },
      { ...baseEvent, attributedTo: 'unknown' as const },
    ]
    const result = attributeEvents(events, { prefixHint: 'child2', hintsLookup: () => null })
    expect(result.every((e) => e.attributedTo === 'child2')).toBe(true)
  })
})
```

- [ ] **Step 2: テスト FAIL を確認**

```bash
pnpm test:unit tests/unit/attributor.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: `src/pipeline/attributor.ts` を実装**

```ts
import type { ChildId, ExtractedEvent } from '~/config/schema'

export type AttributorOptions = {
  prefixHint: Exclude<ChildId, 'unknown'> | null
  hintsLookup: (rawExcerpt: string) => Exclude<ChildId, 'unknown'> | null
}

const HINT_CONFIDENCE = 0.85
const ATTRIBUTION_TRUST_FLOOR = 0.7

export function attributeEvents(
  events: ExtractedEvent[],
  opts: AttributorOptions,
): ExtractedEvent[] {
  return events.map((event) => {
    if (opts.prefixHint !== null) {
      return { ...event, attributedTo: opts.prefixHint, attributionConfidence: 1.0 }
    }

    const needsHint = event.attributedTo === 'unknown' || event.attributionConfidence < ATTRIBUTION_TRUST_FLOOR
    if (needsHint) {
      const hinted = opts.hintsLookup(event.rawExcerpt)
      if (hinted !== null) {
        return { ...event, attributedTo: hinted, attributionConfidence: HINT_CONFIDENCE }
      }
    }

    return event
  })
}
```

- [ ] **Step 4: テスト PASS を確認**

```bash
pnpm test:unit tests/unit/attributor.test.ts
```

Expected: 6 tests pass.

- [ ] **Step 5: コミット**

```bash
git add src/pipeline/attributor.ts tests/unit/attributor.test.ts
git commit -m "feat(pipeline): attribute events using prefix > hints > AI fallback"
```

---

## Task 9: Confidence 判定と閾値

**Files:**
- Create: `src/config/thresholds.ts`
- Create: `src/pipeline/confidence.ts`
- Create: `tests/unit/confidence.test.ts`

- [ ] **Step 1: `tests/unit/confidence.test.ts` を書く**

```ts
import { describe, expect, it } from 'vitest'
import { decideRoute } from '~/pipeline/confidence'
import type { ExtractedEvent } from '~/config/schema'

const base: ExtractedEvent = {
  title: 'x',
  startAt: '2026-06-10T09:00:00+09:00',
  endAt: null,
  allDay: false,
  location: null,
  description: null,
  attributedTo: 'child1',
  attributionConfidence: 1.0,
  datetimeConfidence: 1.0,
  rawExcerpt: '',
}

describe('decideRoute', () => {
  it('returns auto-register when both confidences are >= 0.8 and attributedTo is known', () => {
    expect(decideRoute(base, { modeHint: null })).toBe('auto-register')
  })

  it('returns ask when attribution confidence is below threshold', () => {
    expect(decideRoute({ ...base, attributionConfidence: 0.5 }, { modeHint: null })).toBe('ask')
  })

  it('returns ask when datetime confidence is below threshold', () => {
    expect(decideRoute({ ...base, datetimeConfidence: 0.4 }, { modeHint: null })).toBe('ask')
  })

  it('returns ask when attributedTo is unknown', () => {
    expect(decideRoute({ ...base, attributedTo: 'unknown' }, { modeHint: null })).toBe('ask')
  })

  it('returns ask when modeHint is force-ask, regardless of confidence', () => {
    expect(decideRoute(base, { modeHint: 'force-ask' })).toBe('ask')
  })

  it('returns auto-register when modeHint is force-auto, regardless of confidence', () => {
    expect(decideRoute({ ...base, attributedTo: 'unknown', attributionConfidence: 0.1 }, { modeHint: 'force-auto' })).toBe('auto-register')
  })
})
```

- [ ] **Step 2: テスト FAIL を確認**

```bash
pnpm test:unit tests/unit/confidence.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: `src/config/thresholds.ts` を作成**

```ts
export type Thresholds = {
  attribution: number
  datetime: number
}

export function loadThresholdsFromEnv(env: Record<string, string | undefined>): Thresholds {
  return {
    attribution: parseFloat(env.CONFIDENCE_THRESHOLD_ATTRIBUTION ?? '0.8'),
    datetime: parseFloat(env.CONFIDENCE_THRESHOLD_DATETIME ?? '0.8'),
  }
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  attribution: 0.8,
  datetime: 0.8,
}
```

- [ ] **Step 4: `src/pipeline/confidence.ts` を作成**

```ts
import type { ExtractedEvent, PrefixMode } from '~/config/schema'
import { DEFAULT_THRESHOLDS, type Thresholds } from '~/config/thresholds'

export type Route = 'auto-register' | 'ask'

export type ConfidenceOptions = {
  modeHint: PrefixMode | null
  thresholds?: Thresholds
}

export function decideRoute(event: ExtractedEvent, opts: ConfidenceOptions): Route {
  if (opts.modeHint === 'force-auto') return 'auto-register'
  if (opts.modeHint === 'force-ask') return 'ask'

  const t = opts.thresholds ?? DEFAULT_THRESHOLDS
  const isHigh =
    event.attributionConfidence >= t.attribution &&
    event.datetimeConfidence >= t.datetime &&
    event.attributedTo !== 'unknown'

  return isHigh ? 'auto-register' : 'ask'
}
```

- [ ] **Step 5: テスト PASS を確認**

```bash
pnpm test:unit tests/unit/confidence.test.ts
```

Expected: 6 tests pass.

- [ ] **Step 6: コミット**

```bash
git add src/config/thresholds.ts src/pipeline/confidence.ts tests/unit/confidence.test.ts
git commit -m "feat(pipeline): add confidence-based routing with mode hint override"
```

---

## Task 10: Logger ユーティリティ

**Files:**
- Create: `src/lib/logger.ts`

- [ ] **Step 1: `src/lib/logger.ts` を作成（構造化ログ、Cloud Logging 互換）**

```ts
type LogLevel = 'debug' | 'info' | 'warn' | 'error'

type LogPayload = Record<string, unknown>

function emit(level: LogLevel, message: string, payload?: LogPayload): void {
  const entry = {
    severity: level.toUpperCase(),
    message,
    timestamp: new Date().toISOString(),
    ...(payload ?? {}),
  }
  // Cloud Logging が stderr/stdout の JSON を構造化ログとして取り込む
  if (level === 'error') {
    console.error(JSON.stringify(entry))
  } else {
    console.log(JSON.stringify(entry))
  }
}

export const logger = {
  debug: (msg: string, payload?: LogPayload) => emit('debug', msg, payload),
  info: (msg: string, payload?: LogPayload) => emit('info', msg, payload),
  warn: (msg: string, payload?: LogPayload) => emit('warn', msg, payload),
  error: (msg: string, payload?: LogPayload) => emit('error', msg, payload),
}
```

- [ ] **Step 2: typecheck**

```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 3: コミット**

```bash
git add src/lib/logger.ts
git commit -m "feat(lib): add structured logger compatible with Cloud Logging"
```

---

## Task 11: カスタムエラー型

**Files:**
- Create: `src/lib/errors.ts`

- [ ] **Step 1: `src/lib/errors.ts` を作成**

```ts
export class AppError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = this.constructor.name
  }
}

export class SignatureInvalidError extends AppError {}
export class GeminiExtractionError extends AppError {}
export class CalendarWriteError extends AppError {}
export class SecretAccessError extends AppError {}
export class SchemaParseError extends AppError {}

export function isRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const message = err.message.toLowerCase()
  if (message.includes('resource_exhausted')) return true
  if (message.includes('unavailable')) return true
  if (message.includes('deadline_exceeded')) return true
  if (err instanceof GeminiExtractionError && err.cause) return isRetryable(err.cause)
  return false
}
```

- [ ] **Step 2: typecheck**

```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 3: コミット**

```bash
git add src/lib/errors.ts
git commit -m "feat(lib): add custom error classes and retry classification"
```

---

## Task 12: Secret Manager アダプタ

**Files:**
- Create: `src/adapters/secrets.ts`

- [ ] **Step 1: `src/adapters/secrets.ts` を作成**

```ts
import { SecretManagerServiceClient } from '@google-cloud/secret-manager'
import { SecretAccessError } from '~/lib/errors'
import { logger } from '~/lib/logger'

let cachedClient: SecretManagerServiceClient | null = null

function getClient(): SecretManagerServiceClient {
  if (cachedClient === null) {
    cachedClient = new SecretManagerServiceClient()
  }
  return cachedClient
}

const cache = new Map<string, string>()

export async function readSecret(
  projectId: string,
  secretName: string,
  version: string = 'latest',
): Promise<string> {
  const cacheKey = `${projectId}/${secretName}/${version}`
  const hit = cache.get(cacheKey)
  if (hit !== undefined) return hit

  const name = `projects/${projectId}/secrets/${secretName}/versions/${version}`
  try {
    const [response] = await getClient().accessSecretVersion({ name })
    const payload = response.payload?.data?.toString()
    if (!payload) throw new SecretAccessError(`Secret ${secretName} is empty`)
    cache.set(cacheKey, payload)
    logger.info('secret.loaded', { secretName, version })
    return payload
  } catch (err) {
    throw new SecretAccessError(`Failed to read secret ${secretName}`, err)
  }
}

export function clearSecretCache(): void {
  cache.clear()
}
```

- [ ] **Step 2: typecheck**

```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 3: コミット**

```bash
git add src/adapters/secrets.ts
git commit -m "feat(adapter): add Secret Manager client with in-memory cache"
```

---

## Task 13: Gemini アダプタ（Vertex AI）

**Files:**
- Create: `src/adapters/gemini.ts`

- [ ] **Step 1: `src/adapters/gemini.ts` を作成**

```ts
import { GoogleGenAI } from '@google/genai'
import { GeminiExtractionError, SchemaParseError, isRetryable } from '~/lib/errors'
import { logger } from '~/lib/logger'
import {
  type ChildrenMap,
} from '~/config/children'
import {
  ExtractionResponse,
  type ExtractedEvent,
  type ExtractionInput,
} from '~/config/schema'

const MAX_RETRIES = 3

export type GeminiClient = {
  extract(input: ExtractionInput): Promise<{ events: ExtractedEvent[]; summary: string }>
}

export type GeminiClientConfig = {
  projectId: string
  location: string
  model: string
  children: ChildrenMap
}

const responseSchema = {
  type: 'object',
  properties: {
    events: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          startAt: { type: 'string' },
          endAt: { type: 'string', nullable: true },
          allDay: { type: 'boolean' },
          location: { type: 'string', nullable: true },
          description: { type: 'string', nullable: true },
          attributedTo: {
            type: 'string',
            enum: ['child1', 'child2', 'child3', 'self', 'unknown'],
          },
          attributionConfidence: { type: 'number' },
          datetimeConfidence: { type: 'number' },
          rawExcerpt: { type: 'string' },
        },
        required: [
          'title',
          'startAt',
          'endAt',
          'allDay',
          'location',
          'description',
          'attributedTo',
          'attributionConfidence',
          'datetimeConfidence',
          'rawExcerpt',
        ],
      },
    },
    summary: { type: 'string' },
  },
  required: ['events', 'summary'],
} as const

function buildSystemInstruction(postedAt: string, children: ChildrenMap): string {
  return [
    'あなたは日本の子育て家庭のスケジュールアシスタントです。',
    '親から送られる Slack 投稿（テキスト + 画像スクショ）から、カレンダーに登録すべき予定を構造化して抽出します。',
    '',
    '# 家族の構成',
    `- child1: ${children.child1.label} / contexts: ${children.child1.contexts.join(', ') || '(none)'}`,
    `- child2: ${children.child2.label} / contexts: ${children.child2.contexts.join(', ') || '(none)'}`,
    `- child3: ${children.child3.label} / contexts: ${children.child3.contexts.join(', ') || '(none)'}`,
    '- self: 親（投稿者）自身の予定',
    '',
    '# 抽出ルール',
    '1. 1 投稿に複数イベントが含まれる場合、すべて events 配列で返す',
    '2. 日時が曖昧な場合は datetimeConfidence を低くする（例: "来週" → 0.4, "5/15 14:00" → 1.0）',
    '3. 誰の予定かは contexts や差出人を手がかりに推定。判別不能なら unknown を返す',
    '4. 持ち物リストや備考は description に集約',
    '5. 投稿の前後で文脈が変わる場合は rawExcerpt にイベント単位の根拠文を入れる',
    '6. イベントではない雑談・お知らせのみの投稿は events: [] を返す',
    '',
    '# 日時解決の基準',
    `- 投稿日時: ${postedAt}（JST）`,
    '- これを基準に「来週」「明日」等を絶対日時に変換すること',
    '- タイムゾーンは Asia/Tokyo',
    '- 出力する startAt / endAt は ISO 8601 形式（タイムゾーン込み）',
  ].join('\n')
}

export function createGeminiClient(config: GeminiClientConfig): GeminiClient {
  const ai = new GoogleGenAI({
    vertexai: true,
    project: config.projectId,
    location: config.location,
  })

  return {
    async extract(input: ExtractionInput) {
      const parts: Array<Record<string, unknown>> = []
      for (const img of input.images) {
        parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } })
      }
      if (input.text.trim().length > 0) {
        parts.push({ text: input.text })
      }

      const systemInstruction = buildSystemInstruction(input.postedAt, config.children)

      let lastErr: unknown = null
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          const response = await ai.models.generateContent({
            model: config.model,
            contents: [{ role: 'user', parts }],
            config: {
              systemInstruction,
              responseMimeType: 'application/json',
              responseSchema,
              temperature: 0.2,
            },
          })

          const text = response.text
          if (!text) throw new GeminiExtractionError('Empty response from Gemini')

          let json: unknown
          try {
            json = JSON.parse(text)
          } catch (parseErr) {
            throw new SchemaParseError(`Gemini returned non-JSON: ${text.slice(0, 200)}`, parseErr)
          }

          const parsed = ExtractionResponse.safeParse(json)
          if (!parsed.success) {
            throw new SchemaParseError(`Zod parse failed: ${parsed.error.message}`, parsed.error)
          }

          logger.info('gemini.extracted', {
            eventCount: parsed.data.events.length,
            attempt,
          })
          return parsed.data
        } catch (err) {
          lastErr = err
          if (!isRetryable(err) || attempt === MAX_RETRIES - 1) break
          const wait = Math.pow(4, attempt) * 1000
          logger.warn('gemini.retry', { attempt, waitMs: wait })
          await new Promise((r) => setTimeout(r, wait))
        }
      }
      throw lastErr instanceof Error ? lastErr : new GeminiExtractionError('Unknown extraction failure')
    },
  }
}
```

- [ ] **Step 2: typecheck**

```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 3: コミット**

```bash
git add src/adapters/gemini.ts
git commit -m "feat(adapter): add Gemini Vertex AI client with structured output and retry"
```

---

## Task 14: Google Calendar アダプタ

**Files:**
- Create: `src/adapters/google-calendar.ts`

- [ ] **Step 1: `src/adapters/google-calendar.ts` を作成**

```ts
import { google, type calendar_v3 } from 'googleapis'
import { CalendarWriteError } from '~/lib/errors'
import { logger } from '~/lib/logger'

export type CalendarEventInput = {
  calendarId: string
  eventId: string
  summary: string
  description: string | null
  location: string | null
  startAt: string
  endAt: string | null
  allDay: boolean
}

export type CalendarClient = {
  insertEvent(input: CalendarEventInput): Promise<{ id: string; htmlLink: string }>
  deleteEvent(calendarId: string, eventId: string): Promise<void>
}

export type CalendarClientConfig = {
  clientId: string
  clientSecret: string
  refreshToken: string
}

export function createCalendarClient(config: CalendarClientConfig): CalendarClient {
  const oauth2 = new google.auth.OAuth2(config.clientId, config.clientSecret)
  oauth2.setCredentials({ refresh_token: config.refreshToken })
  const calendar = google.calendar({ version: 'v3', auth: oauth2 })

  return {
    async insertEvent(input) {
      const body: calendar_v3.Schema$Event = {
        id: input.eventId,
        summary: input.summary,
        description: input.description ?? undefined,
        location: input.location ?? undefined,
      }
      if (input.allDay) {
        body.start = { date: input.startAt.slice(0, 10) }
        body.end = { date: (input.endAt ?? input.startAt).slice(0, 10) }
      } else {
        body.start = { dateTime: input.startAt, timeZone: 'Asia/Tokyo' }
        body.end = { dateTime: input.endAt ?? input.startAt, timeZone: 'Asia/Tokyo' }
      }

      try {
        const res = await calendar.events.insert({
          calendarId: input.calendarId,
          requestBody: body,
        })
        logger.info('calendar.inserted', { calendarId: input.calendarId, eventId: res.data.id })
        return { id: res.data.id ?? input.eventId, htmlLink: res.data.htmlLink ?? '' }
      } catch (err) {
        const status = (err as { code?: number }).code
        if (status === 409) {
          logger.info('calendar.duplicate', { calendarId: input.calendarId, eventId: input.eventId })
          return { id: input.eventId, htmlLink: '' }
        }
        throw new CalendarWriteError(`Calendar insert failed: ${(err as Error).message}`, err)
      }
    },

    async deleteEvent(calendarId, eventId) {
      try {
        await calendar.events.delete({ calendarId, eventId })
        logger.info('calendar.deleted', { calendarId, eventId })
      } catch (err) {
        const status = (err as { code?: number }).code
        if (status === 404 || status === 410) return
        throw new CalendarWriteError(`Calendar delete failed: ${(err as Error).message}`, err)
      }
    },
  }
}
```

- [ ] **Step 2: typecheck**

```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 3: コミット**

```bash
git add src/adapters/google-calendar.ts
git commit -m "feat(adapter): add Google Calendar client with insert and delete operations"
```

---

## Task 15: Slack アダプタ

**Files:**
- Create: `src/adapters/slack.ts`

- [ ] **Step 1: `src/adapters/slack.ts` を作成**

```ts
import { WebClient } from '@slack/web-api'
import { logger } from '~/lib/logger'

export type SlackClient = {
  postThreadMessage(channel: string, threadTs: string, text: string): Promise<{ ts: string }>
  postChannelMessage(channel: string, text: string): Promise<{ ts: string }>
  postDirectMessage(userId: string, text: string): Promise<void>
  getFileBytes(url: string): Promise<{ bytes: Uint8Array; mimeType: string }>
}

export type SlackClientConfig = {
  botToken: string
}

export function createSlackClient(config: SlackClientConfig): SlackClient {
  const client = new WebClient(config.botToken)

  return {
    async postThreadMessage(channel, threadTs, text) {
      const res = await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text,
        unfurl_links: false,
        unfurl_media: false,
      })
      logger.info('slack.threadReply', { channel, threadTs, ts: res.ts })
      return { ts: res.ts as string }
    },

    async postChannelMessage(channel, text) {
      const res = await client.chat.postMessage({ channel, text })
      return { ts: res.ts as string }
    },

    async postDirectMessage(userId, text) {
      const im = await client.conversations.open({ users: userId })
      const channel = (im.channel as { id: string }).id
      await client.chat.postMessage({ channel, text })
      logger.info('slack.dmSent', { userId })
    },

    async getFileBytes(url) {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${config.botToken}` },
      })
      if (!res.ok) throw new Error(`Slack file fetch failed: ${res.status}`)
      const buffer = await res.arrayBuffer()
      return {
        bytes: new Uint8Array(buffer),
        mimeType: res.headers.get('content-type') ?? 'application/octet-stream',
      }
    },
  }
}
```

- [ ] **Step 2: typecheck**

```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 3: コミット**

```bash
git add src/adapters/slack.ts
git commit -m "feat(adapter): add Slack Web API client with thread, DM, and file fetch"
```

---

## Task 16: Firestore クライアントセットアップ

**Files:**
- Create: `src/stores/firestore-client.ts`

- [ ] **Step 1: `src/stores/firestore-client.ts` を作成**

```ts
import { Firestore } from '@google-cloud/firestore'

let cached: Firestore | null = null

export function getFirestore(projectId?: string): Firestore {
  if (cached === null) {
    cached = new Firestore({
      projectId: projectId ?? process.env.GCP_PROJECT_ID,
      databaseId: process.env.FIRESTORE_DATABASE ?? '(default)',
    })
  }
  return cached
}

export function resetFirestoreClientForTesting(): void {
  cached = null
}
```

- [ ] **Step 2: typecheck**

```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 3: コミット**

```bash
git add src/stores/firestore-client.ts
git commit -m "feat(stores): add Firestore client singleton with emulator support"
```

---

## Task 17: Idempotency Store

**Files:**
- Create: `src/stores/idempotency.ts`
- Create: `tests/integration/idempotency.test.ts`

このタスクは Firestore Emulator を使う統合テスト。前提: `gcloud beta emulators firestore start --host-port=localhost:8085` が別ターミナルで動いていること。

- [ ] **Step 1: `tests/integration/idempotency.test.ts` を書く**

```ts
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Firestore } from '@google-cloud/firestore'
import {
  createIdempotencyStore,
  type IdempotencyResult,
} from '~/stores/idempotency'

let firestore: Firestore

beforeAll(() => {
  process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8085'
  firestore = new Firestore({ projectId: 'hanamaru-test' })
})

async function clearCollection() {
  const snapshot = await firestore.collection('processed_events').get()
  await Promise.all(snapshot.docs.map((d) => d.ref.delete()))
}

beforeEach(clearCollection)
afterEach(clearCollection)

describe('idempotency store', () => {
  it('returns null on first lookup', async () => {
    const store = createIdempotencyStore(firestore)
    const result = await store.get('team1:event1')
    expect(result).toBeNull()
  })

  it('tryAcquire succeeds on first attempt, fails on second', async () => {
    const store = createIdempotencyStore(firestore)
    const first = await store.tryAcquire('team1:event1')
    expect(first).toBe(true)
    const second = await store.tryAcquire('team1:event1')
    expect(second).toBe(false)
  })

  it('complete writes the result and get returns it', async () => {
    const store = createIdempotencyStore(firestore)
    await store.tryAcquire('team1:event1')
    const result: IdempotencyResult = {
      resultSummary: 'created',
      createdEventIds: ['hnm-event1-0'],
    }
    await store.complete('team1:event1', result)
    const fetched = await store.get('team1:event1')
    expect(fetched).toMatchObject(result)
  })

  it('markFailed records the error reason', async () => {
    const store = createIdempotencyStore(firestore)
    await store.tryAcquire('team1:event1')
    await store.markFailed('team1:event1', new Error('boom'))
    const fetched = await store.get('team1:event1')
    expect(fetched?.resultSummary).toBe('failed')
  })
})
```

- [ ] **Step 2: テスト FAIL を確認**

```bash
# 別ターミナルで emulator を起動しておく
pnpm test:integration tests/integration/idempotency.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: `src/stores/idempotency.ts` を実装**

```ts
import type { Firestore } from '@google-cloud/firestore'

export type IdempotencyResult = {
  resultSummary: 'created' | 'pending' | 'rejected' | 'failed'
  createdEventIds: string[]
}

export type IdempotencyRecord = IdempotencyResult & {
  slackEventId: string
  processedAt: FirebaseFirestore.Timestamp | Date
  ttlAt: FirebaseFirestore.Timestamp | Date
  failureReason?: string
}

export type IdempotencyStore = {
  get(key: string): Promise<IdempotencyRecord | null>
  tryAcquire(key: string): Promise<boolean>
  complete(key: string, result: IdempotencyResult): Promise<void>
  markFailed(key: string, err: unknown): Promise<void>
}

const COLLECTION = 'processed_events'
const TTL_DAYS = 30

function ttlDate(): Date {
  return new Date(Date.now() + TTL_DAYS * 24 * 60 * 60 * 1000)
}

export function createIdempotencyStore(firestore: Firestore): IdempotencyStore {
  const col = firestore.collection(COLLECTION)

  return {
    async get(key) {
      const snap = await col.doc(key).get()
      if (!snap.exists) return null
      return snap.data() as IdempotencyRecord
    },

    async tryAcquire(key) {
      const ref = col.doc(key)
      try {
        await firestore.runTransaction(async (tx) => {
          const existing = await tx.get(ref)
          if (existing.exists) {
            throw new Error('already-acquired')
          }
          tx.set(ref, {
            slackEventId: key,
            processedAt: new Date(),
            resultSummary: 'pending',
            createdEventIds: [],
            ttlAt: ttlDate(),
          } satisfies IdempotencyRecord)
        })
        return true
      } catch (err) {
        if ((err as Error).message === 'already-acquired') return false
        throw err
      }
    },

    async complete(key, result) {
      await col.doc(key).set(
        {
          slackEventId: key,
          processedAt: new Date(),
          resultSummary: result.resultSummary,
          createdEventIds: result.createdEventIds,
          ttlAt: ttlDate(),
        } satisfies IdempotencyRecord,
        { merge: true },
      )
    },

    async markFailed(key, err) {
      await col.doc(key).set(
        {
          resultSummary: 'failed',
          failureReason: err instanceof Error ? err.message : String(err),
        },
        { merge: true },
      )
    },
  }
}
```

- [ ] **Step 4: テスト PASS を確認**

```bash
pnpm test:integration tests/integration/idempotency.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 5: コミット**

```bash
git add src/stores/idempotency.ts tests/integration/idempotency.test.ts
git commit -m "feat(stores): idempotency store with Firestore transactional acquire"
```

---

## Task 18: Pending Confirmations Store

**Files:**
- Create: `src/stores/pending.ts`
- Create: `tests/integration/pending.test.ts`

- [ ] **Step 1: `tests/integration/pending.test.ts` を書く**

```ts
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Firestore } from '@google-cloud/firestore'
import { createPendingStore, type PendingRecord } from '~/stores/pending'
import type { ExtractedEvent } from '~/config/schema'

let firestore: Firestore

beforeAll(() => {
  process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8085'
  firestore = new Firestore({ projectId: 'hanamaru-test' })
})

const sampleEvent: ExtractedEvent = {
  title: 'ピアノ発表会',
  startAt: '2026-07-01T00:00:00+09:00',
  endAt: null,
  allDay: true,
  location: null,
  description: null,
  attributedTo: 'unknown',
  attributionConfidence: 0.3,
  datetimeConfidence: 0.3,
  rawExcerpt: '来月のどこかで発表会',
}

async function clearCollection() {
  const snapshot = await firestore.collection('pending_confirmations').get()
  await Promise.all(snapshot.docs.map((d) => d.ref.delete()))
}

beforeEach(clearCollection)
afterEach(clearCollection)

describe('pending store', () => {
  it('creates and retrieves a pending record', async () => {
    const store = createPendingStore(firestore)
    const id = await store.create({
      slackChannelId: 'C123',
      slackThreadTs: '1.0',
      slackMessageTs: '2.0',
      events: [sampleEvent],
    })
    const fetched = await store.getById(id)
    expect(fetched?.status).toBe('awaiting')
    expect(fetched?.events).toHaveLength(1)
  })

  it('finds by message ts (for reactions)', async () => {
    const store = createPendingStore(firestore)
    await store.create({
      slackChannelId: 'C123',
      slackThreadTs: '1.0',
      slackMessageTs: 'unique-3.0',
      events: [sampleEvent],
    })
    const found = await store.findByMessageTs('C123', 'unique-3.0')
    expect(found).not.toBeNull()
  })

  it('updates status to approved', async () => {
    const store = createPendingStore(firestore)
    const id = await store.create({
      slackChannelId: 'C123',
      slackThreadTs: '1.0',
      slackMessageTs: '4.0',
      events: [sampleEvent],
    })
    await store.updateStatus(id, 'approved')
    const fetched = await store.getById(id)
    expect(fetched?.status).toBe('approved')
  })
})
```

- [ ] **Step 2: テスト FAIL を確認**

```bash
pnpm test:integration tests/integration/pending.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: `src/stores/pending.ts` を実装**

```ts
import type { Firestore } from '@google-cloud/firestore'
import type { ExtractedEvent } from '~/config/schema'

export type PendingStatus = 'awaiting' | 'approved' | 'rejected' | 'expired'

export type PendingRecord = {
  id: string
  slackChannelId: string
  slackThreadTs: string
  slackMessageTs: string
  events: ExtractedEvent[]
  createdAt: Date
  expiresAt: Date
  status: PendingStatus
}

export type CreatePendingInput = Omit<PendingRecord, 'id' | 'createdAt' | 'expiresAt' | 'status'>

export type PendingStore = {
  create(input: CreatePendingInput): Promise<string>
  getById(id: string): Promise<PendingRecord | null>
  findByMessageTs(channelId: string, messageTs: string): Promise<PendingRecord | null>
  updateStatus(id: string, status: PendingStatus): Promise<void>
}

const COLLECTION = 'pending_confirmations'
const EXPIRY_DAYS = 7

function expiryDate(): Date {
  return new Date(Date.now() + EXPIRY_DAYS * 24 * 60 * 60 * 1000)
}

export function createPendingStore(firestore: Firestore): PendingStore {
  const col = firestore.collection(COLLECTION)

  return {
    async create(input) {
      const ref = col.doc()
      const record: Omit<PendingRecord, 'id'> = {
        ...input,
        createdAt: new Date(),
        expiresAt: expiryDate(),
        status: 'awaiting',
      }
      await ref.set(record)
      return ref.id
    },

    async getById(id) {
      const snap = await col.doc(id).get()
      if (!snap.exists) return null
      return { id: snap.id, ...(snap.data() as Omit<PendingRecord, 'id'>) }
    },

    async findByMessageTs(channelId, messageTs) {
      const q = await col
        .where('slackChannelId', '==', channelId)
        .where('slackMessageTs', '==', messageTs)
        .limit(1)
        .get()
      const doc = q.docs[0]
      if (!doc) return null
      return { id: doc.id, ...(doc.data() as Omit<PendingRecord, 'id'>) }
    },

    async updateStatus(id, status) {
      await col.doc(id).update({ status })
    },
  }
}
```

- [ ] **Step 4: テスト PASS を確認**

```bash
pnpm test:integration tests/integration/pending.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: コミット**

```bash
git add src/stores/pending.ts tests/integration/pending.test.ts
git commit -m "feat(stores): pending confirmations store with status transitions"
```

---

## Task 19: Attribution Hints Store

**Files:**
- Create: `src/stores/attribution-hints.ts`
- Create: `tests/integration/attribution-hints.test.ts`

- [ ] **Step 1: `tests/integration/attribution-hints.test.ts` を書く**

```ts
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Firestore } from '@google-cloud/firestore'
import { createAttributionHintsStore } from '~/stores/attribution-hints'

let firestore: Firestore

beforeAll(() => {
  process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8085'
  firestore = new Firestore({ projectId: 'hanamaru-test' })
})

async function clearCollection() {
  const snapshot = await firestore.collection('attribution_hints').get()
  await Promise.all(snapshot.docs.map((d) => d.ref.delete()))
}

beforeEach(clearCollection)
afterEach(clearCollection)

describe('attribution hints store', () => {
  it('returns null when no hint matches', async () => {
    const store = createAttributionHintsStore(firestore)
    expect(await store.lookup('近所のスーパー')).toBeNull()
  })

  it('upserts and looks up by key', async () => {
    const store = createAttributionHintsStore(firestore)
    await store.upsert({ key: 'ピアノ教室', childId: 'child2', source: 'manual' })
    expect(await store.lookup('明日のピアノ教室のレッスン')).toBe('child2')
  })

  it('increments hitCount on bump', async () => {
    const store = createAttributionHintsStore(firestore)
    await store.upsert({ key: 'スイミング', childId: 'child3', source: 'learned' })
    await store.bumpHit('スイミング')
    await store.bumpHit('スイミング')
    const all = await store.listAll()
    const sw = all.find((r) => r.key === 'スイミング')
    expect(sw?.hitCount).toBe(2)
  })
})
```

- [ ] **Step 2: テスト FAIL を確認**

```bash
pnpm test:integration tests/integration/attribution-hints.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: `src/stores/attribution-hints.ts` を実装**

```ts
import type { Firestore } from '@google-cloud/firestore'
import type { ChildId } from '~/config/schema'

export type HintSource = 'manual' | 'learned' | 'config'

export type HintRecord = {
  key: string
  childId: Exclude<ChildId, 'unknown'>
  source: HintSource
  hitCount: number
  lastUsedAt: Date
}

export type AttributionHintsStore = {
  lookup(text: string): Promise<Exclude<ChildId, 'unknown'> | null>
  upsert(input: { key: string; childId: Exclude<ChildId, 'unknown'>; source: HintSource }): Promise<void>
  bumpHit(key: string): Promise<void>
  listAll(): Promise<HintRecord[]>
}

const COLLECTION = 'attribution_hints'

function normalize(key: string): string {
  return key.normalize('NFKC').trim()
}

function docId(key: string): string {
  return Buffer.from(normalize(key)).toString('base64url')
}

export function createAttributionHintsStore(firestore: Firestore): AttributionHintsStore {
  const col = firestore.collection(COLLECTION)

  return {
    async lookup(text) {
      const snap = await col.get()
      const normalized = normalize(text)
      for (const doc of snap.docs) {
        const data = doc.data() as HintRecord
        if (normalized.includes(normalize(data.key))) {
          return data.childId
        }
      }
      return null
    },

    async upsert({ key, childId, source }) {
      const id = docId(key)
      await col.doc(id).set(
        {
          key: normalize(key),
          childId,
          source,
          hitCount: 0,
          lastUsedAt: new Date(),
        } satisfies HintRecord,
        { merge: true },
      )
    },

    async bumpHit(key) {
      const ref = col.doc(docId(key))
      await firestore.runTransaction(async (tx) => {
        const snap = await tx.get(ref)
        if (!snap.exists) return
        const current = snap.data() as HintRecord
        tx.update(ref, { hitCount: current.hitCount + 1, lastUsedAt: new Date() })
      })
    },

    async listAll() {
      const snap = await col.get()
      return snap.docs.map((d) => d.data() as HintRecord)
    },
  }
}
```

- [ ] **Step 4: テスト PASS を確認**

```bash
pnpm test:integration tests/integration/attribution-hints.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 5: コミット**

```bash
git add src/stores/attribution-hints.ts tests/integration/attribution-hints.test.ts
git commit -m "feat(stores): attribution hints store with substring lookup and hit count"
```

---

## Task 20: Extractor（Gemini 呼び出しのオーケストレーション）

**Files:**
- Create: `src/pipeline/extractor.ts`

このタスクは Gemini クライアントを受け取り、パイプラインの入力をそのまま流す薄いラッパ。テストは Task 23 のオーケストレータで網羅。

- [ ] **Step 1: `src/pipeline/extractor.ts` を作成**

```ts
import type { GeminiClient } from '~/adapters/gemini'
import type { ExtractionInput, ExtractedEvent } from '~/config/schema'

export type Extractor = {
  extract(input: ExtractionInput): Promise<{ events: ExtractedEvent[]; summary: string }>
}

export function createExtractor(gemini: GeminiClient): Extractor {
  return {
    async extract(input) {
      return gemini.extract(input)
    },
  }
}
```

- [ ] **Step 2: typecheck**

```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 3: コミット**

```bash
git add src/pipeline/extractor.ts
git commit -m "feat(pipeline): add extractor wrapping the Gemini client"
```

---

## Task 21: Calendar Writer

**Files:**
- Create: `src/pipeline/calendar-writer.ts`

- [ ] **Step 1: `src/pipeline/calendar-writer.ts` を作成**

```ts
import { createHash } from 'node:crypto'
import type { CalendarClient } from '~/adapters/google-calendar'
import type { ChildrenMap } from '~/config/children'
import type { ExtractedEvent } from '~/config/schema'

export type WriteResult = {
  eventId: string
  htmlLink: string
  calendarId: string
  child: string
}

export type CalendarWriter = {
  writeAll(events: ExtractedEvent[], slackEventId: string): Promise<WriteResult[]>
  remove(events: WriteResult[]): Promise<void>
}

export function createCalendarWriter(
  calendar: CalendarClient,
  children: ChildrenMap,
): CalendarWriter {
  function pickCalendarId(child: ExtractedEvent['attributedTo']): string {
    if (child === 'unknown') throw new Error('Cannot write event with attributedTo=unknown')
    return children[child].calendarId
  }

  function buildEventId(slackEventId: string, index: number): string {
    // Google Calendar event ID は base32hex (a-v + 0-9) のみ。SHA-256 hex (a-f + 0-9) はサブセット。
    const hash = createHash('sha256').update(slackEventId).digest('hex').slice(0, 20)
    return `hnm${hash}${index}`
  }

  return {
    async writeAll(events, slackEventId) {
      const tasks = events.map(async (event, index) => {
        const calendarId = pickCalendarId(event.attributedTo)
        const eventId = buildEventId(slackEventId, index)
        const inserted = await calendar.insertEvent({
          calendarId,
          eventId,
          summary: event.title,
          description: event.description,
          location: event.location,
          startAt: event.startAt,
          endAt: event.endAt,
          allDay: event.allDay,
        })
        return {
          eventId: inserted.id,
          htmlLink: inserted.htmlLink,
          calendarId,
          child: event.attributedTo,
        }
      })
      return Promise.all(tasks)
    },

    async remove(events) {
      await Promise.all(events.map((e) => calendar.deleteEvent(e.calendarId, e.eventId)))
    },
  }
}
```

- [ ] **Step 2: typecheck**

```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 3: コミット**

```bash
git add src/pipeline/calendar-writer.ts
git commit -m "feat(pipeline): add calendar writer with deterministic event IDs"
```

---

## Task 22: Replier（Slack スレッド返信フォーマット）

**Files:**
- Create: `src/pipeline/replier.ts`
- Create: `tests/unit/replier.test.ts`

- [ ] **Step 1: `tests/unit/replier.test.ts` を書く**

```ts
import { describe, expect, it } from 'vitest'
import {
  buildAutoRegisterText,
  buildAskText,
  buildEmptyText,
  buildErrorText,
} from '~/pipeline/replier'
import type { WriteResult } from '~/pipeline/calendar-writer'
import type { ExtractedEvent } from '~/config/schema'

const labels = { child1: '長女', child2: '長男', child3: '末っ子', self: '自分' }

const sampleEvent: ExtractedEvent = {
  title: '遠足',
  startAt: '2026-06-10T09:00:00+09:00',
  endAt: '2026-06-10T14:00:00+09:00',
  allDay: false,
  location: '○○公園',
  description: null,
  attributedTo: 'child3',
  attributionConfidence: 1.0,
  datetimeConfidence: 1.0,
  rawExcerpt: '',
}

const sampleResult: WriteResult = {
  eventId: 'hnm-e1-0',
  htmlLink: 'https://calendar.google.com/event?id=xyz',
  calendarId: 'cal3',
  child: 'child3',
}

describe('replier formatters', () => {
  it('formats single auto-register message', () => {
    const text = buildAutoRegisterText([sampleEvent], [sampleResult], labels)
    expect(text).toContain('✅ 1 件登録しました')
    expect(text).toContain('遠足')
    expect(text).toContain('末っ子')
  })

  it('formats multi-event auto-register with breakdown', () => {
    const events: ExtractedEvent[] = [
      { ...sampleEvent, attributedTo: 'child3' },
      { ...sampleEvent, attributedTo: 'child3', title: '検診' },
      { ...sampleEvent, attributedTo: 'child1', title: '保護者会' },
    ]
    const results: WriteResult[] = events.map((e, i) => ({
      ...sampleResult,
      eventId: `hnm-e1-${i}`,
      child: e.attributedTo,
    }))
    const text = buildAutoRegisterText(events, results, labels)
    expect(text).toContain('3 件登録しました')
    expect(text).toContain('末っ子 2 件')
    expect(text).toContain('長女 1 件')
  })

  it('formats ask message with warnings', () => {
    const events: ExtractedEvent[] = [
      { ...sampleEvent, attributedTo: 'unknown', attributionConfidence: 0.2, datetimeConfidence: 0.3, title: 'ピアノ発表会' },
    ]
    const text = buildAskText(events, labels)
    expect(text).toContain('🤔')
    expect(text).toContain('ピアノ発表会')
    expect(text).toContain('日時が曖昧')
    expect(text).toContain('誰の予定か判別できませんでした')
  })

  it('formats empty extraction message', () => {
    expect(buildEmptyText()).toContain('予定情報を検出できませんでした')
  })

  it('formats error message', () => {
    expect(buildErrorText('boom')).toContain('抽出に失敗しました')
  })
})
```

- [ ] **Step 2: テスト FAIL を確認**

```bash
pnpm test:unit tests/unit/replier.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: `src/pipeline/replier.ts` を実装**

```ts
import type { WriteResult } from '~/pipeline/calendar-writer'
import type { ChildId, ExtractedEvent } from '~/config/schema'

export type LabelMap = Record<Exclude<ChildId, 'unknown'>, string>

const NUMBER_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟']

const WEEKDAY_MAP: Record<string, string> = { Sun: '日', Mon: '月', Tue: '火', Wed: '水', Thu: '木', Fri: '金', Sat: '土' }

function jstParts(date: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return {
    month: get('month'),
    day: get('day'),
    weekday: WEEKDAY_MAP[get('weekday')] ?? get('weekday'),
    hour: get('hour'),
    minute: get('minute'),
  }
}

function formatJstRange(startAt: string, endAt: string | null, allDay: boolean): string {
  const s = jstParts(new Date(startAt))
  const dateLabel = `${s.month}/${s.day}(${s.weekday})`
  if (allDay) return `${dateLabel} 終日`
  const startTime = `${s.hour}:${s.minute}`
  if (endAt === null) return `${dateLabel} ${startTime}`
  const e = jstParts(new Date(endAt))
  return `${dateLabel} ${startTime}–${e.hour}:${e.minute}`
}

function labelFor(child: ChildId, labels: LabelMap): string {
  if (child === 'unknown') return '誰の予定か不明'
  return labels[child]
}

function breakdown(results: WriteResult[], labels: LabelMap): string {
  const counts = new Map<Exclude<ChildId, 'unknown'>, number>()
  for (const r of results) {
    const k = r.child as Exclude<ChildId, 'unknown'>
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return [...counts.entries()].map(([id, n]) => `${labels[id]} ${n} 件`).join(' / ')
}

export function buildAutoRegisterText(
  events: ExtractedEvent[],
  results: WriteResult[],
  labels: LabelMap,
): string {
  const lines: string[] = []
  if (events.length === 1) {
    const e = events[0]!
    const r = results[0]!
    lines.push('✅ 1 件登録しました', '')
    lines.push(`📅 **${e.title}（${labelFor(e.attributedTo, labels)}）**`)
    lines.push(formatJstRange(e.startAt, e.endAt, e.allDay))
    if (e.location) lines.push(`📍 ${e.location}`)
    if (r.htmlLink) lines.push(`<${r.htmlLink}|Google Calendar で開く>`)
    lines.push('', '※ 修正は ✏️、取り消しは ❌')
  } else {
    lines.push(`✅ ${events.length} 件登録しました（${breakdown(results, labels)}）`, '')
    events.forEach((e, i) => {
      const emoji = NUMBER_EMOJI[i] ?? `${i + 1}.`
      const link = results[i]?.htmlLink ? ` <${results[i]!.htmlLink}|↗>` : ''
      lines.push(`${emoji} 📅 ${e.title}（${labelFor(e.attributedTo, labels)}）${formatJstRange(e.startAt, e.endAt, e.allDay)}${link}`)
    })
    lines.push('', '※ 個別修正は番号返信、まとめて取り消しは ❌')
  }
  return lines.join('\n')
}

export function buildAskText(events: ExtractedEvent[], labels: LabelMap): string {
  const lines = ['🤔 以下で登録してよいですか？', '']
  events.forEach((e) => {
    lines.push(`📅 **${e.title}**（${labelFor(e.attributedTo, labels)}）`)
    if (e.datetimeConfidence < 0.7) lines.push(`⚠️ 日時が曖昧です: 「${e.rawExcerpt}」`)
    if (e.attributedTo === 'unknown') lines.push('⚠️ 誰の予定か判別できませんでした')
    lines.push('')
  })
  lines.push('応答:', '- ✅ そのまま登録', '- ❌ 破棄', '- 「#長男 7/15 14:00 から」のように詳細を返信')
  return lines.join('\n')
}

export function buildEmptyText(): string {
  return '📭 予定情報を検出できませんでした'
}

export function buildErrorText(reason: string): string {
  return `⚠️ 抽出に失敗しました（${reason}）\n少し時間をおいて再投稿してください`
}
```

- [ ] **Step 4: テスト PASS を確認**

```bash
pnpm test:unit tests/unit/replier.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 5: コミット**

```bash
git add src/pipeline/replier.ts tests/unit/replier.test.ts
git commit -m "feat(pipeline): add Slack reply formatters for auto/ask/empty/error"
```

---

## Task 23: Orchestrator（パイプライン全体制御 + Integration Test）

**Files:**
- Create: `src/pipeline/orchestrator.ts`
- Create: `tests/integration/orchestrator.test.ts`

- [ ] **Step 1: `src/pipeline/orchestrator.ts` を作成**

```ts
import type { ChildrenMap } from '~/config/children'
import type { ExtractionInput } from '~/config/schema'
import type { Thresholds } from '~/config/thresholds'
import { attributeEvents } from '~/pipeline/attributor'
import type { CalendarWriter, WriteResult } from '~/pipeline/calendar-writer'
import { decideRoute } from '~/pipeline/confidence'
import type { Extractor } from '~/pipeline/extractor'
import {
  buildAskText,
  buildAutoRegisterText,
  buildEmptyText,
  buildErrorText,
  type LabelMap,
} from '~/pipeline/replier'
import type { AttributionHintsStore } from '~/stores/attribution-hints'
import type { IdempotencyStore } from '~/stores/idempotency'
import type { PendingStore } from '~/stores/pending'
import type { SlackClient } from '~/adapters/slack'
import { logger } from '~/lib/logger'

export type OrchestratorDeps = {
  extractor: Extractor
  writer: CalendarWriter
  slack: SlackClient
  idempotency: IdempotencyStore
  pending: PendingStore
  hints: AttributionHintsStore
  children: ChildrenMap
  thresholds: Thresholds
}

export type ProcessResult =
  | { kind: 'duplicate' }
  | { kind: 'created'; results: WriteResult[] }
  | { kind: 'asked'; pendingId: string }
  | { kind: 'empty' }
  | { kind: 'failed'; reason: string }

function labelMap(children: ChildrenMap): LabelMap {
  return {
    child1: children.child1.label,
    child2: children.child2.label,
    child3: children.child3.label,
    self: children.self.label,
  }
}

export function createOrchestrator(deps: OrchestratorDeps) {
  return {
    async process(input: ExtractionInput, slackEventId: string): Promise<ProcessResult> {
      const existing = await deps.idempotency.get(slackEventId)
      if (existing && existing.resultSummary !== 'pending') {
        logger.info('orchestrator.duplicate', { slackEventId })
        return { kind: 'duplicate' }
      }

      const acquired = await deps.idempotency.tryAcquire(slackEventId)
      if (!acquired) {
        return { kind: 'duplicate' }
      }

      try {
        const { events: rawEvents } = await deps.extractor.extract(input)

        if (rawEvents.length === 0) {
          await deps.slack.postThreadMessage(input.channelId, input.threadTs, buildEmptyText())
          await deps.idempotency.complete(slackEventId, { resultSummary: 'rejected', createdEventIds: [] })
          return { kind: 'empty' }
        }

        // 事前に全 hints をロード → sync な substring matcher を構築
        const allHints = await deps.hints.listAll()
        const hintsLookup = (text: string) => {
          const normalized = text.normalize('NFKC')
          for (const h of allHints) {
            if (normalized.includes(h.key)) return h.childId
          }
          return null
        }

        const attributed = attributeEvents(rawEvents, {
          prefixHint: input.prefixHint,
          hintsLookup,
        })

        const autoEvents = attributed.filter((e) => decideRoute(e, { modeHint: input.modeHint, thresholds: deps.thresholds }) === 'auto-register')
        const askEvents = attributed.filter((e) => decideRoute(e, { modeHint: input.modeHint, thresholds: deps.thresholds }) === 'ask')

        const writeResults: WriteResult[] = autoEvents.length > 0
          ? await deps.writer.writeAll(autoEvents, slackEventId)
          : []

        if (askEvents.length > 0) {
          const text = buildAskText(askEvents, labelMap(deps.children))
          const posted = await deps.slack.postThreadMessage(input.channelId, input.threadTs, text)
          const pendingId = await deps.pending.create({
            slackChannelId: input.channelId,
            slackThreadTs: input.threadTs,
            slackMessageTs: posted.ts,
            events: askEvents,
          })
          await deps.idempotency.complete(slackEventId, {
            resultSummary: writeResults.length > 0 ? 'created' : 'pending',
            createdEventIds: writeResults.map((r) => r.eventId),
          })

          if (writeResults.length > 0) {
            await deps.slack.postThreadMessage(
              input.channelId,
              input.threadTs,
              buildAutoRegisterText(autoEvents, writeResults, labelMap(deps.children)),
            )
          }
          return { kind: 'asked', pendingId }
        }

        await deps.slack.postThreadMessage(
          input.channelId,
          input.threadTs,
          buildAutoRegisterText(autoEvents, writeResults, labelMap(deps.children)),
        )
        await deps.idempotency.complete(slackEventId, {
          resultSummary: 'created',
          createdEventIds: writeResults.map((r) => r.eventId),
        })
        return { kind: 'created', results: writeResults }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        await deps.idempotency.markFailed(slackEventId, err)
        try {
          await deps.slack.postThreadMessage(input.channelId, input.threadTs, buildErrorText(reason))
        } catch (slackErr) {
          logger.error('orchestrator.slackFallbackFailed', { slackErr: String(slackErr) })
        }
        return { kind: 'failed', reason }
      }
    },
  }
}
```

- [ ] **Step 2: `tests/integration/orchestrator.test.ts` を作成**

```ts
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Firestore } from '@google-cloud/firestore'
import { createOrchestrator } from '~/pipeline/orchestrator'
import { createIdempotencyStore } from '~/stores/idempotency'
import { createPendingStore } from '~/stores/pending'
import { createAttributionHintsStore } from '~/stores/attribution-hints'
import type { ChildrenMap } from '~/config/children'
import type { ExtractedEvent } from '~/config/schema'
import type { WriteResult } from '~/pipeline/calendar-writer'

let firestore: Firestore

beforeAll(() => {
  process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8085'
  firestore = new Firestore({ projectId: 'hanamaru-test' })
})

const children: ChildrenMap = {
  child1: { label: '長女', calendarId: 'cal1', aliases: [], contexts: [] },
  child2: { label: '長男', calendarId: 'cal2', aliases: [], contexts: [] },
  child3: { label: '末っ子', calendarId: 'cal3', aliases: [], contexts: [] },
  self: { label: '自分', calendarId: 'self', aliases: [], contexts: [] },
}

const highConfidenceEvent: ExtractedEvent = {
  title: '遠足',
  startAt: '2026-06-10T09:00:00+09:00',
  endAt: '2026-06-10T14:00:00+09:00',
  allDay: false,
  location: '○○公園',
  description: null,
  attributedTo: 'child3',
  attributionConfidence: 0.95,
  datetimeConfidence: 0.95,
  rawExcerpt: '遠足のお知らせ',
}

const lowConfidenceEvent: ExtractedEvent = {
  ...highConfidenceEvent,
  attributedTo: 'unknown',
  attributionConfidence: 0.2,
  datetimeConfidence: 0.3,
  title: 'ピアノ発表会',
}

async function clearAll() {
  for (const col of ['processed_events', 'pending_confirmations', 'attribution_hints']) {
    const s = await firestore.collection(col).get()
    await Promise.all(s.docs.map((d) => d.ref.delete()))
  }
}

beforeEach(clearAll)
afterEach(clearAll)

function buildDeps(extractedEvents: ExtractedEvent[]) {
  const extractor = { extract: vi.fn().mockResolvedValue({ events: extractedEvents, summary: '' }) }
  const insertedResults: WriteResult[] = []
  const writer = {
    writeAll: vi.fn(async (events: ExtractedEvent[], slackEventId: string) => {
      const out = events.map((e, i) => ({
        eventId: `hnm-${slackEventId}-${i}`,
        htmlLink: `https://cal/${i}`,
        calendarId: children[e.attributedTo as 'child1' | 'child2' | 'child3' | 'self'].calendarId,
        child: e.attributedTo,
      }))
      insertedResults.push(...out)
      return out
    }),
    remove: vi.fn(),
  }
  const slack = {
    postThreadMessage: vi.fn(async () => ({ ts: '1000.0' })),
    postChannelMessage: vi.fn(),
    postDirectMessage: vi.fn(),
    getFileBytes: vi.fn(),
  }
  return {
    extractor,
    writer,
    slack,
    idempotency: createIdempotencyStore(firestore),
    pending: createPendingStore(firestore),
    hints: createAttributionHintsStore(firestore),
    children,
    thresholds: { attribution: 0.8, datetime: 0.8 },
    insertedResults,
  }
}

describe('orchestrator', () => {
  it('auto-registers a high-confidence event', async () => {
    const d = buildDeps([highConfidenceEvent])
    const orch = createOrchestrator(d)
    const result = await orch.process(
      {
        postedAt: '2026-06-09T20:00:00+09:00',
        authorUserId: 'U1',
        channelId: 'C1',
        threadTs: '0.0',
        text: 'お便り',
        prefixHint: null,
        modeHint: null,
        images: [],
      },
      'evt-1',
    )
    expect(result.kind).toBe('created')
    expect(d.writer.writeAll).toHaveBeenCalledOnce()
    expect(d.slack.postThreadMessage).toHaveBeenCalled()
  })

  it('asks for confirmation on low-confidence event', async () => {
    const d = buildDeps([lowConfidenceEvent])
    const orch = createOrchestrator(d)
    const result = await orch.process(
      {
        postedAt: '2026-06-09T20:00:00+09:00',
        authorUserId: 'U1',
        channelId: 'C1',
        threadTs: '0.0',
        text: '来月どこかでピアノ発表会',
        prefixHint: null,
        modeHint: null,
        images: [],
      },
      'evt-2',
    )
    expect(result.kind).toBe('asked')
    expect(d.writer.writeAll).not.toHaveBeenCalled()
  })

  it('skips on duplicate slack event id', async () => {
    const d = buildDeps([highConfidenceEvent])
    const orch = createOrchestrator(d)
    await orch.process(
      { postedAt: '2026-06-09T20:00:00+09:00', authorUserId: 'U1', channelId: 'C1', threadTs: '0.0', text: '', prefixHint: null, modeHint: null, images: [] },
      'evt-dup',
    )
    const second = await orch.process(
      { postedAt: '2026-06-09T20:00:00+09:00', authorUserId: 'U1', channelId: 'C1', threadTs: '0.0', text: '', prefixHint: null, modeHint: null, images: [] },
      'evt-dup',
    )
    expect(second.kind).toBe('duplicate')
    expect(d.writer.writeAll).toHaveBeenCalledOnce()
  })

  it('returns empty when extractor finds no events', async () => {
    const d = buildDeps([])
    const orch = createOrchestrator(d)
    const result = await orch.process(
      { postedAt: '2026-06-09T20:00:00+09:00', authorUserId: 'U1', channelId: 'C1', threadTs: '0.0', text: '雑談', prefixHint: null, modeHint: null, images: [] },
      'evt-empty',
    )
    expect(result.kind).toBe('empty')
  })
})
```

- [ ] **Step 3: typecheck**

```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 4: テスト PASS を確認（Firestore Emulator 起動中）**

```bash
pnpm test:integration tests/integration/orchestrator.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 5: コミット**

```bash
git add src/pipeline/orchestrator.ts tests/integration/orchestrator.test.ts
git commit -m "feat(pipeline): orchestrate extract -> attribute -> route -> write -> reply"
```

---

## Task 24: Slack 署名検証ミドルウェア

**Files:**
- Create: `src/lib/slack-signature.ts`
- Create: `tests/unit/slack-signature.test.ts`

- [ ] **Step 1: `tests/unit/slack-signature.test.ts` を書く**

```ts
import { describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import { verifySlackSignature } from '~/lib/slack-signature'

const secret = 'test-secret-12345'

function sign(timestamp: string, body: string): string {
  const baseString = `v0:${timestamp}:${body}`
  const sig = createHmac('sha256', secret).update(baseString).digest('hex')
  return `v0=${sig}`
}

describe('verifySlackSignature', () => {
  it('returns true for valid signature with recent timestamp', () => {
    const ts = String(Math.floor(Date.now() / 1000))
    const body = '{"foo":"bar"}'
    const sig = sign(ts, body)
    expect(verifySlackSignature(body, ts, sig, secret)).toBe(true)
  })

  it('returns false for invalid signature', () => {
    const ts = String(Math.floor(Date.now() / 1000))
    expect(verifySlackSignature('{}', ts, 'v0=garbage', secret)).toBe(false)
  })

  it('returns false for stale timestamp (>5 min)', () => {
    const ts = String(Math.floor(Date.now() / 1000) - 600)
    const sig = sign(ts, '{}')
    expect(verifySlackSignature('{}', ts, sig, secret)).toBe(false)
  })

  it('returns false for missing signature', () => {
    expect(verifySlackSignature('{}', '0', '', secret)).toBe(false)
  })
})
```

- [ ] **Step 2: テスト FAIL を確認**

```bash
pnpm test:unit tests/unit/slack-signature.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: `src/lib/slack-signature.ts` を実装**

```ts
import { createHmac, timingSafeEqual } from 'node:crypto'

const MAX_AGE_SECONDS = 300

export function verifySlackSignature(
  rawBody: string,
  timestamp: string | null,
  signature: string | null,
  signingSecret: string,
): boolean {
  if (!timestamp || !signature) return false

  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return false
  const age = Math.abs(Date.now() / 1000 - ts)
  if (age > MAX_AGE_SECONDS) return false

  const baseString = `v0:${timestamp}:${rawBody}`
  const expected = `v0=${createHmac('sha256', signingSecret).update(baseString).digest('hex')}`

  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
```

- [ ] **Step 4: テスト PASS を確認**

```bash
pnpm test:unit tests/unit/slack-signature.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 5: コミット**

```bash
git add src/lib/slack-signature.ts tests/unit/slack-signature.test.ts
git commit -m "feat(lib): add Slack signing-secret verification with timing-safe compare"
```

---

## Task 25: Slack Events ハンドラ

**Files:**
- Create: `src/handlers/slack-events.ts`
- Create: `tests/fixtures/slack-events/message-text.json`

- [ ] **Step 1: fixture を作成**

```json
{
  "type": "event_callback",
  "team_id": "T123",
  "event_id": "Ev0001",
  "event_time": 1717920000,
  "event": {
    "type": "message",
    "user": "U_ALLOWED",
    "channel": "C123",
    "ts": "1717920000.000100",
    "thread_ts": "1717920000.000100",
    "text": "明日 10:00 から末っ子の検診",
    "files": []
  }
}
```

ファイルパス: `tests/fixtures/slack-events/message-text.json`

- [ ] **Step 2: `src/handlers/slack-events.ts` を作成**

```ts
import type { Context } from 'hono'
import { parsePrefix } from '~/pipeline/prefix-parser'
import type { SlackClient } from '~/adapters/slack'
import { logger } from '~/lib/logger'
import type { ExtractionInput } from '~/config/schema'

export type SlackMessageEvent = {
  type: 'message'
  subtype?: string
  user?: string
  bot_id?: string
  channel: string
  ts: string
  thread_ts?: string
  text?: string
  files?: Array<{ url_private: string; mimetype: string }>
}

export type SlackEventCallback = {
  type: 'event_callback' | 'url_verification'
  challenge?: string
  team_id?: string
  event_id?: string
  event_time?: number
  event?: SlackMessageEvent | { type: string }
}

export type EventsHandlerDeps = {
  slack: SlackClient
  allowedUserIds: Set<string>
  process: (input: ExtractionInput, slackEventId: string) => Promise<unknown>
}

export async function handleSlackEvent(
  c: Context,
  body: SlackEventCallback,
  deps: EventsHandlerDeps,
): Promise<Response> {
  if (body.type === 'url_verification') {
    return c.json({ challenge: body.challenge })
  }
  if (body.type !== 'event_callback') return c.body(null, 200)
  if (!body.event || body.event.type !== 'message') return c.body(null, 200)

  const event = body.event as SlackMessageEvent
  if (event.bot_id) return c.body(null, 200)
  if (event.subtype && event.subtype !== 'file_share') return c.body(null, 200)
  if (!event.user || !deps.allowedUserIds.has(event.user)) {
    logger.warn('slackEvents.unauthorizedUser', { user: event.user })
    return c.body(null, 200)
  }

  const slackEventId = body.event_id ?? `${body.team_id}-${event.ts}`
  const { prefixHint, modeHint, remainingText } = parsePrefix(event.text ?? '')

  const images: ExtractionInput['images'] = []
  for (const f of event.files ?? []) {
    const fetched = await deps.slack.getFileBytes(f.url_private)
    images.push({
      base64: Buffer.from(fetched.bytes).toString('base64'),
      mimeType: fetched.mimeType,
    })
  }

  const input: ExtractionInput = {
    postedAt: new Date((body.event_time ?? Number(event.ts)) * 1000).toISOString(),
    authorUserId: event.user,
    channelId: event.channel,
    threadTs: event.thread_ts ?? event.ts,
    text: remainingText,
    prefixHint,
    modeHint,
    images,
  }

  // 即時 ack のため process を fire-and-forget
  void deps
    .process(input, slackEventId)
    .catch((err) => logger.error('slackEvents.processFailed', { slackEventId, err: String(err) }))

  return c.body(null, 200)
}
```

- [ ] **Step 3: typecheck**

```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 4: コミット**

```bash
git add src/handlers/slack-events.ts tests/fixtures/slack-events/message-text.json
git commit -m "feat(handlers): add Slack message event handler with allowlist and prefix parsing"
```

---

## Task 26: Slack Reactions ハンドラ

**Files:**
- Create: `src/handlers/slack-reactions.ts`

- [ ] **Step 1: `src/handlers/slack-reactions.ts` を作成**

```ts
import type { CalendarWriter } from '~/pipeline/calendar-writer'
import type { SlackClient } from '~/adapters/slack'
import type { PendingStore } from '~/stores/pending'
import { logger } from '~/lib/logger'

export type ReactionAddedEvent = {
  type: 'reaction_added'
  user: string
  reaction: string
  item: { type: 'message'; channel: string; ts: string }
}

export type ReactionsHandlerDeps = {
  slack: SlackClient
  pending: PendingStore
  writer: CalendarWriter
  allowedUserIds: Set<string>
}

const APPROVE_EMOJIS = new Set(['white_check_mark', 'heavy_check_mark', '+1'])
const REJECT_EMOJIS = new Set(['x', 'no_entry', '-1'])

export async function handleReaction(
  event: ReactionAddedEvent,
  deps: ReactionsHandlerDeps,
): Promise<void> {
  if (!deps.allowedUserIds.has(event.user)) {
    logger.warn('reactions.unauthorizedUser', { user: event.user })
    return
  }

  const pending = await deps.pending.findByMessageTs(event.item.channel, event.item.ts)
  if (!pending || pending.status !== 'awaiting') return

  if (APPROVE_EMOJIS.has(event.reaction)) {
    const slackEventId = `pending-${pending.id}`
    const results = await deps.writer.writeAll(pending.events, slackEventId)
    await deps.pending.updateStatus(pending.id, 'approved')
    const text = `✅ 承認: ${results.length} 件を登録しました`
    await deps.slack.postThreadMessage(pending.slackChannelId, pending.slackThreadTs, text)
    logger.info('reactions.approved', { pendingId: pending.id, count: results.length })
    return
  }

  if (REJECT_EMOJIS.has(event.reaction)) {
    await deps.pending.updateStatus(pending.id, 'rejected')
    await deps.slack.postThreadMessage(pending.slackChannelId, pending.slackThreadTs, '❌ 破棄しました')
    logger.info('reactions.rejected', { pendingId: pending.id })
    return
  }
}
```

- [ ] **Step 2: typecheck**

```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 3: コミット**

```bash
git add src/handlers/slack-reactions.ts
git commit -m "feat(handlers): handle reaction_added for pending confirmation approval/rejection"
```

---

## Task 27: Hono サーバー

**Files:**
- Create: `src/server.ts`

- [ ] **Step 1: `src/server.ts` を作成**

```ts
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { buildChildren } from '~/config/children'
import { loadThresholdsFromEnv } from '~/config/thresholds'
import { createGeminiClient } from '~/adapters/gemini'
import { createCalendarClient } from '~/adapters/google-calendar'
import { createSlackClient } from '~/adapters/slack'
import { readSecret } from '~/adapters/secrets'
import { createExtractor } from '~/pipeline/extractor'
import { createCalendarWriter } from '~/pipeline/calendar-writer'
import { createOrchestrator } from '~/pipeline/orchestrator'
import { handleSlackEvent, type SlackEventCallback } from '~/handlers/slack-events'
import { handleReaction, type ReactionAddedEvent } from '~/handlers/slack-reactions'
import { getFirestore } from '~/stores/firestore-client'
import { createIdempotencyStore } from '~/stores/idempotency'
import { createPendingStore } from '~/stores/pending'
import { createAttributionHintsStore } from '~/stores/attribution-hints'
import { verifySlackSignature } from '~/lib/slack-signature'
import { logger } from '~/lib/logger'

async function bootstrap() {
  const projectId = process.env.GCP_PROJECT_ID!
  const region = process.env.GCP_REGION ?? 'asia-northeast1'

  const useSecretManager = process.env.NODE_ENV === 'production'

  const slackSigningSecret = useSecretManager
    ? await readSecret(projectId, 'slack-signing-secret')
    : process.env.SLACK_SIGNING_SECRET!
  const slackBotToken = useSecretManager
    ? await readSecret(projectId, 'slack-bot-token')
    : process.env.SLACK_BOT_TOKEN!
  const googleClientId = useSecretManager
    ? await readSecret(projectId, 'google-oauth-client-id')
    : process.env.GOOGLE_OAUTH_CLIENT_ID!
  const googleClientSecret = useSecretManager
    ? await readSecret(projectId, 'google-oauth-client-secret')
    : process.env.GOOGLE_OAUTH_CLIENT_SECRET!
  const googleRefreshToken = useSecretManager
    ? await readSecret(projectId, 'google-calendar-refresh-token')
    : process.env.GOOGLE_CALENDAR_REFRESH_TOKEN!

  const children = buildChildren(process.env)
  const thresholds = loadThresholdsFromEnv(process.env)

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
  const orchestrator = createOrchestrator({
    extractor,
    writer,
    slack,
    idempotency,
    pending,
    hints,
    children,
    thresholds,
  })

  const allowedUserIds = new Set((process.env.ALLOWED_USER_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean))

  const app = new Hono()

  app.get('/healthz', (c) => c.text('ok'))

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
```

- [ ] **Step 2: typecheck**

```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 3: ローカルでサーバーが起動するか smoke test**

```bash
# ダミー env を指定して起動だけ確認（fail はする可能性あるが、コンパイルが通っていれば OK）
GCP_PROJECT_ID=x SLACK_SIGNING_SECRET=x SLACK_BOT_TOKEN=x \
  GOOGLE_OAUTH_CLIENT_ID=x GOOGLE_OAUTH_CLIENT_SECRET=x GOOGLE_CALENDAR_REFRESH_TOKEN=x \
  CHILD1_CALENDAR_ID=x CHILD2_CALENDAR_ID=x CHILD3_CALENDAR_ID=x SELF_CALENDAR_ID=x \
  ALLOWED_USER_IDS=U1 \
  timeout 3 pnpm dev || true
```

Expected: `server.listening` ログが出る（その後 timeout で落ちる）。

- [ ] **Step 4: コミット**

```bash
git add src/server.ts
git commit -m "feat(server): bootstrap Hono app with Slack events route and signature verify"
```

---

## Task 28: Terraform で GCP リソースを管理

**Files:**
- Create: `infra/terraform/main.tf`
- Create: `infra/terraform/variables.tf`
- Create: `infra/terraform/outputs.tf`

- [ ] **Step 1: `infra/terraform/variables.tf` を作成**

```hcl
variable "project_id" {
  type        = string
  description = "GCP project ID"
}

variable "region" {
  type    = string
  default = "asia-northeast1"
}

variable "service_name" {
  type    = string
  default = "hanamaru"
}

variable "image" {
  type        = string
  description = "Container image URL"
}
```

- [ ] **Step 2: `infra/terraform/main.tf` を作成**

```hcl
terraform {
  required_version = ">= 1.7"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.36"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

locals {
  required_apis = [
    "run.googleapis.com",
    "firestore.googleapis.com",
    "secretmanager.googleapis.com",
    "aiplatform.googleapis.com",
    "artifactregistry.googleapis.com",
    "iam.googleapis.com",
    "cloudbuild.googleapis.com",
  ]
}

resource "google_project_service" "apis" {
  for_each           = toset(local.required_apis)
  service            = each.value
  disable_on_destroy = false
}

resource "google_firestore_database" "default" {
  name        = "(default)"
  location_id = var.region
  type        = "FIRESTORE_NATIVE"

  depends_on = [google_project_service.apis]
}

resource "google_artifact_registry_repository" "app" {
  location      = var.region
  repository_id = var.service_name
  format        = "DOCKER"

  depends_on = [google_project_service.apis]
}

resource "google_service_account" "runtime" {
  account_id   = "${var.service_name}-runtime"
  display_name = "Hanamaru Cloud Run runtime"
}

locals {
  runtime_roles = [
    "roles/aiplatform.user",
    "roles/secretmanager.secretAccessor",
    "roles/datastore.user",
    "roles/logging.logWriter",
  ]
}

resource "google_project_iam_member" "runtime_bindings" {
  for_each = toset(local.runtime_roles)
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.runtime.email}"
}

resource "google_secret_manager_secret" "secrets" {
  for_each = toset([
    "slack-signing-secret",
    "slack-bot-token",
    "google-oauth-client-id",
    "google-oauth-client-secret",
    "google-calendar-refresh-token",
  ])
  secret_id = each.value
  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

resource "google_cloud_run_v2_service" "hanamaru" {
  name     = var.service_name
  location = var.region

  template {
    service_account = google_service_account.runtime.email
    containers {
      image = var.image
      ports {
        container_port = 8080
      }

      env {
        name  = "GCP_PROJECT_ID"
        value = var.project_id
      }
      env {
        name  = "GCP_REGION"
        value = var.region
      }
      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "GEMINI_LOCATION"
        value = var.region
      }
      env {
        name  = "GEMINI_MODEL"
        value = "gemini-2.5-flash"
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }
    }
    scaling {
      min_instance_count = 0
      max_instance_count = 5
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_cloud_run_v2_service_iam_member" "public_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.hanamaru.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
```

- [ ] **Step 3: `infra/terraform/outputs.tf` を作成**

```hcl
output "cloud_run_url" {
  value = google_cloud_run_v2_service.hanamaru.uri
}

output "artifact_registry_repo" {
  value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.app.repository_id}"
}

output "runtime_sa_email" {
  value = google_service_account.runtime.email
}
```

- [ ] **Step 4: `terraform init` で構文確認**

```bash
cd infra/terraform
terraform init -backend=false
terraform validate
cd ../..
```

Expected: `Success! The configuration is valid.`

- [ ] **Step 5: コミット**

```bash
git add infra/terraform/
git commit -m "infra: terraform for Cloud Run, Firestore, Secret Manager, Artifact Registry"
```

---

## Task 29: GitHub Actions CI ワークフロー

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: `.github/workflows/ci.yml` を作成**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      - run: pnpm typecheck

      - run: pnpm lint

      - name: Setup gcloud
        uses: google-github-actions/setup-gcloud@v2
        with:
          install_components: 'beta'

      - name: Start Firestore Emulator
        run: |
          gcloud beta emulators firestore start --host-port=localhost:8085 &
          sleep 5

      - name: Run tests
        env:
          FIRESTORE_EMULATOR_HOST: localhost:8085
        run: pnpm test
```

- [ ] **Step 2: コミット**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add GitHub Actions workflow for typecheck/lint/test"
```

---

## Task 30: GitHub Actions デプロイワークフロー

**Files:**
- Create: `.github/workflows/deploy.yml`
- Create: `scripts/deploy.sh`

- [ ] **Step 1: `.github/workflows/deploy.yml` を作成**

```yaml
name: Deploy

on:
  push:
    branches: [main]
  workflow_dispatch:

env:
  REGION: asia-northeast1
  SERVICE: hanamaru

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write

    steps:
      - uses: actions/checkout@v4

      - id: auth
        uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ secrets.GCP_WIF_PROVIDER }}
          service_account: ${{ secrets.GCP_DEPLOY_SA }}

      - uses: google-github-actions/setup-gcloud@v2

      - name: Configure docker for Artifact Registry
        run: gcloud auth configure-docker ${{ env.REGION }}-docker.pkg.dev

      - name: Build and push image
        run: |
          IMAGE="${{ env.REGION }}-docker.pkg.dev/${{ secrets.GCP_PROJECT_ID }}/${{ env.SERVICE }}/${{ env.SERVICE }}:${{ github.sha }}"
          docker build -t "$IMAGE" .
          docker push "$IMAGE"
          echo "IMAGE=$IMAGE" >> "$GITHUB_ENV"

      - name: Deploy to Cloud Run (no traffic)
        run: |
          gcloud run deploy ${{ env.SERVICE }} \
            --image="$IMAGE" \
            --region=${{ env.REGION }} \
            --no-traffic \
            --tag=sha-${{ github.sha }} \
            --quiet
```

- [ ] **Step 2: `scripts/deploy.sh` を作成（手動 promote 用）**

```bash
#!/usr/bin/env bash
set -euo pipefail

REGION="${REGION:-asia-northeast1}"
SERVICE="${SERVICE:-hanamaru}"

if [[ -z "${1:-}" ]]; then
  echo "Usage: $0 <tag>"
  echo "Example: $0 sha-abc1234"
  exit 1
fi

TAG="$1"

gcloud run services update-traffic "$SERVICE" \
  --region="$REGION" \
  --to-tags="$TAG=100"

echo "Promoted $TAG to 100% traffic on $SERVICE"
```

- [ ] **Step 3: 実行権限を付与**

```bash
chmod +x scripts/deploy.sh
```

- [ ] **Step 4: コミット**

```bash
git add .github/workflows/deploy.yml scripts/deploy.sh
git commit -m "ci: add deploy workflow with workload identity and manual promote script"
```

---

## Task 31: Slack App manifest

**Files:**
- Create: `infra/slack-manifest.yaml`

- [ ] **Step 1: `infra/slack-manifest.yaml` を作成**

```yaml
display_information:
  name: Hanamaru
  description: 家族のスケジュールを Slack 投稿から AI 抽出して Google Calendar に登録
features:
  bot_user:
    display_name: Hanamaru
    always_online: true
oauth_config:
  scopes:
    bot:
      - channels:history
      - chat:write
      - files:read
      - reactions:read
      - reactions:write
      - users:read
settings:
  event_subscriptions:
    request_url: https://REPLACE_WITH_CLOUD_RUN_URL/slack/events
    bot_events:
      - message.channels
      - reaction_added
  interactivity:
    is_enabled: false
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

- [ ] **Step 2: コミット**

```bash
git add infra/slack-manifest.yaml
git commit -m "infra: add Slack App manifest with required scopes and event subs"
```

---

## Task 32: OAuth 認証スクリプト（refresh token 取得）

**Files:**
- Create: `scripts/auth-google.ts`

- [ ] **Step 1: `scripts/auth-google.ts` を作成**

```ts
import { google } from 'googleapis'
import http from 'node:http'
import { URL } from 'node:url'

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET
const PORT = 4000
const REDIRECT_URI = `http://localhost:${PORT}/oauth/callback`
const SCOPE = ['https://www.googleapis.com/auth/calendar.events']

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET first.')
  process.exit(1)
}

const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI)
const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: SCOPE,
})

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  if (url.pathname !== '/oauth/callback') {
    res.writeHead(404)
    res.end()
    return
  }
  const code = url.searchParams.get('code')
  if (!code) {
    res.writeHead(400)
    res.end('No code in callback')
    return
  }
  const { tokens } = await oauth2.getToken(code)
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('OK. You can close this tab.')
  console.log('\n--- Refresh token (store in Secret Manager) ---')
  console.log(tokens.refresh_token)
  console.log('-----------------------------------------------\n')
  server.close()
})

server.listen(PORT, () => {
  console.log('Open this URL in your browser to authorize:')
  console.log(authUrl)
})
```

- [ ] **Step 2: package.json にスクリプトを追加**

```bash
# package.json の "scripts" に追加（手動編集）:
#   "auth:google": "tsx scripts/auth-google.ts"
```

`package.json` の `scripts` セクションをエディタで開き、以下を追加：

```json
"auth:google": "tsx scripts/auth-google.ts"
```

- [ ] **Step 3: typecheck**

```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 4: コミット**

```bash
git add scripts/auth-google.ts package.json
git commit -m "feat(scripts): add OAuth flow to obtain Google Calendar refresh token"
```

---

## Task 33: Attribution Hints 初期投入スクリプト

**Files:**
- Create: `scripts/seed-config.ts`

- [ ] **Step 1: `scripts/seed-config.ts` を作成**

```ts
import { Firestore } from '@google-cloud/firestore'
import { createAttributionHintsStore } from '~/stores/attribution-hints'
import { buildChildren } from '~/config/children'

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
```

- [ ] **Step 2: package.json にスクリプトを追加**

`package.json` の `scripts` に追加：

```json
"seed:config": "tsx scripts/seed-config.ts"
```

- [ ] **Step 3: typecheck**

```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 4: コミット**

```bash
git add scripts/seed-config.ts package.json
git commit -m "feat(scripts): seed attribution_hints from CHILDREN config contexts"
```

---

## Task 34: README

**Files:**
- Create: `README.md`

- [ ] **Step 1: `README.md` を作成**

````markdown
# Hanamaru 🌸

AI scheduling agent that watches Slack and writes Google Calendar entries for the family.

Built for the [Rapid Agent Hackathon](https://rapid-agent.devpost.com/).

## What it does

Post a photo of your kid's school newsletter to a Slack channel. Hanamaru reads it (text + image),
extracts the events, and writes them to the right Google Calendar — one per child. High-confidence
extractions go straight to the calendar; ambiguous ones ask for your confirmation in the same thread.

```
[ Slack post: photo/text ]
         │
         ▼
[ Vertex AI Gemini 2.5 Flash ]
         │
         ▼
[ Google Calendar (per child) ]
```

## Stack

- TypeScript + Hono on Cloud Run (asia-northeast1)
- Vertex AI Gemini 2.5 Flash for extraction (vision + structured output)
- Firestore for idempotency + pending confirmations + attribution hints
- Slack Events API
- Google Calendar API
- All auth via GCP ADC; only Slack & OAuth secrets in Secret Manager

## Quickstart (local dev)

```bash
pnpm install
cp .env.example .env.local && $EDITOR .env.local

# Start Firestore emulator (separate terminal)
pnpm emulator:firestore

# Dev server with hot reload
pnpm dev

# Forward to Slack via ngrok
ngrok http 8080
```

## Tests

```bash
pnpm test          # unit + integration (emulator required)
pnpm test:unit     # fast, no emulator
```

## Deployment

See `docs/operations.md` for the full runbook.

## Docs

- [Design spec](docs/superpowers/specs/2026-06-06-hanamaru-design.md)
- [Implementation plan](docs/superpowers/plans/2026-06-07-hanamaru-phase1.md)
- [Operations runbook](docs/operations.md)

## License

MIT
````

- [ ] **Step 2: コミット**

```bash
git add README.md
git commit -m "docs: add README with quickstart and stack overview"
```

---

## Task 35: Operations Runbook

**Files:**
- Create: `docs/operations.md`

- [ ] **Step 1: `docs/operations.md` を作成**

````markdown
# Hanamaru Operations Runbook

## Initial Setup (one-time)

1. **GCP project**
   ```bash
   gcloud projects create hanamaru-prod
   gcloud config set project hanamaru-prod
   gcloud beta billing projects link hanamaru-prod --billing-account=YOUR_BILLING_ID
   ```

2. **Terraform apply**
   ```bash
   cd infra/terraform
   terraform init
   terraform apply -var="project_id=hanamaru-prod" -var="image=asia-northeast1-docker.pkg.dev/hanamaru-prod/hanamaru/hanamaru:initial"
   ```
   (`image` を一度仮置きする。後でデプロイ後に置き換える)

3. **Slack App**
   - Slack 管理画面で新規 App 作成 → "From an app manifest"
   - `infra/slack-manifest.yaml` を貼り付け（`request_url` は Cloud Run URL に置換）
   - Install to workspace → Bot Token を取得

4. **Secret Manager に登録**
   ```bash
   echo -n "<slack signing secret>" | gcloud secrets versions add slack-signing-secret --data-file=-
   echo -n "<slack bot token>"     | gcloud secrets versions add slack-bot-token --data-file=-
   echo -n "<oauth client id>"     | gcloud secrets versions add google-oauth-client-id --data-file=-
   echo -n "<oauth client secret>" | gcloud secrets versions add google-oauth-client-secret --data-file=-
   ```

5. **Google OAuth クライアント**
   - GCP Console → APIs & Services → Credentials → Create OAuth 2.0 Client
   - Authorized redirect URI: `http://localhost:4000/oauth/callback`
   - Client ID / Secret を上記 Secret Manager にも反映

6. **Refresh token を取得**
   ```bash
   GOOGLE_OAUTH_CLIENT_ID=... GOOGLE_OAUTH_CLIENT_SECRET=... pnpm auth:google
   # Browser opens, authorize, refresh token is printed
   echo -n "<refresh token>" | gcloud secrets versions add google-calendar-refresh-token --data-file=-
   ```

7. **Attribution hints の初期投入**
   ```bash
   GCP_PROJECT_ID=hanamaru-prod \
     CHILD1_CALENDAR_ID=... CHILD1_SCHOOL=... CHILD1_JUKU=... \
     CHILD2_CALENDAR_ID=... CHILD2_SCHOOL=... CHILD2_JUKU=... \
     CHILD3_CALENDAR_ID=... CHILD3_DAYCARE=... \
     SELF_CALENDAR_ID=... \
     pnpm seed:config
   ```

8. **初回デプロイ**
   - GitHub Actions の `Deploy` workflow を `workflow_dispatch` で起動
   - 完了後、`scripts/deploy.sh sha-<commit>` で 100% トラフィック切替

9. **Slack Event URL を Cloud Run URL に設定**
   - Slack App 設定 → Event Subscriptions → Request URL を更新
   - Verify が通れば OK

10. **`#hanamaru` に bot を invite**
    ```
    /invite @Hanamaru
    ```

11. **`ALLOWED_USER_IDS` を Cloud Run に設定**
    ```bash
    gcloud run services update hanamaru \
      --region=asia-northeast1 \
      --update-env-vars=ALLOWED_USER_IDS=U_YOUR_ID
    ```

## Daily ops

### View logs

```bash
gcloud logging read 'resource.type=cloud_run_revision AND resource.labels.service_name=hanamaru' --limit=50 --format=json
```

### Rollback

```bash
gcloud run services update-traffic hanamaru --region=asia-northeast1 --to-revisions=PREVIOUS_REVISION=100
```

### Rotate Slack secrets

1. Slack Admin で signing secret / bot token を再発行
2. `gcloud secrets versions add ... --data-file=-` で新バージョンを追加
3. Cloud Run リビジョンを再デプロイ（または Secret reference を新バージョンに）

### Rotate Google refresh token

`pnpm auth:google` をローカルで再実行 → 新トークンを Secret Manager に追加。

## E2E manual checklist (before release)

```text
☐ 単純テキスト投稿（高信頼）→ Calendar 登録
☐ 学校だより画像 → 複数イベント抽出
☐ 曖昧投稿 → 確認質問 → ✅ で登録
☐ #長女 prefix → 長女のカレンダー
☐ ❌ → 登録済み削除
☐ Slack retry シミュレート → 重複登録なし
```

## Common issues

- **Slack signature verification fails locally:** Make sure ngrok is forwarding to port 8080 and the Slack App request URL is the ngrok URL.
- **Firestore emulator not found in tests:** Run `pnpm emulator:firestore` before `pnpm test:integration`.
- **Vertex AI 403:** SA `hanamaru-runtime@` lacks `roles/aiplatform.user`. Re-apply Terraform.
- **OAuth refresh token revoked:** Re-run `pnpm auth:google` and update the secret.
````

- [ ] **Step 2: コミット**

```bash
git add docs/operations.md
git commit -m "docs: add operations runbook for setup, deploy, and troubleshooting"
```

---

## Final verification

- [ ] **Step 1: 全テストが PASS することを確認**

Firestore Emulator が別ターミナルで動いている前提：

```bash
pnpm test
```

Expected: 全 unit + integration テストが pass。

- [ ] **Step 2: typecheck と lint**

```bash
pnpm typecheck && pnpm lint
```

Expected: no errors.

- [ ] **Step 3: スペックの DoD と照合**

`docs/superpowers/specs/2026-06-06-hanamaru-design.md` の「付録 A: Phase 1 完了の定義」を見て、未達のチェックボックスがないか確認：

```
- [x] テキスト投稿で高信頼イベントが自動登録される    (Task 23 で検証)
- [x] 画像添付投稿で vision 抽出が動く             (Task 25 ハンドラ + Task 13 アダプタ)
- [x] prefix が機能する                              (Task 7 + Task 8)
- [x] 低信頼ケースで確認メッセージが出る、✅/❌ で動く (Task 22 + Task 26)
- [x] 同じ Slack イベントの再送で重複登録されない    (Task 17 + Task 23)
- [x] Cloud Run / Firestore / Secret Manager が Terraform で再現可能 (Task 28)
- [x] GitHub Actions で CI が回る                    (Task 29)
- [x] docs/operations.md を見て他人がセットアップを完走できる (Task 35)
- [x] 主要 E2E シナリオ 3 本を手動で確認             (Task 35 のチェックリスト)
```

- [ ] **Step 4: タグを打って Phase 1 完了**

```bash
git tag -a v0.1.0 -m "Phase 1 complete: Slack -> AI -> Calendar loop working"
```

---

## Notes

- **Parallelization opportunities:** Tasks 13 / 14 / 15 (adapters) は互いに独立で並行作業可能。Tasks 17 / 18 / 19 (stores) も同様。
- **First deployable checkpoint:** Task 27 完了時点で `pnpm dev` + ngrok によりローカル E2E が動く。
- **First production checkpoint:** Task 30 完了時点でデプロイ可能。Task 32 (OAuth) と Task 33 (seed) はセットアップ runbook 内で実行。
- **TDD discipline:** 各タスクで「先にテスト → FAIL 確認 → 最小実装 → PASS 確認」のサイクルを守る。
- **Commit hygiene:** タスクごとに 1 コミット。構造変更と動作変更は分けない（タスクが小さく分離されているので問題なし）。
