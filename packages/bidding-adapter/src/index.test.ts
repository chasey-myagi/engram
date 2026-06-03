import { expect, test } from 'vitest'

import { ADAPTER_TARGETS_ENGRAM } from './index.js'

test('bidding-adapter wires up against @engram/core (adapter → core)', () => {
  expect(ADAPTER_TARGETS_ENGRAM).toBe('0.0.0')
})
