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
