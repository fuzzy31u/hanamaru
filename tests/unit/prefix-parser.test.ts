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
