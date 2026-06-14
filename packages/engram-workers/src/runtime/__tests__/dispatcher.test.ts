/**
 * EGR-CR-038 回归：`EventDispatcher.runToConvergence` 的 `maxEvents` 必须是**硬上限**。
 *
 * 纯内存单元测试（无 DB、无真模型）：`EventDispatcher` 的路由/计数是确定性逻辑，用最小注册的假 worker
 * 直接驱动即可——无需 wireDispatcher 的五工种全装，也不依赖任何 DB fixture。
 *
 * 暴露 bug 的形状：让**同一个事件类型命中多个 worker**——这正是现有五工种 wire（一一映射）里不存在、
 * 因而触发不到越界路径的形状。修前：单次出队会把 `dispatched` 整批自增越过 `maxEvents` 而不停手，
 * 且若这些 worker 不回吐后继事件、队列随即清空，`truncated` 还保持 false（有界性报告失真）。
 */
import { describe, expect, it } from 'vitest'

import { EventDispatcher, type EngramEvent } from '../dispatcher.js'

const SEED: EngramEvent = { type: 'source.ingested', payload: { sourceId: 's1' } }

/**
 * 构造一个最小 dispatcher：`names` 里每个 worker 都声明同一触发 `source.ingested`，
 * 处理器**不回吐后继事件**（返回 `[]`，终止级联）——制造「队列随即清空」的失真窗口。
 * `onFire(name)` 在每个 worker 实际被派发时回调，用于断言「谁被调用、按什么序」。
 */
function makeMultiHit(names: string[], onFire: (name: string) => void): EventDispatcher {
  const d = new EventDispatcher()
  for (const name of names) {
    d.register({
      name,
      triggers: ['source.ingested'],
      handle: async () => {
        onFire(name)
        return []
      },
    })
  }
  return d
}

describe('EGR-CR-038: maxEvents is a hard per-dispatch cap', () => {
  it('用例1: maxEvents=1 + 同事件命中两 worker → dispatched 恰为 1、truncated=true、只第一个 worker 被调用', async () => {
    const fired: string[] = []
    const d = makeMultiHit(['a', 'b'], (n) => fired.push(n))

    const result = await d.runToConvergence(SEED, { maxEvents: 1 })

    // 未修前: dispatched=2（第160行越界自增）、truncated=false（守卫只在出队前查一次、队列随后清空）。
    expect(result.dispatched).toBe(1)
    expect(result.truncated).toBe(true)
    // 只有注册序第一个 worker 被派发；第二个被硬上限拦下。
    expect(fired).toEqual(['a'])
    expect(result.firedByWorker).toEqual({ a: 1 })
  })

  it('用例2: maxEvents=2 + 同事件命中三 worker → dispatched 恰为 2、truncated=true、截断在注册序前缀边界', async () => {
    const fired: string[] = []
    const d = makeMultiHit(['a', 'b', 'c'], (n) => fired.push(n))

    const result = await d.runToConvergence(SEED, { maxEvents: 2 })

    expect(result.dispatched).toBe(2)
    expect(result.truncated).toBe(true)
    // 不变量：dispatched 永不越界。
    expect(result.dispatched).toBeLessThanOrEqual(2)
    // 确定性截断在注册序边界（前缀 ['a','b']），不是随机丢一个。
    expect(fired).toEqual(['a', 'b'])
    expect(result.firedByWorker).toEqual({ a: 1, b: 1 })
  })

  it('用例3a: maxEvents 恰等于命中数(3) → dispatched=3、truncated=false、三 worker 全调用（用满上限不误报截断）', async () => {
    const fired: string[] = []
    const d = makeMultiHit(['a', 'b', 'c'], (n) => fired.push(n))

    const result = await d.runToConvergence(SEED, { maxEvents: 3 })

    expect(result.dispatched).toBe(3)
    // dispatched === maxEvents 且队列已空 → 不应置 truncated。
    expect(result.truncated).toBe(false)
    expect(fired).toEqual(['a', 'b', 'c'])
    expect(result.firedByWorker).toEqual({ a: 1, b: 1, c: 1 })
  })

  it('用例3b: 默认 maxEvents(1000) → dispatched=3、truncated=false、三 worker 全调用（正常收敛路径不被破坏）', async () => {
    const fired: string[] = []
    const d = makeMultiHit(['a', 'b', 'c'], (n) => fired.push(n))

    const result = await d.runToConvergence(SEED)

    expect(result.dispatched).toBe(3)
    expect(result.truncated).toBe(false)
    expect(fired).toEqual(['a', 'b', 'c'])
    expect(result.firedByWorker).toEqual({ a: 1, b: 1, c: 1 })
  })
})
