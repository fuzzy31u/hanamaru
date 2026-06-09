import type { ChildId } from '~/config/schema'

export type ChildEntry = {
  label: string
  calendarId: string
  aliases: readonly string[]
  contexts: readonly string[]
}

export type ChildrenMap = {
  child1: ChildEntry
  child2: ChildEntry
  child3: ChildEntry
  self: ChildEntry
}

type Env = Record<string, string | undefined>

function requireEnv(env: Env, key: string): string {
  const value = env[key]
  if (!value) throw new Error(`Required env var missing: ${key}`)
  return value
}

function optionalEnv(env: Env, key: string): string | undefined {
  return env[key] || undefined
}

export function buildChildren(env: Env): ChildrenMap {
  const c1Name = optionalEnv(env, 'CHILD1_NAME')
  const c2Name = optionalEnv(env, 'CHILD2_NAME')
  const c3Name = optionalEnv(env, 'CHILD3_NAME')

  return {
    child1: {
      label: '長女',
      calendarId: requireEnv(env, 'CHILD1_CALENDAR_ID'),
      aliases: ['長女', '姉', ...(c1Name ? [c1Name] : [])],
      contexts: [optionalEnv(env, 'CHILD1_SCHOOL'), optionalEnv(env, 'CHILD1_JUKU')].filter(
        (s): s is string => Boolean(s),
      ),
    },
    child2: {
      label: '長男',
      calendarId: requireEnv(env, 'CHILD2_CALENDAR_ID'),
      aliases: ['長男', '兄', ...(c2Name ? [c2Name] : [])],
      contexts: [optionalEnv(env, 'CHILD2_SCHOOL'), optionalEnv(env, 'CHILD2_JUKU')].filter(
        (s): s is string => Boolean(s),
      ),
    },
    child3: {
      label: '末っ子',
      calendarId: requireEnv(env, 'CHILD3_CALENDAR_ID'),
      aliases: ['末っ子', '末', ...(c3Name ? [c3Name] : [])],
      contexts: [optionalEnv(env, 'CHILD3_DAYCARE')].filter((s): s is string => Boolean(s)),
    },
    self: {
      label: '自分',
      calendarId: requireEnv(env, 'SELF_CALENDAR_ID'),
      aliases: ['自分', '私', '俺'],
      contexts: [],
    },
  }
}

export function lookupChildByContext(
  text: string,
  children: ChildrenMap,
): Exclude<ChildId, 'unknown'> | null {
  const entries: Array<[Exclude<ChildId, 'unknown'>, ChildEntry]> = [
    ['child1', children.child1],
    ['child2', children.child2],
    ['child3', children.child3],
    ['self', children.self],
  ]
  for (const [id, entry] of entries) {
    for (const ctx of entry.contexts) {
      if (text.includes(ctx)) return id
    }
  }
  return null
}
