import { expect, test } from 'vitest'

import * as core from './index.js'
import { ENGRAM_VERSION, addSource, appendClaim, supersedeClaim } from './index.js'

test('@engram/core public surface: version + Consumer SPI write path exported', () => {
  expect(ENGRAM_VERSION).toBe('0.0.0')
  // the SPI is the only outward seam — assert the write path is exported from the package entry
  expect(typeof addSource).toBe('function')
  expect(typeof appendClaim).toBe('function')
  expect(typeof supersedeClaim).toBe('function')
})

test('@engram/core public surface excludes test-only recall snapshot seeder', () => {
  expect(core).not.toHaveProperty('seedRecallSnapshot')
})
