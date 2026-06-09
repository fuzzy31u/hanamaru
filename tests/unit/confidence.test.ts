import { describe, expect, it } from 'vitest'
import type { ExtractedEvent } from '~/config/schema'
import { decideRoute } from '~/pipeline/confidence'

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
    expect(
      decideRoute(
        { ...base, attributedTo: 'unknown', attributionConfidence: 0.1 },
        { modeHint: 'force-auto' },
      ),
    ).toBe('auto-register')
  })
})
