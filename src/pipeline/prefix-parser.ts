import type { PrefixMode, PrefixParseResult } from '~/config/schema'
import type { ChildId } from '~/config/schema'

const CHILD_PREFIX_MAP: Record<string, Exclude<ChildId, 'unknown'>> = {
  '長女': 'child1',
  '長男': 'child2',
  '末っ子': 'child3',
  '自分': 'self',
}

const MODE_PREFIX_MAP: Record<string, PrefixMode> = {
  '?': 'force-ask',
  '!!': 'force-auto',
}

const PREFIX_TOKEN = /^#(長女|長男|末っ子|自分|\?|!!)(\s+|$)/

export function parsePrefix(text: string): PrefixParseResult {
  let prefixHint: Exclude<ChildId, 'unknown'> | null = null
  let modeHint: PrefixMode | null = null
  let remaining = text

  while (true) {
    const match = remaining.match(PREFIX_TOKEN)
    if (!match) break

    const token = match[1]!
    if (token in CHILD_PREFIX_MAP) {
      if (prefixHint === null) prefixHint = CHILD_PREFIX_MAP[token]!
    } else if (token in MODE_PREFIX_MAP) {
      if (modeHint === null) modeHint = MODE_PREFIX_MAP[token]!
    }
    remaining = remaining.slice(match[0].length)
  }

  return {
    prefixHint,
    modeHint,
    remainingText: remaining.trim() === '' ? remaining.trim() : remaining,
  }
}
