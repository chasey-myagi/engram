import { defineConfig } from 'vitest/config'

const DEFAULT_DB = 'postgresql://engram:engram@localhost:5433/engram'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // 注入到 test worker（CI 的真实 DATABASE_URL 优先，本地回落到 compose 的 db）。
    // 每个 DB 测试文件在 beforeAll 里建自己的一次性数据库（见 append-claim.test.ts），并发的
    // 多个测试进程互不踩，无需全局 setup。
    env: { DATABASE_URL: process.env.DATABASE_URL ?? DEFAULT_DB },
  },
})
