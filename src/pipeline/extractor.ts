import type { GeminiClient } from '~/adapters/gemini'
import type { ExtractedEvent, ExtractionInput } from '~/config/schema'

export type Extractor = {
  extract(input: ExtractionInput): Promise<{ events: ExtractedEvent[]; summary: string }>
}

export function createExtractor(gemini: GeminiClient): Extractor {
  return {
    async extract(input) {
      return gemini.extract(input)
    },
  }
}
