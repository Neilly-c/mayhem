import { afterEach, describe, expect, it } from 'vitest'
import * as sound from '../sound'

describe('sound', () => {
  afterEach(() => {
    sound.setMuted(false)
  })

  it('tracks the muted flag', () => {
    expect(sound.isMuted()).toBe(false)
    sound.setMuted(true)
    expect(sound.isMuted()).toBe(true)
    sound.setMuted(false)
    expect(sound.isMuted()).toBe(false)
  })

  it('every play function is a no-op (never throws) outside a browser environment', () => {
    // vitest runs with environment: 'node' (no `window`/AudioContext), which is exactly the
    // defensive path getContext() must handle gracefully -- these calls must not throw either way.
    expect(() => {
      sound.playHover()
      sound.playClick()
      sound.playSelect()
      sound.playHit()
      sound.playKill()
      sound.playRingWarn()
      sound.playRingShrink()
      sound.playGameOver()
    }).not.toThrow()
  })

  it('play functions are no-ops while muted (still must not throw)', () => {
    sound.setMuted(true)
    expect(() => {
      sound.playHit()
      sound.playGameOver()
    }).not.toThrow()
  })
})
