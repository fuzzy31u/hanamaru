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

  it('parses #daughter prefix to child1 and strips the token', () => {
    const r = parsePrefix('#daughter recital next week')
    expect(r.prefixHint).toBe('child1')
    expect(r.modeHint).toBeNull()
    expect(r.remainingText).toBe('recital next week')
  })

  it('parses #eldest-daughter prefix to child1', () => {
    const r = parsePrefix('#eldest-daughter class observation')
    expect(r.prefixHint).toBe('child1')
    expect(r.remainingText).toBe('class observation')
  })

  it('parses #son prefix to child2 and strips the token', () => {
    const r = parsePrefix('#son soccer practice')
    expect(r.prefixHint).toBe('child2')
    expect(r.remainingText).toBe('soccer practice')
  })

  it('parses #eldest-son prefix to child2', () => {
    const r = parsePrefix('#eldest-son cram school meeting')
    expect(r.prefixHint).toBe('child2')
  })

  it('parses #youngest prefix to child3 and strips the token', () => {
    const r = parsePrefix('#youngest checkup')
    expect(r.prefixHint).toBe('child3')
    expect(r.remainingText).toBe('checkup')
  })

  it('parses #me prefix to self and strips the token', () => {
    const r = parsePrefix('#me business trip')
    expect(r.prefixHint).toBe('self')
    expect(r.remainingText).toBe('business trip')
  })

  it('parses #self prefix to self', () => {
    const r = parsePrefix('#self dentist')
    expect(r.prefixHint).toBe('self')
    expect(r.remainingText).toBe('dentist')
  })

  it('matches English aliases case-insensitively', () => {
    expect(parsePrefix('#Daughter recital').prefixHint).toBe('child1')
    expect(parsePrefix('#SON practice').prefixHint).toBe('child2')
    expect(parsePrefix('#Youngest checkup').prefixHint).toBe('child3')
    expect(parsePrefix('#ME trip').prefixHint).toBe('self')
  })

  it('combines English child prefix with mode prefix', () => {
    const r = parsePrefix('#daughter #? somewhere next week')
    expect(r.prefixHint).toBe('child1')
    expect(r.modeHint).toBe('force-ask')
    expect(r.remainingText).toBe('somewhere next week')
  })

  it('handles only-prefix English message (no body)', () => {
    const r = parsePrefix('#son')
    expect(r.prefixHint).toBe('child2')
    expect(r.remainingText).toBe('')
  })
})
