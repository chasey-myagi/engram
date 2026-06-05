import { defineConfig } from 'vitest/config'

const DEFAULT_DB = 'postgresql://engram:engram@localhost:5433/engram'

// 每个 DB 测试文件在 beforeAll 里 CREATE 自己的一次性库（见各 *.test.ts），并发文件互不踩。
// **连接预算**（防 cold/contended run 闪退）：每个 DB 测试文件各开 1 个 test pool(max:4) + 1 个 admin
// pool(max:2)。Postgres max_connections=100。无界并发下「并发文件数 × pool.max」会在重载（CI 同时跑多个
// review agent / 多套件）时冲破 100 → 连接被拒 → 查询返回空/错值 → 测试**非确定**闪退（与逻辑无关）。
// 故双重设防：① 各 pool 已在文件内封顶(4/2)；② 这里把**并发文件数**封到 maxWorkers=4 ⇒ 单套件峰值 ≤
// 4×(4+2)=24 连接，**与 DB 测试文件总数无关**（加文件不放大峰值），即便 2–3 套件并发(48–72)仍 <100。
// 代价是套件略慢，但**门禁套件的确定性 > 速度**。新增 DB 测试文件时：沿用 max:4 / max:2 的 pool 封顶即可。
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    env: { DATABASE_URL: process.env.DATABASE_URL ?? DEFAULT_DB },
    fileParallelism: true,
    maxWorkers: 4,
    minWorkers: 1,
  },
})
