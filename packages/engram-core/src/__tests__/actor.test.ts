import { describe, expect, it } from 'vitest'

import { agentActor, trustedHumanActor, type ActorContext } from '../spi/actor.js'

describe('ActorContext (EGR-CR-002 受信授权边界)', () => {
  it('trustedHumanActor 构造 isHuman:true，role 原样保留', () => {
    const a: ActorContext = trustedHumanActor('human:editor')
    expect(a.isHuman).toBe(true)
    expect(a.role).toBe('human:editor')
  })

  it('agentActor 构造 isHuman:false，role 原样保留', () => {
    const a: ActorContext = agentActor('agent:verifier')
    expect(a.isHuman).toBe(false)
    expect(a.role).toBe('agent:verifier')
  })

  it('关键：agentActor 即便 role 传 human:fake 也 isHuman:false（授权只认布尔，不认伪装的 role 串）', () => {
    const a = agentActor('human:fake')
    expect(a.isHuman).toBe(false)
    expect(a.role).toBe('human:fake')
  })
})
