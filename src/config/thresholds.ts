export type Thresholds = {
  attribution: number
  datetime: number
}

export function loadThresholdsFromEnv(env: Record<string, string | undefined>): Thresholds {
  return {
    attribution: Number.parseFloat(env.CONFIDENCE_THRESHOLD_ATTRIBUTION ?? '0.8'),
    datetime: Number.parseFloat(env.CONFIDENCE_THRESHOLD_DATETIME ?? '0.8'),
  }
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  attribution: 0.8,
  datetime: 0.8,
}
