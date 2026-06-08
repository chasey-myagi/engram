import { defineConfig } from 'vitest/config'

const DEFAULT_DB = 'postgresql://engram:engram@localhost:5433/engram'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // 注入到 test worker（CI 的真实 DATABASE_URL 优先，本地回落到 compose 的 db）。
    // 每个 DB 测试文件在 beforeAll 里建自己的一次性数据库（见 append-claim.test.ts），并发的
    // 多个测试进程互不踩，无需全局 setup。
    env: { DATABASE_URL: process.env.DATABASE_URL ?? DEFAULT_DB },
    // 每测超时 30s（默认 5000ms 太紧）：isotonic / 校准等 DB 重测在并发下可越 5s 而**伪**超时（门禁假红）。
    // 只抬上限、不改通过行为;真卡死仍 30s 兜底报出。与 @engram/workers 同口径(那边另有 maxWorkers 连接预算)。
    testTimeout: 30_000,
  },
})
