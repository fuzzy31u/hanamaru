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
