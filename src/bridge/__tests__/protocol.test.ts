import { describe, expect, it } from 'vitest'
import { NdjsonDecoder, encodeMessage } from '../protocol'
import type { BridgeRequest } from '../protocol'

describe('encodeMessage', () => {
  it('serializes a message as one JSON line terminated by \\n', () => {
    const message: BridgeRequest = { id: 1, type: 'shutdown', payload: {} }
    const encoded = encodeMessage(message)
    expect(encoded.endsWith('\n')).toBe(true)
    expect(JSON.parse(encoded.trimEnd())).toEqual(message)
  })
})

describe('NdjsonDecoder', () => {
  it('parses a single complete line delivered in one chunk', () => {
    const decoder = new NdjsonDecoder()
    const messages = decoder.push('{"id":1,"type":"shutdown","payload":{}}\n')
    expect(messages).toEqual([{ id: 1, type: 'shutdown', payload: {} }])
  })

  it('parses multiple lines delivered in one chunk', () => {
    const decoder = new NdjsonDecoder()
    const messages = decoder.push('{"id":1}\n{"id":2}\n{"id":3}\n')
    expect(messages).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
  })

  it('buffers a partial line split across chunks and emits it once complete', () => {
    const decoder = new NdjsonDecoder()
    expect(decoder.push('{"id":1,"typ')).toEqual([])
    expect(decoder.push('e":"init"}\n')).toEqual([{ id: 1, type: 'init' }])
  })

  it('handles a chunk boundary that splits between two complete-looking messages', () => {
    const decoder = new NdjsonDecoder()
    expect(decoder.push('{"id":1}\n{"id"')).toEqual([{ id: 1 }])
    expect(decoder.push(':2}\n{"id":3}\n')).toEqual([{ id: 2 }, { id: 3 }])
  })

  it('returns nothing for an empty chunk and keeps any prior partial buffer intact', () => {
    const decoder = new NdjsonDecoder()
    expect(decoder.push('{"id":1')).toEqual([])
    expect(decoder.push('')).toEqual([])
    expect(decoder.push('}\n')).toEqual([{ id: 1 }])
  })

  it('round-trips an encoded request through the decoder', () => {
    const decoder = new NdjsonDecoder()
    const message: BridgeRequest = {
      id: 5,
      type: 'step',
      payload: { envs: [{ localEnvIndex: 0, actions: [{ unitId: 0, move: 1, attack: 0 }] }] },
    }
    expect(decoder.push(encodeMessage(message))).toEqual([message])
  })
})
