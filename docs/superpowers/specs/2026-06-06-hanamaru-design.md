# Hanamaru — 設計ドキュメント

- **日付**: 2026-06-06
- **ステータス**: Draft (ブレスト後、レビュー前)
- **対象スコープ**: Phase 1 MVP
---

## 1. 背景と課題

小学校高学年の子ども 2 人と保育園児 1 人、計 3 人の子育てをしている親が抱える、毎日のスケジューリング負荷を AI エージェントで吸収する。

### 現状のペインポイント

- 学校・塾・習い事・保育園からの通知が LINE、メール、習い事専用アプリなど多チャネルに分散
- 親が手動でコピーして Google Calendar に転記している
- 業務予定や兄弟姉妹の予定が重なるたびに調整が必要
- これらの作業が膨大な認知負荷とタイムロスを生んでいる

### 目指す姿

AI エージェントが各チャネルをウォッチし、以下を自律的にこなす：

1. カレンダーの自動更新
2. Slack 経由での予定サジェスト
3. 重複した予定の調整支援

本ドキュメントはこのうち **Phase 1（カレンダーの自動更新を Slack 起点で実現する）** の設計を扱う。

---

## 2. フェーズ分解

```text
Phase 1 (本書):  Slack 投稿（テキスト + 画像）→ AI 抽出 → Google Calendar 登録
                + Slack スレッドでの確認 / 自動登録通知

Phase 2:        LINE / 習い事アプリ等の自動取り込み
                + Slack 上での修正・承認 UI の本格化

Phase 3:        コンフリクト検出（家族間の重複）+ 調整提案
                + 双方向同期（Google Calendar 編集 → エージェントが学習）
```

Phase 1 を最小ループ（価値が出る最初の完成形）として完成させ、運用しながら Phase 2 以降へ拡張する。

---

## 3. Phase 1 ゴール / ノンゴール

### ゴール

- 親が Slack `#hanamaru` チャネルに投稿（テキスト or LINE/アプリのスクショ画像）
- AI が予定情報を抽出し、適切な Google Calendar に書き込む
- 高信頼の抽出は自動登録、低信頼の抽出は Slack スレッドで確認
- prefix（`#長女` 等）でユーザーが属性・モードを明示できる
- 1 投稿から複数イベントを抽出可能
- 重複処理（Slack の retry）に耐える冪等性

### ノンゴール（Phase 1）

- LINE / 習い事アプリからの自動取り込み（手動スクショ転送で代替）
- リマインダー機能（Google Calendar 標準で代替）
- 既存イベントの更新・キャンセル検出
- コンフリクト検出
- 複数ユーザー対応（配偶者・祖父母の招待）
- スラッシュコマンド

---

## 4. アーキテクチャ全体像

### システムコンテキスト

```text
┌─────────────────────────────────────────────────────────────────────┐
│  User (parent)                                                       │
│  LINE / 習い事アプリの通知をスクショ → Slack に投稿                   │
└─────────────────────────┬───────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Slack workspace #hanamaru                                           │
│  - text + 画像投稿                                                   │
│  - スレッドで AI と対話 / リアクションで承認                          │
└─────────────────────────┬───────────────────────────────────────────┘
                          │ Events API webhook (HTTPS POST)
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Cloud Run: hanamaru (TS / Hono)                                    │
│  1. signature verify (Slack signing secret)                         │
│  2. 3 秒以内に 200 OK 返却                                          │
│  3. 後段処理を waitUntil() で非同期起動                              │
│                                                                     │
│  ┌─────────────┬───────────────┬───────────────┐                  │
│  │ Idempotency │ Extractor     │ Replier        │                  │
│  │ (Firestore) │ (Vertex AI)   │ (Slack)        │                  │
│  └─────────────┴───────────────┴───────────────┘                  │
│                          │                                          │
│                          ▼                                          │
│                  Calendar Writer (Google Calendar)                  │
└─────────────────────────────────────────────────────────────────────┘
              │                  │                    │
              ▼                  ▼                    ▼
       [Firestore]      [Secret Manager]      [Cloud Logging]
       - 重複判定        - Slack secrets       - 監査ログ
       - pending 確認    - Google OAuth        - エラー追跡
       - 属性辞書        (Vertex AI は ADC)
```

### キーアーキテクチャ判断

| 判断 | 選択 | 理由 |
|---|---|---|
| 即時 ack | 同一インスタンス内で `waitUntil` 相当 | Cloud Tasks 不要、Phase 1 の流量で十分。Phase 2 で worker 分離可 |
| LLM | **Google Gemini (Vertex AI)** | GCP 完結で ADC 認証、低レイテンシ、API キー管理不要 |
| 永続化 | Firestore (Native mode) | サーバレス、スケール 0、無料枠で十分、TTL で自動削除 |
| シークレット | Secret Manager | Slack secrets と Google OAuth のみ。Vertex AI は ADC |
| 可観測性 | Cloud Logging + 致命時のみ Slack DM | 別途 SaaS 不要 |
| 言語 | **TypeScript (Hono)** | 型安全、Cloud Run コールドスタート速い、Slack Block Kit との親和性 |

### デプロイ構成

- **GCP プロジェクト**: `hanamaru-prod` / `hanamaru-dev`
- **リージョン**: `asia-northeast1` (Tokyo)
- **サービス**: Cloud Run 1 個 (`hanamaru`) + Firestore 1 個
- **CI/CD**: GitHub Actions → Artifact Registry → Cloud Run（手動 promote）
- **min-instances**: 0 から開始。3 秒 ack に余裕がなければ 1 に上げる
- **コスト見積**: 月 $1〜5 程度（Gemini Flash + Firestore 無料枠 + Cloud Run 軽量）

---

## 5. コンポーネントとデータモデル

### モジュール構成

```text
src/
├── server.ts                  # Hono アプリのエントリ
├── handlers/
│   ├── slack-events.ts        # message.channels イベント受信
│   ├── slack-reactions.ts     # reaction_added で ✅/❌/✏️ 処理
│   └── slack-commands.ts      # スラッシュコマンド（将来）
├── pipeline/
│   ├── orchestrator.ts        # 抽出→属性付け→登録の全体制御
│   ├── extractor.ts           # Gemini API 呼び出し（function calling + vision）
│   ├── attributor.ts          # AI 判定 + prefix 解析 + ask-back 判定
│   ├── confidence.ts          # 自動登録 vs 確認の閾値判定
│   ├── calendar-writer.ts     # Google Calendar API クライアント
│   └── replier.ts             # Slack スレッド返信
├── stores/
│   ├── idempotency.ts         # Firestore: 重複処理ガード
│   ├── pending.ts             # Firestore: 確認待ちイベント
│   └── attribution-hints.ts   # Firestore: 学習辞書
├── adapters/
│   ├── slack.ts               # @slack/web-api ラッパ
│   ├── google-calendar.ts     # googleapis ラッパ
│   ├── gemini.ts              # @google/genai ラッパ
│   └── secrets.ts             # Secret Manager クライアント
├── config/
│   ├── children.ts            # 子の定義（匿名 ID、カレンダー ID、所属）
│   └── schema.ts              # Zod スキーマ集約
└── lib/
    ├── logger.ts              # 構造化ログ
    └── errors.ts              # カスタム例外
```

**設計原則**：
- `pipeline/` 配下は外部 API を直接叩かず、必ず `adapters/` 経由 → テストでモックしやすい
- ビジネスロジック（属性付け、信頼度判定）はピュア関数中心 → 単体テスト容易
- `config/children.ts` は環境変数 + Firestore のハイブリッド（型定義は静的、実名・カレンダー ID は環境変数）

### Firestore コレクション

```ts
// processed_events/{slackEventId}
{
  slackEventId: string
  processedAt: Timestamp
  resultSummary: 'created' | 'pending' | 'rejected' | 'failed'
  createdEventIds: string[]
  ttlAt: Timestamp                 // 30 日後に自動削除
}

// pending_confirmations/{confirmationId}
{
  slackChannelId: string
  slackThreadTs: string
  slackMessageTs: string            // 確認メッセージの ts (リアクション検知用)
  events: ExtractedEvent[]
  createdAt: Timestamp
  expiresAt: Timestamp              // 7 日後失効
  status: 'awaiting' | 'approved' | 'rejected' | 'expired'
}

// attribution_hints/{normalizedKey}
{
  key: string                       // 正規化済みキーワード
  childId: 'child1' | 'child2' | 'child3' | 'self'
  source: 'manual' | 'learned' | 'config'
  hitCount: number
  lastUsedAt: Timestamp
}
```

### 抽出イベントスキーマ

```ts
import { z } from 'zod'

const ChildId = z.enum(['child1', 'child2', 'child3', 'self', 'unknown'])

export const ExtractedEvent = z.object({
  title: z.string(),
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
```

### `config/children.ts`

```ts
export const CHILDREN = {
  child1: {
    label: '長女',
    calendarId: process.env.CHILD1_CALENDAR_ID!,
    aliases: ['長女', '姉', process.env.CHILD1_NAME!],
    contexts: [process.env.CHILD1_SCHOOL!, process.env.CHILD1_JUKU!],
  },
  child2: { /* 同様 */ },
  child3: { /* 同様 */ },
  self: {
    label: '自分',
    calendarId: process.env.SELF_CALENDAR_ID!,
    aliases: ['自分', '私', '俺'],
    contexts: [],
  },
} as const
```

**プライバシー**: 実名・学校名・塾名・保育園名は Secret Manager 経由の環境変数で注入。コード・Git リポジトリには `child1` 等の匿名 ID しか残らない。

---

## 6. AI 抽出パイプライン（Gemini）

### モデル選択

- **デフォルト**: `gemini-2.5-flash`（コスト・レイテンシ・品質のバランス）
- **fallback**: `gemini-2.5-pro`（低信頼ケースの再投入、PDF など複雑な画像）

### SDK と認証

- **SDK**: `@google/genai` (Vertex AI 経由)
- **認証**: Application Default Credentials (ADC) — Cloud Run の SA に `roles/aiplatform.user`
- **エンドポイント**: `asia-northeast1`

Anthropic API キー管理が不要、課金は GCP の請求書 1 本にまとまる、レイテンシは Tokyo 内で完結。

### 入力の正規化

```ts
type ExtractionInput = {
  postedAt: string              // ISO 8601, JST。相対日時の解決基準
  authorUserId: string
  channelId: string
  threadTs: string
  text: string
  prefixHint: 'child1' | 'child2' | 'child3' | 'self' | null
  modeHint: 'force-ask' | 'force-auto' | null
  images: Array<{ base64: string; mimeType: string }>
}
```

### Structured Output（controlled generation）

```ts
const response = await ai.models.generateContent({
  model: 'gemini-2.5-flash',
  contents: [{
    role: 'user',
    parts: [
      ...input.images.map(img => ({
        inlineData: { mimeType: img.mimeType, data: img.base64 },
      })),
      { text: input.text },
    ],
  }],
  config: {
    systemInstruction: buildSystemInstruction(input.postedAt),
    responseMimeType: 'application/json',
    responseSchema: extractionResponseSchema,
    temperature: 0.2,
  },
})

const parsed = ExtractionResponse.parse(JSON.parse(response.text))
```

`responseSchema` で JSON 妥当性を Vertex AI 側が保証 → Zod で再パースして型回収（防御的に二重チェック）。

### System Instruction の構造

家族構成（匿名 ID + 所属コンテキスト）、抽出ルール、日時解決の基準（投稿日時を JST で渡す）を含む。詳細は実装時にプロンプト管理ファイルで一元管理。

### Context Caching

- Phase 1 は **暗黙的キャッシュ依存**で開始（Gemini 2.5 系は同一プレフィックスを自動キャッシュ）
- 観測してコスト最適化が必要なら **明示的キャッシュ** (`createCachedContent`) を導入

### 属性決定ロジック（attributor）

```text
for each event:
  if modeHint != null and prefixHint != null:
    event.attributedTo = prefixHint
    event.attributionConfidence = 1.0
  elif event.attributedTo == 'unknown' or event.attributionConfidence < 0.7:
    → 辞書 attribution_hints と文字列マッチを試みる
    → それでも unknown なら「確認」候補に積む
  else:
    → そのまま採用
```

ユーザーが ✅ を押した投稿からは新規キーワードを `attribution_hints` に追加（軽量な学習ループ）。

### 信頼度判定（confidence）

```ts
const isHighConfidence = (e: ExtractedEvent) =>
  e.attributionConfidence >= 0.8 &&
  e.datetimeConfidence >= 0.8 &&
  e.attributedTo !== 'unknown'

const route = isHighConfidence(event) ? 'auto-register' : 'ask'
```

- 初期閾値は保守的に設定（誤登録 0 を 1〜2 週間確認してから緩める）
- 閾値は `config/thresholds.ts` で一元管理、Firestore から動的上書き可能
- `#?` で常に ask、`#!!` で常に auto-register（信頼度無視）

### 並列実行

- 1 投稿 = 1 Gemini 呼び出し（マルチイベントでも 1 回）
- 抽出 → 属性 → 信頼度 → 書き込み は直列
- 複数イベントの Calendar 書き込みは `Promise.all` で並列
- Slack 返信は書き込み完了後に 1 回（複数結果をまとめて表示）

### エラーフォールバック

| 失敗ケース | 挙動 |
|---|---|
| Vertex AI 429/5xx | 指数バックオフ 3 回 (1s/4s/16s)、失敗時 Slack に通知 |
| `RECITATION` / `SAFETY` ブロック | Slack で「内容が読み取れませんでした」+ Cloud Logging に詳細 |
| `MAX_TOKENS` 切断 | 分割再投入 |
| Zod パース失敗 | 1 回だけ再呼び出し、それでも失敗で human-readable エラー |
| Vision 読み取り失敗 | テキストのみで再試行、最終的に確認質問 |
| `events: []`（雑談判定） | 軽量返信「予定情報を検出できませんでした」 |

---

## 7. Slack インタラクションパターン

### Slack App 構成

**OAuth Scopes**:
- `channels:history` — 投稿読み取り
- `chat:write` — スレッド返信
- `files:read` — 画像取得
- `reactions:read` / `reactions:write` — リアクション検知・送信
- `users:read` — 投稿者識別

**Event Subscriptions**:
- `message.channels` — 新規投稿
- `reaction_added` — ✅/❌/✏️

**Bot 設定**:
- `#hanamaru` に invite
- 投稿者が allowlist の Slack ID（自分）のときのみ処理
- bot 自身の投稿は早期 return

### 投稿構文

```text
[#長女 | #長男 | #末っ子 | #自分 | #? | #!!] {本文 / 画像添付}
```

- 属性 prefix: `#長女` `#長男` `#末っ子` `#自分`
- モード prefix: `#?`（確認強制）/ `#!!`（自動登録強制）
- 併用可能。行頭のみ解釈、本文中の `#hashtag` は無視

### Bot 返信パターン

**パターン 1: 高信頼・自動登録（単一イベント）**

```
🤖 Hanamaru:
✅ 1 件登録しました

📅 **遠足（末っ子）**
6/10(水) 9:00 – 14:00
📍 ○○公園
> Google Calendar で開く ↗

※ 修正は ✏️、取り消しは ❌
```

**パターン 2: 複数イベント・自動登録**

```
🤖 Hanamaru:
✅ 3 件登録しました（末っ子 2 件 / 長女 1 件）

1️⃣ 📅 遠足（末っ子）6/10(水) 9:00–14:00 ↗
2️⃣ 📅 検診（末っ子）6/15(月) 10:00–11:00 ↗
3️⃣ 📅 保護者会（長女）6/20(土) 14:00–16:00 ↗

※ 個別修正は番号返信、まとめて取り消しは ❌
```

**パターン 3: 低信頼・確認ファースト**

```
🤖 Hanamaru:
🤔 以下で登録してよいですか？

📅 **ピアノ発表会**（誰の予定か不明）
⚠️ 日時が曖昧: 「来月のどこか」→ 仮に 7/1 終日として保留
⚠️ 誰の予定か判別できませんでした

応答:
- ✅ そのまま登録
- ❌ 破棄
- 「#長男 7/15 14:00 から」のように詳細を返信
```

**パターン 4: 雑談判定**

```
🤖 Hanamaru:
📭 予定情報を検出できませんでした
```

**パターン 5: エラー**

```
🤖 Hanamaru:
⚠️ 抽出に失敗しました（モデル側エラー）
少し時間をおいて再投稿してください
```

### リアクションマッピング

| Reaction | 対象 | 挙動 |
|---|---|---|
| ✅ | bot の確認メッセージ | 全件 Calendar 登録 |
| ❌ | bot の確認メッセージ | pending 破棄 |
| ❌ | bot の自動登録通知 | 登録済みを削除 |
| ✏️ | bot の自動登録通知 | 「どこを修正？」と質問 |
| 1️⃣2️⃣… | 複数登録通知 | 番号に対応するイベントだけ操作対象に絞る |

### スレッド運用ルール

- bot 返信は必ず元投稿のスレッドへ
- スレッド内のユーザー追加返信 → 再抽出を試みる
- 確定済み（✅ or ❌）スレッドは「クローズ」扱いで以降のイベントはログのみ

---

## 8. 認証・冪等性・エラーハンドリング

### Secret Manager 一覧

| シークレット名 | 用途 |
|---|---|
| `slack-signing-secret` | webhook 検証 |
| `slack-bot-token` | bot からの送信 |
| `google-calendar-refresh-token` | Calendar 書き込み |
| `google-oauth-client-id` | OAuth クライアント |
| `google-oauth-client-secret` | OAuth クライアント |

Vertex AI は ADC のため鍵不要。Cloud Run の SA に：
- `roles/aiplatform.user`
- `roles/secretmanager.secretAccessor`
- `roles/datastore.user` (Firestore)

### Slack webhook 検証

- `x-slack-request-timestamp` の ±5 分以内チェック（リプレイ対策）
- HMAC-SHA256 で署名検証、定数時間比較
- 失敗時は 401 を即返却

### Google Calendar 認証

- 初回: `scripts/auth-google.ts` で OAuth フロー → refresh token を Secret Manager に保存
- 実行時: `googleapis` が refresh token から access token を自動更新
- Scope: `https://www.googleapis.com/auth/calendar.events`

### 冪等性

**Slack event 単位**:

```ts
const idempotencyKey = `${event.team_id}:${event.event_id}`
const existing = await idempotencyStore.get(idempotencyKey)
if (existing) return existing  // 重複処理スキップ

const acquired = await idempotencyStore.tryAcquire(idempotencyKey, ttl: '30d')
if (!acquired) return  // 並行処理を防止

try {
  const result = await processEvent(event)
  await idempotencyStore.complete(idempotencyKey, result)
} catch (e) {
  await idempotencyStore.markFailed(idempotencyKey, e)
  throw e
}
```

**Calendar 書き込み単位**:

```ts
const eventId = `hnm-${slackEventId}-${eventIndex}` // hanamaru prefix
await calendar.events.insert({
  calendarId,
  requestBody: { id: eventId, ...payload },
})
// 重複 insert は 409 / no-op
```

### エラーハンドリング階層

```text
[user-visible]   Slack に分かりやすいメッセージ
       │
[recoverable]    自動リトライ（指数バックオフ）
       │
[transient]      Cloud Logging WARN
       │
[fatal]          管理者 DM + Cloud Logging ERROR
```

**致命エラー**（認証失効、SA 権限不足、連続失敗など）は `SLACK_ADMIN_USER_ID` 宛 DM で一次アラート。

### 可観測性

- 構造化ログ（`logger.info('event.extracted', { ... })`)
- ログ階層: DEBUG / INFO / WARN / ERROR
- Phase 1 ではダッシュボードは Cloud Logging の saved query で代用
- Phase 2 で Cloud Monitoring ダッシュボードを構築

### レート制限

| 上限 | 対応 |
|---|---|
| Slack 3 秒 ack | webhook ハンドラは 100ms 以内に 200 返却 |
| Slack 1 msg/sec | SDK の自動 throttling |
| Vertex AI QPM | Phase 1 流量では到達せず、429 は backoff |
| Firestore 1 doc 1 write/sec | ホットドキュメント回避設計 |

---

## 9. テスト戦略

### テストピラミッド

```text
E2E (手動)        2〜3 本     Slack → 実 Calendar 書き込み（主要シナリオ）
Integration      10〜15 本   webhook → orchestrator → Firestore emulator
Unit             30〜50 本   pipeline 配下のピュア関数中心
```

### Unit テスト (Vitest)

`pipeline/` `config/` `lib/` のピュア関数を網羅。Gemini 呼び出しはモック。

### Integration テスト

- Firestore Emulator (`gcloud beta emulators firestore start`)
- Gemini モック (成功 / 失敗 / 構造化エラー)
- Slack モック (投稿 fixture 入力、bot 送信キャプチャ)

主要シナリオ:
- text 投稿 → 高信頼で自動登録 → スレッド返信
- 画像添付 → vision で抽出
- 低信頼 → pending_confirmations 作成 + 確認質問
- reaction_added ✅ → pending 承認 → 登録
- Slack 再送 → 重複処理されない
- Gemini 429 → リトライ後成功
- Calendar 失敗 → スレッド報告 + pending 保留

### E2E（手動チェックリスト）

リリース前に：

```text
☐ 単純テキスト投稿（高信頼）→ Calendar 登録
☐ 学校だより画像 → 複数イベント抽出
☐ 曖昧投稿 → 確認質問 → ✅ で登録
☐ #長女 prefix → 長女のカレンダー
☐ ❌ → 登録済み削除
☐ Slack retry シミュレート → 重複登録なし
```

### テストデータ

`tests/fixtures/` に Slack イベント JSON、Gemini レスポンス JSON。実画像は git 管理外（`tests/fixtures/private/` を `.gitignore`）。

### CI

GitHub Actions: install → typecheck → lint → test (unit + integration with Firestore emulator)。PR ごと自動。E2E は `workflow_dispatch`。

---

## 10. デプロイメント

### リポジトリ構成

```
hanamaru/
├── src/                    # アプリケーションコード
├── tests/
├── scripts/
│   ├── auth-google.ts      # OAuth 初回認証
│   ├── seed-config.ts      # attribution_hints 初期投入
│   └── deploy.sh
├── infra/
│   ├── terraform/          # GCP リソース定義
│   └── slack-manifest.yaml # Slack App manifest
├── docs/
│   ├── architecture.md
│   ├── operations.md       # 運用 runbook
│   └── superpowers/specs/  # 本ドキュメント
├── .github/workflows/
├── Dockerfile
├── package.json
└── README.md
```

リポジトリ場所: `/Users/a11621/Documents/development/hanamaru/`

### Terraform 管理リソース

- Cloud Run service (`hanamaru`)
- Firestore database (Native mode, `asia-northeast1`)
- Service Account (`hanamaru-runtime@`) と IAM ロール
- Secret Manager secrets と SA への access
- Artifact Registry リポジトリ

### CI/CD

```text
GitHub push (main) ─▶ Actions
                      ├─ Test (unit + integration)
                      ├─ Build Docker image
                      ├─ Push to Artifact Registry
                      └─ Deploy to Cloud Run (traffic 0% で新リビジョン)
                                ↓
                         手動 promote: gcloud run services update-traffic --to-latest
```

ロールバック: 前リビジョンへの traffic 切替 1 コマンド。

### ローカル開発

```bash
pnpm install
gcloud auth application-default login
gcloud config set project hanamaru-dev

pnpm dev                # tsx watch
pnpm emulator:firestore # 別ターミナル
ngrok http 8080         # webhook URL を取得し Slack App に設定
```

`.env.local` で開発用シークレットを管理（git ignore）。

### 初回セットアップ runbook（`docs/operations.md` 詳細化）

1. GCP プロジェクト作成（`hanamaru-prod`）
2. Terraform 適用
3. Slack App 作成、`infra/slack-manifest.yaml` をインポート
4. Slack signing secret / bot token を Secret Manager 登録
5. Google OAuth クライアント作成、credentials を Secret Manager 登録
6. `pnpm run script:auth-google` で refresh token 取得 → Secret Manager
7. `pnpm run script:seed-config` で attribution_hints 投入
8. Cloud Run デプロイ → webhook URL 取得
9. Slack Event Subscription URL を設定
10. `#hanamaru` に bot invite
11. `ALLOWED_USER_IDS` 環境変数を設定

### 環境分離

- **dev**: `hanamaru-dev` プロジェクト + dev Slack workspace + テスト Calendar
- **prod**: `hanamaru-prod` プロジェクト + 本番 Slack + 既存家族 Calendar

`.env.{dev,prod}` と Terraform workspace で分離。

---

## 11. オープン課題 / 将来検討

- **複数ユーザー対応**: Phase 2 で配偶者招待時の振る舞い設計（信頼度の差異化、属性のデフォルト）
- **更新検出**: 「保護者会の時間が変わりました」を既存イベントの update として識別する難易度
- **コンフリクト検出**: Phase 3 で仕事 ICS フィードを含めた家族全体のスケジュール衝突検出
- **学習辞書の運用**: Phase 1 では Firestore に手動 + ✅ ベースで蓄積。スケールしたら埋め込み類似度検索に発展
- **iOS Shortcut 連携**: 写真を選んで Slack に送るショートカットを iOS 側で用意すれば、運用負荷がさらに下がる（Phase 1 の運用フェーズで検討）

---

## 付録 A: Phase 1 完了の定義 (Definition of Done)

- [ ] テキスト投稿で高信頼イベントが自動登録される
- [ ] 画像添付投稿で vision 抽出が動く
- [ ] prefix `#長女` `#長男` `#末っ子` `#自分` `#?` `#!!` が機能する
- [ ] 低信頼ケースで確認メッセージが出る、✅/❌ で動く
- [ ] 同じ Slack イベントの再送で重複登録されない
- [ ] Cloud Run / Firestore / Secret Manager が Terraform で再現可能
- [ ] GitHub Actions で CI が回る
- [ ] `docs/operations.md` を見て他人が初回セットアップを完走できる
- [ ] 主要 E2E シナリオ 3 本を手動で確認済み
