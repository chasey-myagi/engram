import { defineConfig } from 'vitest/config'

const DEFAULT_DB = 'postgresql://engram:engram@localhost:5433/engram'

// 每个 DB 测试文件在 beforeAll 里 CREATE 自己的一次性库（见各 *.test.ts），并发文件互不踩。
// **连接预算**（防 cold/contended run 闪退）：每个 DB 测试文件各开 1 个 test pool(max:4) + 1 个 admin
// pool(max:2)。Postgres max_connections=100。无界并发下「并发文件数 × pool.max」会在重载（CI 同时跑多个
// review agent / 多套件）时冲破 100 → 连接被拒 → 查询返回空/错值 → 测试**非确定**闪退（与逻辑无关）。
// 故双重设防：① 各 pool 已在文件内封顶(4/2)；② 这里把**并发文件数**封到 maxWorkers=4 ⇒ 单套件峰值 ≤
// 4×(4+2)=24 连接，**与 DB 测试文件总数无关**（加文件不放大峰值），即便 2–3 套件并发(48–72)仍 <100。
// 代价是套件略慢，但**门禁套件的确定性 > 速度**。新增 DB 测试文件时：沿用 max:4 / max:2 的 pool 封顶即可。
//
// **每测超时**（与连接预算互补、同样为确定性服务）：默认 5000ms 太紧。DB 重测在**隔离**下就要 1–4s
// （read-strategies ~4.4s、harvester ~4s、learning-loop ~3.8s、corroborated-ece ~3.4s）；redteam-immunity 的
// 「重打分确定性」测对 ~16 株跑**两遍** runRedTeamGeneration，在 maxWorkers=4 并发争用 + cold pool 下会越过 5s
// 而**伪**超时（与逻辑无关的闪退、门禁假红）。这是永久 CI 红线套件，伪超时不可接受 ⇒ 上限抬到 30s
// （留足余量；真卡死仍会在 30s 兜底报出）。注意：beforeAll 建库 hook 自带 60_000ms，不受此值影响。
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    env: { DATABASE_URL: process.env.DATABASE_URL ?? DEFAULT_DB },
    fileParallelism: true,
    maxWorkers: 4,
    minWorkers: 1,
    testTimeout: 30_000,
  },
})
