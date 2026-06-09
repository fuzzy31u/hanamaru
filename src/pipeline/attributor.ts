import type { ChildId, ExtractedEvent } from '~/config/schema'

export type AttributorOptions = {
  prefixHint: Exclude<ChildId, 'unknown'> | null
  hintsLookup: (rawExcerpt: string) => Exclude<ChildId, 'unknown'> | null
}

const HINT_CONFIDENCE = 0.85
const ATTRIBUTION_TRUST_FLOOR = 0.7

export function attributeEvents(
  events: ExtractedEvent[],
  opts: AttributorOptions,
): ExtractedEvent[] {
  return events.map((event) => {
    if (opts.prefixHint !== null) {
      return { ...event, attributedTo: opts.prefixHint, attributionConfidence: 1.0 }
    }

    const needsHint =
      event.attributedTo === 'unknown' || event.attributionConfidence < ATTRIBUTION_TRUST_FLOOR
    if (needsHint) {
      const hinted = opts.hintsLookup(event.rawExcerpt)
      if (hinted !== null) {
        return { ...event, attributedTo: hinted, attributionConfidence: HINT_CONFIDENCE }
      }
    }

    return event
  })
}
