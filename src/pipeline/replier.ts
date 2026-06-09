import type { ChildId, ExtractedEvent } from '~/config/schema'
import type { WriteResult } from '~/pipeline/calendar-writer'

export type LabelMap = Record<Exclude<ChildId, 'unknown'>, string>

const NUMBER_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟']

const WEEKDAY_MAP: Record<string, string> = {
  Sun: '日',
  Mon: '月',
  Tue: '火',
  Wed: '水',
  Thu: '木',
  Fri: '金',
  Sat: '土',
}

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
    for (let i = 0; i < events.length; i++) {
      const e = events[i]!
      const emoji = NUMBER_EMOJI[i] ?? `${i + 1}.`
      const link = results[i]?.htmlLink ? ` <${results[i]!.htmlLink}|↗>` : ''
      lines.push(
        `${emoji} 📅 ${e.title}（${labelFor(e.attributedTo, labels)}）${formatJstRange(e.startAt, e.endAt, e.allDay)}${link}`,
      )
    }
    lines.push('', '※ 個別修正は番号返信、まとめて取り消しは ❌')
  }
  return lines.join('\n')
}

export function buildAskText(events: ExtractedEvent[], labels: LabelMap): string {
  const lines = ['🤔 以下で登録してよいですか？', '']
  for (const e of events) {
    lines.push(`📅 **${e.title}**（${labelFor(e.attributedTo, labels)}）`)
    if (e.datetimeConfidence < 0.7) lines.push(`⚠️ 日時が曖昧です: 「${e.rawExcerpt}」`)
    if (e.attributedTo === 'unknown') lines.push('⚠️ 誰の予定か判別できませんでした')
    lines.push('')
  }
  lines.push(
    '応答:',
    '- ✅ そのまま登録',
    '- ❌ 破棄',
    '- 「#長男 7/15 14:00 から」のように詳細を返信',
  )
  return lines.join('\n')
}

export function buildEmptyText(): string {
  return '📭 予定情報を検出できませんでした'
}

export function buildErrorText(_reason: string): string {
  // err.message は内部実装の詳細やトークン断片を含む可能性があるため、ユーザー向けは固定メッセージ。
  // 詳細はサーバーログ (orchestrator.failed) に出力済み。
  return '⚠️ 抽出に失敗しました。少し時間をおいて再投稿してください。'
}
