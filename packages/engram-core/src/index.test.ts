import { expect, test } from 'vitest'

import { ENGRAM_VERSION } from './index.js'

test('@engram/core skeleton compiles and exposes a version', () => {
  expect(ENGRAM_VERSION).toBe('0.0.0')
})
