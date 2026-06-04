import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { CALIBRATION_IDENTITY, DEFAULT_WEIGHTS } from '../confidence/confidence.js'
import { createDb, type DB } from '../db/client.js'
import { EMBEDDING_DIM } from '../embedding/embedder.js'
import { makeFakeEmbedder } from '../embedding/fake-embedder.js'
import { getReembedMarkers, markStaleForReembed, reembedMarked } from '../embedding/reembed.js'
import { addSource, appendClaim } from '../spi/append-claim.js'
import { claim, claimProvenance } from '../db/schema.js'
import { recallClaims } from '../spi/recall-claims.js'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://engram:engram@localhost:5433/engram'
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle')

let admin: pg.Pool
let pool: pg.Pool
let db: DB
let testDbName: string
const embedder = makeFakeEmbedder()

beforeAll(async () => {
  testDbName = `engram_test_${randomUUID().replace(/-/g, '')}`
  admin = new pg.Pool({ connectionString: DATABASE_URL })
  await admin.query(`CREATE DATABASE ${testDbName}`)
  const url = new URL(DATABASE_URL)
  url.pathname = `/${testDbName}`
  pool = new pg.Pool({ connectionString: url.toString() })
  db = createDb(pool)
  await migrate(db, { migrationsFolder })
})

afterAll(async () => {
  await pool.end()
  await admin.query(`DROP DATABASE IF EXISTS ${testDbName} WITH (FORCE)`)
  await admin.end()
})

beforeEach(async () => {
  await pool.query('TRUNCATE source, claim, claim_provenance, claim_verification CASCADE')
})

async function aSource() {
  return addSource(db, {
    content: 'body',
    contentHash: randomUUID(),
    kind: 'structured_spec',
    authorityScore: 0.5,
  })
}

/** Seed a recallable active claim with a given embedding vector (factors recompute ≥ floor). */
async function seedActiveWithVector(text: string, vector: number[]): Promise<string> {
  const id = randomUUID()
  await db.insert(claim).values({
    id,
    claimText: text,
    status: 'active',
    confidence: 0.8,
    confidenceRaw: 0.8,
    confidenceFactors: {
      factors: {
        authority: 0.8,
        humanReview: 0.8,
        entailment: 0.8,
        indepSupport: 0.8,
        usageCorrect: 0.8,
        ageDays: 0,
        activeContradicts: 0,
        staleDecay: 1,
        conflictDecay: 1,
      },
      weights: DEFAULT_WEIGHTS,
      calibrationVersion: CALIBRATION_IDENTITY,
    },
    lineageId: randomUUID(),
    asOf: new Date(),
    createdBy: 'test',
    embedding: vector,
    embeddingVersion: 'fake:trigram-v1',
  })
  const { sourceId } = await aSource()
  await db
    .insert(claimProvenance)
    .values({ id: randomUUID(), claimId: id, sourceId, locator: 'p1', relevance: 'exact' })
  return id
}

describe('S9 embedding substrate (A.6)', () => {
  it('appendClaim stores a claim_text embedding + embedding_version on the committed claim', async () => {
    const { sourceId } = await aSource()
    const { claimId } = await appendClaim(db, embedder, { claimText: 'engram fast device' }, [
      { sourceId, locator: 'l' },
    ])
    const [row] = await db
      .select({ embedding: claim.embedding, embeddingVersion: claim.embeddingVersion })
      .from(claim)
      .where(eq(claim.id, claimId))
    expect(row!.embedding).toHaveLength(EMBEDDING_DIM)
    expect(row!.embeddingVersion).toBe(embedder.version)
  })

  it('the embedding is computed from claim_text: two claims with identical text but different provenance excerpts get identical vectors', async () => {
    const s1 = await aSource()
    const s2 = await aSource()
    const text = 'sku-7 supports 4k at 120hz'
    const { claimId: a } = await appendClaim(db, embedder, { claimText: text }, [
      { sourceId: s1.sourceId, locator: 'l', excerpt: 'excerpt ALPHA differs' },
    ])
    const { claimId: b } = await appendClaim(db, embedder, { claimText: text }, [
      { sourceId: s2.sourceId, locator: 'l', excerpt: 'excerpt BETA totally different' },
    ])
    const rows = await db.select({ id: claim.id, embedding: claim.embedding }).from(claim)
    const va = rows.find((r) => r.id === a)!.embedding!
    const vb = rows.find((r) => r.id === b)!.embedding!
    expect(va).toEqual(vb) // same claim_text ⇒ same vector, regardless of provenance excerpt
  })

  it('recall hits a semantically-near but differently-worded claim (semantic NN, not literal match)', async () => {
    // custom embedder: "the device runs fast" and the synonymous query "quick speedy hardware" map NEAR;
    // an unrelated claim maps FAR. The query shares NO words with the claim ⇒ a literal match would miss it.
    const fast = unit(0)
    const near = mix(0, 1, 0.95)
    const far = unit(7)
    const vectorOf = (t: string): number[] =>
      t === 'the device runs fast' ? fast : t === 'quick speedy hardware' ? near : far
    const semantic = makeFakeEmbedder({ version: 'fake:semantic', vectorOf })

    const target = await seedActiveWithVector('the device runs fast', fast)
    await seedActiveWithVector('an unrelated banana', far)

    const hits = await recallClaims(db, semantic, 'quick speedy hardware')
    expect(hits.map((r) => r.claim.id)).toEqual([target]) // only the semantically-near claim
    expect(hits[0]!.claim.claimText).toBe('the device runs fast') // shares no words with the query
  })

  it('recall rides the embedding_version on each result', async () => {
    await seedActiveWithVector('version anchor claim', await embedder.embed('version anchor claim'))
    const [r] = await recallClaims(db, embedder, 'version anchor claim')
    expect(r!.embeddingVersion).toBe('fake:trigram-v1')
  })

  it('a model-version bump marks stale claims for reembed; reembed updates them and skips already-current ones', async () => {
    const v1 = makeFakeEmbedder({ version: 'fake:v1' })
    const v2 = makeFakeEmbedder({ version: 'fake:v2' })
    const s = await aSource()
    await appendClaim(db, v1, { claimText: 'reembed me one' }, [
      { sourceId: s.sourceId, locator: 'l' },
    ])
    await appendClaim(db, v1, { claimText: 'reembed me two' }, [
      { sourceId: s.sourceId, locator: 'l' },
    ])

    // version bump to v2 → both v1 claims are stale → marked
    const marked = await markStaleForReembed(db, v2.version)
    expect(marked).toBe(2)
    expect(await getReembedMarkers(db)).toHaveLength(2) // enumerable
    // marking again is idempotent (no duplicate markers)
    expect(await markStaleForReembed(db, v2.version)).toBe(0)

    // reembed the marked claims → both move to v2
    expect(await reembedMarked(db, v2)).toBe(2)
    const versions = (await db.select({ v: claim.embeddingVersion }).from(claim)).map((r) => r.v)
    expect(versions.every((v) => v === 'fake:v2')).toBe(true)
    // re-running reembed skips already-current claims
    expect(await reembedMarked(db, v2)).toBe(0)
  })
})

// --- vector helpers for the semantic tests (1024-dim, deterministic) ---
function unit(i: number): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0)
  v[i % EMBEDDING_DIM] = 1
  return v
}
function mix(i: number, j: number, w: number): number[] {
  // w·e_i + (1-w)·e_j, L2-normalized → cosine with e_i ≈ w/sqrt(w²+(1-w)²)
  const v = new Array<number>(EMBEDDING_DIM).fill(0)
  v[i % EMBEDDING_DIM] = w
  v[j % EMBEDDING_DIM] = 1 - w
  const n = Math.hypot(w, 1 - w) || 1
  return v.map((x) => x / n)
}
