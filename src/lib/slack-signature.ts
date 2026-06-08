import { createHmac, timingSafeEqual } from 'node:crypto'

const MAX_AGE_SECONDS = 300

export function verifySlackSignature(
  rawBody: string,
  timestamp: string | null,
  signature: string | null,
  signingSecret: string,
): boolean {
  if (!timestamp || !signature) return false

  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return false
  const age = Math.abs(Date.now() / 1000 - ts)
  if (age > MAX_AGE_SECONDS) return false

  const baseString = `v0:${timestamp}:${rawBody}`
  const expected = `v0=${createHmac('sha256', signingSecret).update(baseString).digest('hex')}`

  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
