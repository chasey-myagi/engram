/**
 * EGR-CR-043 · 领域 adapter 边界护栏（T1）的单测（pure，无 DB）。
 *
 * 验 `tools/check-adapter-boundary.mjs`：
 *   - red 判据：人为给 adapter 生产文件加回 `import { schema } from '@engram/core'` / `type DB` / `drizzle-orm`
 *     必须被 scanAdapterFile 判违规；
 *   - green 判据：真实的 `packages/*-adapter/src` 生产代码扫全仓零违规（即已落地的修法通过）。
 *
 * 这把护栏接进 CI（root `check:adapter-boundary` 脚本），阻止「recall 当半成品 + DB/schema 私查」模式扩散。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

// 根目录的纯 ESM 工具脚本（无依赖），vitest 直接 import。
import {
  findAdapterBoundaryViolations,
  scanAdapterFile,
  // @ts-expect-error — 根 tools 脚本无类型声明，运行时纯 JS。
} from '../../../../tools/check-adapter-boundary.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

interface Violation {
  file: string
  kind: string
  detail: string
}
const scan = scanAdapterFile as (file: string, source: string) => Violation[]
const scanAll = findAdapterBoundaryViolations as (repoRoot: string) => Violation[]

describe('EGR-CR-043 · adapter boundary lint', () => {
  it('flags a forbidden named import of `schema` from @engram/core (red guard)', () => {
    const src = `import { schema, applyAdapter } from '@engram/core'\nexport const x = schema\n`
    const v = scan('packages/bidding-adapter/src/index.ts', src)
    expect(v.some((x) => x.kind === '@engram/core:schema')).toBe(true)
  })

  it('flags a forbidden `type DB` import from @engram/core (red guard)', () => {
    const src = `import { applyAdapter, type DB } from '@engram/core'\nexport type X = DB\n`
    const v = scan('packages/bidding-adapter/src/index.ts', src)
    expect(v.some((x) => x.kind === '@engram/core:DB')).toBe(true)
  })

  it('flags an aliased `schema as s` import (alias does not launder the bypass)', () => {
    const src = `import { schema as s } from '@engram/core'\nexport const y = s\n`
    const v = scan('packages/bidding-adapter/src/index.ts', src)
    expect(v.some((x) => x.kind === '@engram/core:schema')).toBe(true)
  })

  it('flags any drizzle-orm import in adapter production code (red guard)', () => {
    const src = `import { inArray } from 'drizzle-orm'\nexport const z = inArray\n`
    const v = scan('packages/bidding-adapter/src/index.ts', src)
    expect(v.some((x) => x.kind === 'drizzle-orm')).toBe(true)
  })

  it('does NOT flag legitimate SPI-only imports', () => {
    const src = `import { applyAdapter, type RecallResult } from '@engram/core'\nexport const a = applyAdapter\n`
    expect(scan('packages/bidding-adapter/src/index.ts', src)).toEqual([])
  })

  it('the real repo is clean: no *-adapter production code violates the boundary (green guard)', () => {
    expect(scanAll(repoRoot)).toEqual([])
  })
})
