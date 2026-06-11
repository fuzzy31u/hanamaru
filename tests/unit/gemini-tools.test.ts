import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock @google/genai so no real Vertex AI call is made.
const generateContentMock = vi.fn()
const GoogleGenAICtor = vi.fn()

vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent: generateContentMock }
    constructor(...args: unknown[]) {
      GoogleGenAICtor(...args)
    }
  },
  // Re-export the enums used by gemini.ts so the module under test imports them.
  Type: {
    OBJECT: 'OBJECT',
    ARRAY: 'ARRAY',
    STRING: 'STRING',
    BOOLEAN: 'BOOLEAN',
    NUMBER: 'NUMBER',
  },
}))

import { createGeminiClient } from '~/adapters/gemini'
import type { ChildrenMap } from '~/config/children'

const entry = (label: string) => ({ label, calendarId: 'cal', aliases: [], contexts: [] })
const children: ChildrenMap = {
  child1: entry('A'),
  child2: entry('B'),
  child3: entry('C'),
  self: entry('Self'),
}

function makeClient() {
  return createGeminiClient({
    projectId: 'proj',
    location: 'us-central1',
    model: 'gemini-2.0',
    children,
  })
}

// Helpers to fake GenerateContentResponse: the SDK exposes `text` and
// `functionCalls` as getters; plain objects with those properties behave the same.
function textResponse(text: string) {
  return { text, functionCalls: undefined }
}
function functionCallResponse(calls: Array<{ name: string; args: Record<string, unknown> }>) {
  return { text: undefined, functionCalls: calls }
}

const TOOLS = [
  {
    name: 'find',
    description: 'find docs',
    parametersJsonSchema: {
      type: 'object',
      properties: { collection: { type: 'string' } },
      required: ['collection'],
    },
  },
]

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runWithTools', () => {
  it('runs a 2-turn flow: function call -> dispatch -> final text', async () => {
    generateContentMock
      .mockResolvedValueOnce(
        functionCallResponse([{ name: 'find', args: { collection: 'events' } }]),
      )
      .mockResolvedValueOnce(textResponse('done'))

    const dispatch = vi.fn().mockResolvedValue({ count: 3 })

    const client = makeClient()
    const result = await client.runWithTools({
      systemInstruction: 'sys',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      tools: TOOLS,
      dispatch,
    })

    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith('find', { collection: 'events' })
    expect(result.text).toBe('done')
    expect(result.toolCalls).toEqual([
      { name: 'find', args: { collection: 'events' }, result: { count: 3 } },
    ])
    expect(generateContentMock).toHaveBeenCalledTimes(2)

    // First call carries the tools config in the SDK's expected shape.
    const firstConfig = generateContentMock.mock.calls[0]?.[0]?.config
    expect(firstConfig.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'find',
            description: 'find docs',
            parametersJsonSchema: TOOLS[0]?.parametersJsonSchema,
          },
        ],
      },
    ])
    expect(firstConfig.systemInstruction).toBe('sys')

    // Second call's contents include the model functionCall turn + the functionResponse turn.
    const secondContents = generateContentMock.mock.calls[1]?.[0]?.contents
    const lastTurn = secondContents[secondContents.length - 1]
    expect(lastTurn.role).toBe('user')
    expect(lastTurn.parts[0].functionResponse.name).toBe('find')
    expect(lastTurn.parts[0].functionResponse.response).toEqual({ output: { count: 3 } })
  })

  it('returns text immediately when no function call; dispatch never called', async () => {
    generateContentMock.mockResolvedValueOnce(textResponse('hello'))
    const dispatch = vi.fn()

    const client = makeClient()
    const result = await client.runWithTools({
      systemInstruction: 'sys',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      tools: TOOLS,
      dispatch,
    })

    expect(dispatch).not.toHaveBeenCalled()
    expect(result.text).toBe('hello')
    expect(result.toolCalls).toEqual([])
    expect(generateContentMock).toHaveBeenCalledTimes(1)
  })

  it('stops at maxSteps when the model keeps returning function calls', async () => {
    generateContentMock.mockResolvedValue(
      functionCallResponse([{ name: 'find', args: { collection: 'events' } }]),
    )
    const dispatch = vi.fn().mockResolvedValue({ ok: true })

    const client = makeClient()
    const result = await client.runWithTools({
      systemInstruction: 'sys',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      tools: TOOLS,
      dispatch,
      maxSteps: 3,
    })

    expect(generateContentMock).toHaveBeenCalledTimes(3)
    expect(dispatch).toHaveBeenCalledTimes(3)
    expect(result.toolCalls).toHaveLength(3)
    expect(result.text).toBe('')
  })

  it('continues the loop when dispatch rejects, feeding the error back to the model', async () => {
    generateContentMock
      .mockResolvedValueOnce(
        functionCallResponse([{ name: 'find', args: { collection: 'events' } }]),
      )
      .mockResolvedValueOnce(textResponse('recovered'))

    const dispatch = vi.fn().mockRejectedValue(new Error('timeout'))

    const client = makeClient()
    const result = await client.runWithTools({
      systemInstruction: 'sys',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      tools: TOOLS,
      dispatch,
    })

    // Loop continued past the failed dispatch and produced the final text.
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(generateContentMock).toHaveBeenCalledTimes(2)
    expect(result.text).toBe('recovered')

    // The second turn's functionResponse carries an error (not output).
    const secondContents = generateContentMock.mock.calls[1]?.[0]?.contents
    const lastTurn = secondContents[secondContents.length - 1]
    expect(lastTurn.role).toBe('user')
    const fnResponse = lastTurn.parts[0].functionResponse
    expect(fnResponse.name).toBe('find')
    expect(fnResponse.response).toHaveProperty('error')
    expect(fnResponse.response.error).toBe('timeout')
    expect(fnResponse.response).not.toHaveProperty('output')
  })

  it('dispatches multiple function calls returned in a single turn', async () => {
    generateContentMock
      .mockResolvedValueOnce(
        functionCallResponse([
          { name: 'find', args: { collection: 'a' } },
          { name: 'find', args: { collection: 'b' } },
        ]),
      )
      .mockResolvedValueOnce(textResponse('both done'))

    const dispatch = vi.fn().mockResolvedValueOnce({ n: 1 }).mockResolvedValueOnce({ n: 2 })

    const client = makeClient()
    const result = await client.runWithTools({
      systemInstruction: 'sys',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      tools: TOOLS,
      dispatch,
    })

    expect(dispatch).toHaveBeenCalledTimes(2)
    expect(result.toolCalls).toHaveLength(2)
    expect(result.text).toBe('both done')
  })
})
