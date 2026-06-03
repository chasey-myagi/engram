/**
 * vitest globalSetup：对测试库跑一次 Drizzle 迁移（幂等）。
 * 需要一个可连的 Postgres —— 本地 `docker compose up -d db`，CI 用 postgres service。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/node-postgres/migrator'

import { createDb, createPool } from '../db/client.js'

const DEFAULT_DB = 'postgresql://engram:engram@localhost:5433/engram'

export default async function setup(): Promise<void> {
  if (!process.env.DATABASE_URL) process.env.DATABASE_URL = DEFAULT_DB
  const pool = createPool()
  const db = createDb(pool)
  const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle')
  await migrate(db, { migrationsFolder })
  await pool.end()
}
