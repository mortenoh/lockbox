import { describe, expect, it } from 'vitest'

import { fromBase64, toBase64 } from '@/lib/encoding'

describe('base64url encoding', () => {
    it('round-trips arbitrary bytes', () => {
        const bytes = new Uint8Array(256)
        for (let i = 0; i < 256; i += 1) bytes[i] = i
        expect(fromBase64(toBase64(bytes))).toEqual(bytes)
    })

    it('round-trips the empty input', () => {
        expect(toBase64(new Uint8Array(0))).toBe('')
        expect(fromBase64('')).toEqual(new Uint8Array(0))
    })

    it('emits only the url-safe alphabet, unpadded', () => {
        // 0xff 0xff 0xff is '////' in standard base64 and must become '____'.
        expect(toBase64(new Uint8Array([255, 255, 255]))).toBe('____')
        // 0xfb 0xef 0xbe hits the '+' branch ('++++' in standard base64).
        expect(toBase64(new Uint8Array([251, 239, 190]))).toBe('----')
        // Lengths that would pad in standard base64 must not here.
        expect(toBase64(new Uint8Array([1]))).not.toContain('=')
        expect(toBase64(new Uint8Array([1, 2]))).not.toContain('=')
    })

    it('decodes known vectors', () => {
        expect(fromBase64('AQID')).toEqual(new Uint8Array([1, 2, 3]))
        expect(toBase64(new Uint8Array([1, 2, 3]))).toBe('AQID')
    })

    it('accepts an ArrayBuffer', () => {
        expect(toBase64(new Uint8Array([9, 8, 7]).buffer)).toBe('CQgH')
    })

    it('encodes only the range of a subarray view', () => {
        const backing = new Uint8Array([0, 0, 1, 2, 3, 0, 0])
        const view = backing.subarray(2, 5)
        expect(toBase64(view)).toBe('AQID')
    })
})
