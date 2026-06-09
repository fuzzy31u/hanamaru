import type { SlackClient } from '~/adapters/slack'
import type { ChildrenMap } from '~/config/children'
import type { ExtractionInput } from '~/config/schema'
import type { Thresholds } from '~/config/thresholds'
import { logger } from '~/lib/logger'
import { attributeEvents } from '~/pipeline/attributor'
import type { CalendarWriter, WriteResult } from '~/pipeline/calendar-writer'
import { decideRoute } from '~/pipeline/confidence'
import type { Extractor } from '~/pipeline/extractor'
import {
  type LabelMap,
  buildAskText,
  buildAutoRegisterText,
  buildEmptyText,
  buildErrorText,
} from '~/pipeline/replier'
import type { AttributionHintsStore } from '~/stores/attribution-hints'
import type { IdempotencyStore } from '~/stores/idempotency'
import type { PendingStore } from '~/stores/pending'

export type OrchestratorDeps = {
  extractor: Extractor
  writer: CalendarWriter
  slack: SlackClient
  idempotency: IdempotencyStore
  pending: PendingStore
  hints: AttributionHintsStore
  children: ChildrenMap
  thresholds: Thresholds
}

export type ProcessResult =
  | { kind: 'duplicate' }
  | { kind: 'created'; results: WriteResult[] }
  | { kind: 'asked'; pendingId: string }
  | { kind: 'empty' }
  | { kind: 'failed'; reason: string }

function labelMap(children: ChildrenMap): LabelMap {
  return {
    child1: children.child1.label,
    child2: children.child2.label,
    child3: children.child3.label,
    self: children.self.label,
  }
}

export function createOrchestrator(deps: OrchestratorDeps) {
  return {
    async process(input: ExtractionInput, slackEventId: string): Promise<ProcessResult> {
      const existing = await deps.idempotency.get(slackEventId)
      if (existing && existing.resultSummary !== 'pending') {
        logger.info('orchestrator.duplicate', { slackEventId })
        return { kind: 'duplicate' }
      }

      const acquired = await deps.idempotency.tryAcquire(slackEventId)
      if (!acquired) {
        return { kind: 'duplicate' }
      }

      try {
        const { events: rawEvents } = await deps.extractor.extract(input)

        if (rawEvents.length === 0) {
          await deps.slack.postThreadMessage(input.channelId, input.threadTs, buildEmptyText())
          await deps.idempotency.complete(slackEventId, {
            resultSummary: 'rejected',
            createdEventIds: [],
          })
          return { kind: 'empty' }
        }

        const allHints = await deps.hints.listAll()
        const hintsLookup = (text: string) => {
          const normalized = text.normalize('NFKC')
          for (const h of allHints) {
            if (normalized.includes(h.key)) return h.childId
          }
          return null
        }

        const attributed = attributeEvents(rawEvents, {
          prefixHint: input.prefixHint,
          hintsLookup,
        })

        const autoEvents = attributed.filter(
          (e) =>
            decideRoute(e, { modeHint: input.modeHint, thresholds: deps.thresholds }) ===
            'auto-register',
        )
        const askEvents = attributed.filter(
          (e) =>
            decideRoute(e, { modeHint: input.modeHint, thresholds: deps.thresholds }) === 'ask',
        )

        const writeResults: WriteResult[] =
          autoEvents.length > 0 ? await deps.writer.writeAll(autoEvents, slackEventId) : []

        if (askEvents.length > 0) {
          const text = buildAskText(askEvents, labelMap(deps.children))
          const posted = await deps.slack.postThreadMessage(input.channelId, input.threadTs, text)
          const pendingId = await deps.pending.create({
            slackChannelId: input.channelId,
            slackThreadTs: input.threadTs,
            slackMessageTs: posted.ts,
            events: askEvents,
          })
          await deps.idempotency.complete(slackEventId, {
            resultSummary: writeResults.length > 0 ? 'created' : 'pending',
            createdEventIds: writeResults.map((r) => r.eventId),
          })

          if (writeResults.length > 0) {
            await deps.slack.postThreadMessage(
              input.channelId,
              input.threadTs,
              buildAutoRegisterText(autoEvents, writeResults, labelMap(deps.children)),
            )
          }
          return { kind: 'asked', pendingId }
        }

        await deps.slack.postThreadMessage(
          input.channelId,
          input.threadTs,
          buildAutoRegisterText(autoEvents, writeResults, labelMap(deps.children)),
        )
        await deps.idempotency.complete(slackEventId, {
          resultSummary: 'created',
          createdEventIds: writeResults.map((r) => r.eventId),
        })
        return { kind: 'created', results: writeResults }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        logger.error('orchestrator.failed', {
          slackEventId,
          reason,
          stack: err instanceof Error ? err.stack : undefined,
        })
        await deps.idempotency.markFailed(slackEventId, err)
        try {
          await deps.slack.postThreadMessage(
            input.channelId,
            input.threadTs,
            buildErrorText(reason),
          )
        } catch (slackErr) {
          logger.error('orchestrator.slackFallbackFailed', { slackErr: String(slackErr) })
        }
        return { kind: 'failed', reason }
      }
    },
  }
}
