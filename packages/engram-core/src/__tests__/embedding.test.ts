import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { eq } from 'drizzle-orm'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { CALIBRATION_IDENTITY, DEFAULT_WEIGHTS } from '../confidence/confidence.js'
import { createDb, type DB } from '../db/client.js'
import { EMBEDDING_DIM, type Embedder } from '../embedding/embedder.js'
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
  admin.on('error', () => {})
  await admin.query(`CREATE DATABASE ${testDbName}`)
  const url = new URL(DATABASE_URL)
  url.pathname = `/${testDbName}`
  pool = new pg.Pool({ connectionString: url.toString() })
  pool.on('error', () => {}) // 吞 teardown 期 DROP ... WITH(FORCE) 终止连接的 57P01（测试已结束、连接被服务端杀属预期）
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

  it('reembed writes the NEW vector (not just bumps the version)', async () => {
    const v1 = makeFakeEmbedder({ version: 'fake:v1' }) // trigram vector
    const newVec = unit(13)
    const v2 = makeFakeEmbedder({ version: 'fake:v2', vectorOf: () => newVec }) // distinct vector
    const s = await aSource()
    const { claimId } = await appendClaim(db, v1, { claimText: 'vector should change' }, [
      { sourceId: s.sourceId, locator: 'l' },
    ])
    await markStaleForReembed(db, v2.version)
    await reembedMarked(db, v2)
    const [row] = await db
      .select({ embedding: claim.embedding, version: claim.embeddingVersion })
      .from(claim)
      .where(eq(claim.id, claimId))
    expect(row!.version).toBe('fake:v2')
    expect(row!.embedding).toEqual(newVec) // the actual vector was rewritten, not left stale
  })

  it('candidate retrieval is capped at topK by vector distance — a high-confidence claim beyond top-k is dropped pre-gate', async () => {
    const qe = makeFakeEmbedder({ vectorOf: () => unit(0) }) // every query → e0
    await seedActiveWithVector('near one', vec(1.0)) // cosine 1.0
    await seedActiveWithVector('near two', vec(0.9)) // cosine 0.9
    await seedActiveWithVector('near three', vec(0.8)) // cosine 0.8 — 3rd nearest, still high confidence

    expect((await recallClaims(db, qe, 'q')).length).toBe(3) // default topK keeps all three
    const top2 = await recallClaims(db, qe, 'q', { topK: 2 })
    expect(top2.map((r) => r.claim.claimText).sort()).toEqual(['near one', 'near two']) // 3rd dropped by topK
  })

  it('the minSimilarity floor (ctx override) gates candidates exactly at the cosine boundary', async () => {
    const qe = makeFakeEmbedder({ vectorOf: () => unit(0) })
    await seedActiveWithVector('cosine 0.6 claim', vec(0.6))
    const included = await recallClaims(db, qe, 'q', { minSimilarity: 0.5 })
    expect(included.map((r) => r.claim.claimText)).toEqual(['cosine 0.6 claim']) // 0.6 ≥ 0.5 → in
    expect(await recallClaims(db, qe, 'q', { minSimilarity: 0.7 })).toEqual([]) // 0.6 < 0.7 → out
  })

  it('recall consults the EMBEDDER-declared minSimilarity (middle tier) when ctx gives none', async () => {
    // embedder declares 0.5 (like DashScope); a cosine-0.3 claim is above DEFAULT(0.1) but below 0.5
    const e = { ...makeFakeEmbedder({ vectorOf: () => unit(0) }), minSimilarity: 0.5 }
    await seedActiveWithVector('cosine 0.3 claim', vec(0.3))
    await seedActiveWithVector('cosine 0.8 claim', vec(0.8))
    const hits = await recallClaims(db, e, 'q') // no ctx override → embedder floor 0.5 applies
    expect(hits.map((r) => r.claim.claimText)).toEqual(['cosine 0.8 claim']) // 0.3 gated out by embedder floor
  })

  it('an active claim with a NULL embedding is excluded from recall (legacy coexistence; no error)', async () => {
    const id = randomUUID()
    await db.insert(claim).values({
      id,
      claimText: 'legacy unembedded active claim',
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
      embedding: null, // legacy / unembedded
      embeddingVersion: null,
    })
    const { sourceId } = await aSource()
    await db
      .insert(claimProvenance)
      .values({ id: randomUUID(), claimId: id, sourceId, locator: 'p1', relevance: 'exact' })
    // high confidence + active, but no vector → must not surface and must not throw
    expect(await recallClaims(db, embedder, 'legacy unembedded active claim')).toEqual([])
  })

  it('markStaleForReembed also catches NULL-version (pre-S9 / legacy) claims', async () => {
    const id = randomUUID()
    await db.insert(claim).values({
      id,
      claimText: 'legacy null-version claim',
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
      embedding: await embedder.embed('legacy null-version claim'),
      embeddingVersion: null, // no version anchor (legacy)
    })
    expect(await markStaleForReembed(db, embedder.version)).toBe(1) // null version is stale
    expect((await getReembedMarkers(db)).map((m) => m.claimId)).toEqual([id])
    expect(await reembedMarked(db, embedder)).toBe(1)
    const [row] = await db.select({ v: claim.embeddingVersion }).from(claim).where(eq(claim.id, id))
    expect(row!.v).toBe(embedder.version) // legacy row now stamped current
  })

  it('threads kind through the SPI: append embeds claim_text as document, recall embeds the query as query', async () => {
    const calls: (string | undefined)[] = []
    const recording: Embedder = {
      version: 'fake:recording',
      dim: EMBEDDING_DIM,
      embed: (_text: string, kind?: 'query' | 'document') => {
        calls.push(kind)
        return Promise.resolve(unit(0))
      },
    }
    const { sourceId } = await aSource()
    await appendClaim(db, recording, { claimText: 'kind probe' }, [{ sourceId, locator: 'l' }])
    await recallClaims(db, recording, 'kind probe')
    expect(calls).toEqual(['document', 'query']) // append → document, recall query → query
  })
})

// --- vector helpers for the semantic tests (1024-dim, deterministic) ---
function unit(i: number): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0)
  v[i % EMBEDDING_DIM] = 1
  return v
}
/** unit vector whose cosine with e0 (= unit(0)) is exactly `cos`. */
function vec(cos: number): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0)
  v[0] = cos
  v[1] = Math.sqrt(Math.max(0, 1 - cos * cos))
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
