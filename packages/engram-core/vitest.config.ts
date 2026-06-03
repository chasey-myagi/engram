import { defineConfig } from 'vitest/config'

const DEFAULT_DB = 'postgresql://engram:engram@localhost:5433/engram'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    globalSetup: ['./src/__tests__/global-setup.ts'],
    // 注入到 test worker（CI 的真实 DATABASE_URL 优先，本地回落到 compose 的 db）
    env: { DATABASE_URL: process.env.DATABASE_URL ?? DEFAULT_DB },
    // DB 测试共用一个库 + 用 TRUNCATE 隔离；关掉文件级并行避免跨文件竞态
    fileParallelism: false,
  },
})
