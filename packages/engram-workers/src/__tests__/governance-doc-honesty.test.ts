/**
 * EGR-CR-006（issue #86）· 治理文档诚实性回归（NEGATIVE，不依赖 DB）。
 *
 * 背景：README 与 choreography 测试名曾把「judge ≠ athlete」的工种隔离描述成「各工种独立 DB 角色 +
 * 会话隔离」，暗示该边界由 **Postgres 物理 role / RLS** 强制。事实并非如此——当前角色边界由**应用层守卫**
 * （`isHumanRole` 等，见 EGR-CR-002）强制，DB 里只有**逻辑角色标记**（`by_role` / `created_by`）。物理 DB
 * role 隔离（CREATE ROLE / GRANT / RLS）**待实现**。
 *
 * 与 EGR-CR-002 同一诚实纪律：文档/命名只陈述代码真做到的事，不盖做不到的安全戳。本套件**只扫文本**
 * （README + choreography.test.ts 源），断言误导口径已清除、诚实口径已就位，纯静态、零 DB 依赖。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 从本测试目录上溯，定位仓库根（含 README.md + pnpm-workspace.yaml 的那一层）。 */
function repoRoot(): string {
  let dir = HERE
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml')) && existsSync(join(dir, 'README.md')))
      return dir
    dir = dirname(dir)
  }
  throw new Error('repo root (pnpm-workspace.yaml + README.md) not found above ' + HERE)
}

const ROOT = repoRoot()
const README = readFileSync(join(ROOT, 'README.md'), 'utf8')
const PRD = readFileSync(join(ROOT, 'docs', 'PRD.md'), 'utf8')
const CHOREO = readFileSync(join(HERE, 'choreography.test.ts'), 'utf8')

describe('EGR-CR-006 治理文档诚实性（judge≠athlete 不得盖 DB 物理隔离戳）', () => {
  it('README 不再把工种隔离描述成无限定的「独立 DB 角色 + 会话隔离」（误导=暗示 DB 物理强制）', () => {
    // 旧误导句：`各工种独立 DB 角色 + 会话隔离`。该措辞让读者以为工种边界由 Postgres role 物理强制。
    expect(README).not.toMatch(/各工种独立 DB 角色\s*\+\s*会话隔离/)
    // 更宽的护栏：README 不得出现「DB 角色」与「隔离」并置而无「待实现 / 应用层」限定的悬空安全戳。
    // 若仍提及 DB 角色，必须同段明示其为待实现 / 由应用层守卫，而非既成的物理隔离。
  })

  it('README 明示物理 DB role 隔离「待实现」，且当前角色边界由应用层守卫强制（与 EGR-CR-002 对齐）', () => {
    expect(README).toMatch(/待实现/)
    expect(README).toMatch(/逻辑角色|by_role/)
    expect(README).toMatch(/应用层/)
    // 锚定到同一句语境：提及物理隔离的那段必须带「待实现」限定，不留无条件断言。
    const judgeLine = README.split('\n').find((l) => l.includes('judge') && l.includes('athlete'))
    expect(judgeLine, 'README 应保留 judge≠athlete 那行').toBeTruthy()
    expect(judgeLine!).toMatch(/待实现/)
    expect(judgeLine!).toMatch(/逻辑角色|by_role/)
  })

  it('PRD.md 的「工程判据」架构陈述不再把工种隔离写成既成的「独立 DB 角色 + 会话隔离」', () => {
    // PRD.md 的 user story（「作为...我想要独立 DB 角色」）是**需求愿景**，刻意保留——物理隔离记为 backlog。
    // 但 A.7「loop vs one-shot 工程判据」那段是**架构既成陈述**，与 README 同款，不得盖物理隔离戳。
    const judgeriaLine = PRD.split('\n').find(
      (l) => l.includes('工程判据') && l.includes('judge') && l.includes('athlete'),
    )
    expect(judgeriaLine, 'PRD 应保留工程判据那行').toBeTruthy()
    expect(judgeriaLine!).not.toMatch(/各工种独立 DB 角色\s*\+\s*会话隔离/)
    expect(judgeriaLine!).toMatch(/待实现/)
  })

  it('PRD.md 的「技术栈」架构陈述（agent 运行时）不再把工种隔离写成既成的「独立 session + DB 角色隔离」', () => {
    // 技术栈段那行是**架构既成陈述**（紧跟 harness-pi 运行时描述），与 README/工程判据同款，不得盖物理隔离戳。
    // 区别于 line 72 的 user story（「作为...我想要独立 DB 角色」=需求愿景，刻意保留）。
    const techLine = PRD.split('\n').find(
      (l) => l.includes('@harness-pi/core') && l.includes('独立 session'),
    )
    expect(techLine, 'PRD 应保留技术栈 agent 运行时那行').toBeTruthy()
    expect(techLine!).not.toMatch(/DB 角色隔离/)
    expect(techLine!).toMatch(/待实现/)
  })

  it('choreography.test.ts 不再用暗示「物理 DB 角色」的命名/注释（own DB role / 各自 DB 角色）', () => {
    expect(CHOREO).not.toMatch(/own DB role/)
    expect(CHOREO).not.toMatch(/各自 DB 角色/)
    // 诚实替代：命名反映「逻辑角色 / by_role 标记」。
    expect(CHOREO).toMatch(/own logical role|逻辑角色|by_role tag/)
  })
})
