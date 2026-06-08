import type { ExtractedEvent, PrefixMode } from '~/config/schema'
import { DEFAULT_THRESHOLDS, type Thresholds } from '~/config/thresholds'

export type Route = 'auto-register' | 'ask'

export type ConfidenceOptions = {
  modeHint: PrefixMode | null
  thresholds?: Thresholds
}

export function decideRoute(event: ExtractedEvent, opts: ConfidenceOptions): Route {
  if (opts.modeHint === 'force-auto') return 'auto-register'
  if (opts.modeHint === 'force-ask') return 'ask'

  const t = opts.thresholds ?? DEFAULT_THRESHOLDS
  const isHigh =
    event.attributionConfidence >= t.attribution &&
    event.datetimeConfidence >= t.datetime &&
    event.attributedTo !== 'unknown'

  return isHigh ? 'auto-register' : 'ask'
}
