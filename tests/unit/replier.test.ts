import { describe, expect, it } from 'vitest'
import type { ExtractedEvent } from '~/config/schema'
import type { ConflictNote } from '~/pipeline/agent'
import type { WriteResult } from '~/pipeline/calendar-writer'
import {
  buildAskText,
  buildAutoRegisterText,
  buildConflictNote,
  buildEmptyText,
  buildErrorText,
} from '~/pipeline/replier'

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
      {
        ...sampleEvent,
        attributedTo: 'unknown',
        attributionConfidence: 0.2,
        datetimeConfidence: 0.3,
        title: 'ピアノ発表会',
      },
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

describe('buildConflictNote', () => {
  it('returns empty string when there are no conflicts', () => {
    expect(buildConflictNote([], labels)).toBe('')
  })

  it('formats one conflict with JST when and members', () => {
    const conflicts: ConflictNote[] = [
      {
        newEventTitle: 'サッカー',
        conflictsWith: 'ピアノ発表会',
        when: '2026-06-10T09:00:00+09:00',
        members: ['長男'],
      },
    ]
    const text = buildConflictNote(conflicts, labels)
    expect(text).toContain('⚠️ スケジュールの重複の可能性')
    expect(text).toContain('サッカー')
    expect(text).toContain('ピアノ発表会')
    expect(text).toContain('6/10')
    expect(text).toContain('長男')
  })

  it('formats multiple conflicts as multiple lines', () => {
    const conflicts: ConflictNote[] = [
      {
        newEventTitle: 'サッカー',
        conflictsWith: 'ピアノ',
        when: '2026-06-10T09:00:00+09:00',
        members: ['長男'],
      },
      {
        newEventTitle: '検診',
        conflictsWith: '保護者会',
        when: '2026-06-11T14:00:00+09:00',
        members: ['長女', '自分'],
      },
    ]
    const text = buildConflictNote(conflicts, labels)
    const lines = text.split('\n')
    expect(lines.length).toBeGreaterThanOrEqual(3)
    expect(text).toContain('検診')
    expect(text).toContain('保護者会')
  })
})
