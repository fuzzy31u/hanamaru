import {
  type Content,
  type GenerateContentResponse,
  GoogleGenAI,
  type Part,
  type Schema,
  Type,
} from '@google/genai'
import type { ChildrenMap } from '~/config/children'
import { type ExtractedEvent, type ExtractionInput, ExtractionResponse } from '~/config/schema'
import { GeminiExtractionError, SchemaParseError, isRetryable } from '~/lib/errors'
import { logger } from '~/lib/logger'

const MAX_RETRIES = 3
const DEFAULT_MAX_STEPS = 8

/** A conversation turn passed to {@link GeminiClient.runWithTools}. Mirrors the SDK's Content. */
export type GeminiContent = Content

/** A tool the model may call. `parametersJsonSchema` is a JSON Schema object for the args. */
export type ToolDeclaration = {
  name: string
  description: string
  parametersJsonSchema: unknown
}

/** A single executed tool call captured during {@link GeminiClient.runWithTools}. */
export type ToolCallTrace = {
  name: string
  args: Record<string, unknown>
  result: unknown
}

export type RunWithToolsArgs = {
  systemInstruction: string
  contents: GeminiContent[]
  tools: ToolDeclaration[]
  dispatch: (name: string, args: Record<string, unknown>) => Promise<unknown>
  maxSteps?: number
}

export type RunWithToolsResult = {
  text: string
  toolCalls: ToolCallTrace[]
}

export type GeminiClient = {
  extract(input: ExtractionInput): Promise<{ events: ExtractedEvent[]; summary: string }>
  runWithTools(args: RunWithToolsArgs): Promise<RunWithToolsResult>
}

export type GeminiClientConfig = {
  projectId: string
  location: string
  model: string
  children: ChildrenMap
}

const responseSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    events: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          startAt: { type: Type.STRING },
          endAt: { type: Type.STRING, nullable: true },
          allDay: { type: Type.BOOLEAN },
          location: { type: Type.STRING, nullable: true },
          description: { type: Type.STRING, nullable: true },
          attributedTo: {
            type: Type.STRING,
            enum: ['child1', 'child2', 'child3', 'self', 'unknown'],
          },
          attributionConfidence: { type: Type.NUMBER },
          datetimeConfidence: { type: Type.NUMBER },
          rawExcerpt: { type: Type.STRING },
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
    summary: { type: Type.STRING },
  },
  required: ['events', 'summary'],
}

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

/**
 * Calls `generateContent` with the existing retry/backoff policy. Shared by
 * `extract()` and `runWithTools()` so both inherit identical resilience.
 */
async function generateWithRetry(
  ai: GoogleGenAI,
  request: Parameters<GoogleGenAI['models']['generateContent']>[0],
  label: string,
): Promise<GenerateContentResponse> {
  let lastErr: unknown = null
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await ai.models.generateContent(request)
    } catch (err) {
      lastErr = err
      if (!isRetryable(err) || attempt === MAX_RETRIES - 1) break
      const wait = 4 ** attempt * 1000
      logger.warn(`${label}.retry`, { attempt, waitMs: wait })
      await new Promise((r) => setTimeout(r, wait))
    }
  }
  throw lastErr instanceof Error ? lastErr : new GeminiExtractionError('Unknown generation failure')
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

      const response = await generateWithRetry(
        ai,
        {
          model: config.model,
          contents: [{ role: 'user', parts: parts as Part[] }],
          config: {
            systemInstruction,
            responseMimeType: 'application/json',
            responseSchema,
            temperature: 0.2,
          },
        },
        'gemini',
      )

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
        logger.error('gemini.zodParseFailed', {
          issues: parsed.error.issues,
          rawText: text.slice(0, 2000),
        })
        throw new SchemaParseError(`Zod parse failed: ${parsed.error.message}`, parsed.error)
      }

      logger.info('gemini.extracted', { eventCount: parsed.data.events.length })
      return parsed.data
    },

    async runWithTools(args: RunWithToolsArgs): Promise<RunWithToolsResult> {
      const maxSteps = args.maxSteps ?? DEFAULT_MAX_STEPS
      const toolConfig = [
        {
          functionDeclarations: args.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parametersJsonSchema: t.parametersJsonSchema,
          })),
        },
      ]

      const history: Content[] = [...args.contents]
      const toolCalls: ToolCallTrace[] = []

      for (let step = 0; step < maxSteps; step++) {
        const response = await generateWithRetry(
          ai,
          {
            model: config.model,
            contents: history,
            config: {
              systemInstruction: args.systemInstruction,
              tools: toolConfig,
              temperature: 0.2,
            },
          },
          'gemini.tools',
        )

        const calls = response.functionCalls ?? []
        if (calls.length === 0) {
          return { text: response.text ?? '', toolCalls }
        }

        // Echo the model's function-call turn back into the conversation.
        history.push({
          role: 'model',
          parts: calls.map((c) => ({ functionCall: c })),
        })

        // Execute every requested tool and append a functionResponse part per call.
        const responseParts: Part[] = []
        for (const call of calls) {
          const name = call.name ?? ''
          const callArgs = call.args ?? {}
          const result = await args.dispatch(name, callArgs)
          toolCalls.push({ name, args: callArgs, result })
          responseParts.push({
            functionResponse: { name, response: { output: result } },
          })
        }
        history.push({ role: 'user', parts: responseParts })

        logger.info('gemini.tools.step', { step, calls: calls.length })
      }

      // maxSteps exhausted while the model still wanted to call tools.
      logger.warn('gemini.tools.maxStepsReached', { maxSteps, toolCalls: toolCalls.length })
      return { text: '', toolCalls }
    },
  }
}
