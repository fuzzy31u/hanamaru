import type { PrefixMode, PrefixParseResult } from '~/config/schema'
import type { ChildId } from '~/config/schema'

const CHILD_PREFIX_MAP: Record<string, Exclude<ChildId, 'unknown'>> = {
  長女: 'child1',
  長男: 'child2',
  末っ子: 'child3',
  自分: 'self',
}

/**
 * English prefix aliases (case-insensitive). Keys are lowercase tokens; the web
 * demo accepts these so English speakers can attribute events without the
 * Japanese tokens. The Japanese tokens above continue to work unchanged.
 */
const EN_CHILD_PREFIX_MAP: Record<string, Exclude<ChildId, 'unknown'>> = {
  daughter: 'child1',
  'eldest-daughter': 'child1',
  son: 'child2',
  'eldest-son': 'child2',
  youngest: 'child3',
  me: 'self',
  self: 'self',
}

const MODE_PREFIX_MAP: Record<string, PrefixMode> = {
  '?': 'force-ask',
  '!!': 'force-auto',
}

// Japanese child tokens + mode tokens. Longer English aliases are listed before
// their prefixes (e.g. eldest-daughter before daughter) so the regex prefers the
// longer match. English aliases are matched case-insensitively.
const PREFIX_TOKEN =
  /^#(長女|長男|末っ子|自分|eldest-daughter|eldest-son|daughter|son|youngest|me|self|\?|!!)(\s+|$)/i

export function parsePrefix(text: string): PrefixParseResult {
  let prefixHint: Exclude<ChildId, 'unknown'> | null = null
  let modeHint: PrefixMode | null = null
  let remaining = text

  while (true) {
    const match = remaining.match(PREFIX_TOKEN)
    if (!match) break

    const token = match[1]!
    const lower = token.toLowerCase()
    if (token in CHILD_PREFIX_MAP) {
      if (prefixHint === null) prefixHint = CHILD_PREFIX_MAP[token]!
    } else if (lower in EN_CHILD_PREFIX_MAP) {
      if (prefixHint === null) prefixHint = EN_CHILD_PREFIX_MAP[lower]!
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
