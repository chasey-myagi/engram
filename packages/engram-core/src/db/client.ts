/**
 * Drizzle 客户端工厂。内核不锁死连接管理：调用方注入 pg Pool（来自 DATABASE_URL）。
 */
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'

import * as schema from './schema.js'

export type DB = NodePgDatabase<typeof schema>

export function createPool(databaseUrl: string | undefined = process.env.DATABASE_URL): pg.Pool {
  if (!databaseUrl) {
    throw new Error(
      'createPool: DATABASE_URL is required (e.g. postgresql://engram:engram@localhost:5433/engram)',
    )
  }
  return new pg.Pool({ connectionString: databaseUrl })
}

export function createDb(pool: pg.Pool): DB {
  return drizzle(pool, { schema })
}
