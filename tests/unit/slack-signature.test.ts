import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifySlackSignature } from '~/lib/slack-signature'

const secret = 'test-secret-12345'

function sign(timestamp: string, body: string): string {
  const baseString = `v0:${timestamp}:${body}`
  const sig = createHmac('sha256', secret).update(baseString).digest('hex')
  return `v0=${sig}`
}

describe('verifySlackSignature', () => {
  it('returns true for valid signature with recent timestamp', () => {
    const ts = String(Math.floor(Date.now() / 1000))
    const body = '{"foo":"bar"}'
    const sig = sign(ts, body)
    expect(verifySlackSignature(body, ts, sig, secret)).toBe(true)
  })

  it('returns false for invalid signature', () => {
    const ts = String(Math.floor(Date.now() / 1000))
    expect(verifySlackSignature('{}', ts, 'v0=garbage', secret)).toBe(false)
  })

  it('returns false for stale timestamp (>5 min)', () => {
    const ts = String(Math.floor(Date.now() / 1000) - 600)
    const sig = sign(ts, '{}')
    expect(verifySlackSignature('{}', ts, sig, secret)).toBe(false)
  })

  it('returns false for missing signature', () => {
    expect(verifySlackSignature('{}', '0', '', secret)).toBe(false)
  })
})
