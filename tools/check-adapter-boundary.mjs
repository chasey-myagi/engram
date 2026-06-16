/**
 * EGR-CR-043 · 领域 adapter 边界护栏（T1）。
 *
 * 不变量：`packages/*-adapter/src/**` 的**生产代码**（排除 `*.test.ts`）经 Consumer SPI 消费内核，
 * 绝不反向依赖内核内部——故禁止：
 *   1. 从 `@engram/core` 命名导入 `schema`（拿到 core 的 Drizzle 表定义 = 穿透内部存储）；
 *   2. 从 `@engram/core` 命名导入 `DB`（拿到 core 的连接句柄类型 = 公开主路径吃 raw db）；
 *   3. import `drizzle-orm`（领域包没有任何直接查库的正当理由）。
 *
 * source metadata 等业务身份只能由 recall result（受控 `sourceMeta` 缝）或受控 Consumer SPI 提供。
 *
 * 用法：
 *   node tools/check-adapter-boundary.mjs            # 扫全仓，违规则非零退出（CI 门）
 *   import { findAdapterBoundaryViolations } from …   # 取违规列表（供测试断言）
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const FORBIDDEN_DRIZZLE = /^['"]drizzle-orm/
// 从 @engram/core 命名导入里出现 `schema` 或 `DB` 作为导入名（含 `type DB` / 别名 `schema as x`）。
const FORBIDDEN_CORE_NAMES = ['schema', 'DB']

/** 递归收集目录下所有 .ts 文件（排除 .test.ts、node_modules、dist）。 */
function collectTsFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...collectTsFiles(full))
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full)
    }
  }
  return out
}

/** 从一段 import 子句源里拆出命名导入的本地/原名集合（粗粒度，够判 schema/DB 是否被引入）。 */
function namedImportTokens(clause) {
  const brace = clause.match(/\{([^}]*)\}/)
  if (!brace) return []
  return brace[1]
    .split(',')
    .map((s) => s.trim().replace(/^type\s+/, ''))
    .map((s) => s.split(/\s+as\s+/)[0].trim()) // `schema as s` → schema（原名才是穿透判据）
    .filter(Boolean)
}

/**
 * 扫一个 adapter 生产文件，返回违规描述数组（空 = 干净）。
 * 只看顶层 import 语句（含跨行 `from`），不解释运行时。
 */
export function scanAdapterFile(filePath, source) {
  const violations = []
  // 匹配 import … from '…' / import '…'（允许跨行的命名列表）。
  const importRe = /import\s+(?:type\s+)?(?:[^;]*?from\s+)?(['"][^'"]+['"])/gs
  let m
  while ((m = importRe.exec(source)) !== null) {
    const stmt = m[0]
    const spec = m[1]
    if (FORBIDDEN_DRIZZLE.test(spec)) {
      violations.push({ file: filePath, kind: 'drizzle-orm', detail: spec })
      continue
    }
    if (/['"]@engram\/core['"]/.test(spec)) {
      const tokens = namedImportTokens(stmt)
      for (const name of FORBIDDEN_CORE_NAMES) {
        if (tokens.includes(name)) {
          violations.push({ file: filePath, kind: `@engram/core:${name}`, detail: stmt.trim() })
        }
      }
    }
  }
  return violations
}

/** 扫 repo 下所有 `packages/*-adapter/src` 生产文件，返回违规数组。 */
export function findAdapterBoundaryViolations(repoRoot) {
  const packagesDir = join(repoRoot, 'packages')
  let pkgs
  try {
    pkgs = readdirSync(packagesDir)
  } catch {
    return []
  }
  const violations = []
  for (const pkg of pkgs) {
    if (!pkg.endsWith('-adapter')) continue
    const srcDir = join(packagesDir, pkg, 'src')
    let files
    try {
      files = collectTsFiles(srcDir)
    } catch {
      continue
    }
    for (const file of files) {
      violations.push(...scanAdapterFile(relative(repoRoot, file), readFileSync(file, 'utf8')))
    }
  }
  return violations
}

// CLI 入口：直接运行时扫全仓并以退出码报告。
const thisFile = fileURLToPath(import.meta.url)
if (process.argv[1] === thisFile) {
  const repoRoot = join(dirname(thisFile), '..')
  const violations = findAdapterBoundaryViolations(repoRoot)
  if (violations.length > 0) {
    console.error(
      'adapter boundary violation (EGR-CR-043): 领域 adapter 生产代码不得穿透 core 内部。',
    )
    for (const v of violations) {
      console.error(`  - ${v.file}: forbidden import [${v.kind}] → ${v.detail}`)
    }
    console.error(
      '修法：business identity 改由 recall result 的 sourceMeta 缝（或受控 Consumer SPI）提供。',
    )
    process.exit(1)
  }
  console.log('adapter boundary OK: 无 *-adapter 生产代码穿透 core schema/DB 或 drizzle-orm。')
}
