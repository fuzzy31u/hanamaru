import { describe, expect, it } from 'vitest'
import type { ExtractedEvent } from '~/config/schema'
import { attributeEvents } from '~/pipeline/attributor'

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
    const events = [
      {
        ...baseEvent,
        attributedTo: 'child1' as const,
        attributionConfidence: 0.3,
        rawExcerpt: '保育園',
      },
    ]
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
