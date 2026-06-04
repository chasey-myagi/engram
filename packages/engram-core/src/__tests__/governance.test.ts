/**
 * S26 GovernanceController 恒温器 — DB 集成测试。
 * 验证：真 SPI 喂五指标 / 版本化持久化 / gate 抬严遵 S7 + 历史快照冻结 / 可逆 + 审计 / 失效静音退回主干 /
 * falseQuarantineRate 由真 S22 human_overturn(un_quarantine) 喂。
 */
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  CALIBRATION_IDENTITY,
  DEFAULT_WEIGHTS,
  KERNEL_CONFIDENCE_FLOOR,
  MUST_VERIFY_THRESHOLD,
} from '../confidence/confidence.js'
import { getActiveStandards, setStandards } from '../config/standards.js'
import { createDb, type DB } from '../db/client.js'
import { claim, claimProvenance, governanceState, type ClaimStatus } from '../db/schema.js'
import { makeFakeEmbedder } from '../embedding/fake-embedder.js'
import { addSource } from '../spi/append-claim.js'
import { recallClaims } from '../spi/recall-claims.js'
import { writePatrolVerdict } from '../verifier/patrol-verdict.js'
import { recordHumanOverturn } from '../editor/human-overturn.js'
import { escalateConflict } from '../spi/conflict-arbiter.js'
import {
  runGovernanceCycle,
  getActivePolicy,
  getGovernanceHistory,
  rollbackTo,
  writeGovernanceState,
  readMetrics,
  readDistillBacklog,
  readEntailRejectRate,
  readConflictQueueDepth,
  readFalseQuarantineRate,
  BASELINE_POLICY,
  type MetricReaders,
} from '../governance/index.js'

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://engram:engram@localhost:5433/engram'
const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle')
const embedder = makeFakeEmbedder()

let admin: pg.Pool
let pool: pg.Pool
let db: DB
let testDbName: string

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
  await pool.query(
    'TRUNCATE source, claim, claim_provenance, relation, claim_verification, metrics_events, standards, governance_state CASCADE',
  )
})

async function seedClaim(opts: {
  text?: string
  status?: ClaimStatus
  factorAuthority?: number
}): Promise<string> {
  const id = randomUUID()
  const text = opts.text ?? `claim-${id}`
  await db.insert(claim).values({
    id,
    claimText: text,
    status: opts.status ?? 'draft',
    confidence: 0,
    confidenceRaw: 0,
    confidenceFactors: {
      factors: {
        authority: opts.factorAuthority ?? 0,
        humanReview: 0,
        entailment: 0.5,
        indepSupport: 0,
        usageCorrect: 0,
        ageDays: 0,
        activeContradicts: 0,
        staleDecay: 1,
        conflictDecay: 1,
      },
      weights: DEFAULT_WEIGHTS,
      calibrationVersion: CALIBRATION_IDENTITY,
    },
    embedding: await embedder.embed(text),
    embeddingVersion: embedder.version,
    lineageId: randomUUID(),
    asOf: new Date(),
    createdBy: 'test',
  })
  const { sourceId } = await addSource(db, {
    content: `body-${id}`,
    contentHash: randomUUID(),
    kind: 'structured_spec',
    authorityScore: 0.9,
  })
  await db
    .insert(claimProvenance)
    .values({ id: randomUUID(), claimId: id, sourceId, locator: 'p1', relevance: 'exact' })
  return id
}

describe('S26 governance — metric readers fed by real SPIs', () => {
  it('readDistillBacklog counts draft claims', async () => {
    await seedClaim({ status: 'draft' })
    await seedClaim({ status: 'draft' })
    await seedClaim({ status: 'active' })
    expect(await readDistillBacklog(db)).toBe(2)
  })

  it('readEntailRejectRate = fraction of latest patrol verdicts that are fail/not_co_true', async () => {
    const a = await seedClaim({})
    const b = await seedClaim({})
    const c = await seedClaim({})
    const d = await seedClaim({})
    await writePatrolVerdict(db, {
      claimId: a,
      byRole: 'agent:verifier',
      verdict: { entailment: 'pass' },
    })
    await writePatrolVerdict(db, {
      claimId: b,
      byRole: 'agent:verifier',
      verdict: { entailment: 'fail' },
    })
    await writePatrolVerdict(db, {
      claimId: c,
      byRole: 'agent:verifier',
      verdict: { entailment: 'not_co_true' },
    })
    await writePatrolVerdict(db, {
      claimId: d,
      byRole: 'agent:verifier',
      verdict: { entailment: 'pass' },
    })
    expect(await readEntailRejectRate(db)).toBeCloseTo(0.5, 9) // 2 of 4 reject
  })

  it('readConflictQueueDepth counts escalated conflicts in the editor queue', async () => {
    const a = await seedClaim({})
    const b = await seedClaim({})
    await escalateConflict(db, { a, b, rung: 'human', reason: 'tie', byRole: 'agent:arbiter' })
    expect(await readConflictQueueDepth(db)).toBe(1)
  })

  it('readFalseQuarantineRate is fed by REAL S22 human_overturn(un_quarantine) events', async () => {
    const q1 = await seedClaim({ status: 'quarantined' })
    await seedClaim({ status: 'quarantined' }) // still quarantined → denominator
    // a human un-quarantined one claim (the false-quarantine signal)
    await recordHumanOverturn(db, {
      overturn: 'un_quarantine',
      claimId: q1,
      fromStatus: 'quarantined',
      toStatus: 'active',
      byRole: 'human:editor',
    })
    // 1 un_quarantine / (1 + 2 still-quarantined) = 0.333…
    expect(await readFalseQuarantineRate(db)).toBeCloseTo(1 / 3, 6)
  })

  it('readMetrics reports zero degraded when all readers succeed', async () => {
    await seedClaim({ status: 'draft' })
    const { metrics, degraded } = await readMetrics(db)
    expect(degraded).toHaveLength(0)
    expect(metrics.distillBacklog).toBe(1)
    // immuneLag has no data source → honestly 0 (NOT degraded; it's a legitimate read returning neutral)
    expect(metrics.immuneLag).toBe(0)
  })
})

describe('S26 governance — versioned persistence (Standards-style append-only) + reversibility', () => {
  it('getActivePolicy returns the baseline when empty; each cycle appends a new version', async () => {
    expect(await getActivePolicy(db)).toEqual(BASELINE_POLICY)
    await seedClaim({ status: 'draft' })
    const r1 = await runGovernanceCycle(db)
    expect(r1.ran).toBe(true)
    expect(await getGovernanceHistory(db)).toHaveLength(1)
    await runGovernanceCycle(db)
    const history = await getGovernanceHistory(db)
    expect(history).toHaveLength(2) // append-only: both retained, auditable
    // active = latest
    expect(await getActivePolicy(db)).toEqual(history[0]!.policy)
  })

  it('every action is logged with the triggering metrics snapshot + reason (audit trail)', async () => {
    // 60 drafts → ingestionThrottle pressure
    for (let i = 0; i < 60; i++) await seedClaim({ status: 'draft' })
    const r = await runGovernanceCycle(db)
    expect(r.ran).toBe(true)
    const [row] = await getGovernanceHistory(db)
    expect(row!.reason).toMatch(/cycle/)
    expect(row!.metrics.distillBacklog).toBe(60)
    expect(row!.metrics.targets).toBeDefined() // derived balance point snapshot persisted
    expect(row!.createdBy).toBe('controller:governance')
  })

  it('rollbackTo is reversible and append-only: it re-appends the old policy as a new logged version', async () => {
    const v0 = await writeGovernanceState(db, {
      policy: { ...BASELINE_POLICY, promotionGateLevel: 0.1 },
      metrics: {
        distillBacklog: 0,
        entailRejectRate: 0.1,
        conflictQueueDepth: 0,
        immuneLag: 0,
        falseQuarantineRate: 0,
      },
      reason: 'v0',
    })
    await writeGovernanceState(db, {
      policy: { ...BASELINE_POLICY, promotionGateLevel: 0.9 },
      metrics: {
        distillBacklog: 0,
        entailRejectRate: 0.9,
        conflictQueueDepth: 0,
        immuneLag: 0,
        falseQuarantineRate: 0,
      },
      reason: 'v1 tightened hard',
    })
    expect((await getActivePolicy(db)).promotionGateLevel).toBe(0.9)
    const rolled = await rollbackTo(db, v0.id, 'human:editor')
    expect(rolled.policy.promotionGateLevel).toBe(0.1) // restored
    expect(rolled.reason).toMatch(/rollback to/)
    expect(rolled.createdBy).toBe('human:editor')
    expect(await getGovernanceHistory(db)).toHaveLength(3) // v0, v1, rollback — nothing deleted
    expect((await getActivePolicy(db)).promotionGateLevel).toBe(0.1)
  })

  it('rollbackTo throws on a missing state id', async () => {
    await expect(rollbackTo(db, randomUUID())).rejects.toThrow(/not found/)
  })
})

describe('S26 governance — gate tightening respects S7 invariants + frozen snapshot', () => {
  it('a tightening cycle RAISES the consume gate (never below kernel floors) and only after enough pressure', async () => {
    // heavy entail-reject → promotionGateLevel target high → gate should raise
    for (let i = 0; i < 5; i++) {
      const id = await seedClaim({})
      await writePatrolVerdict(db, {
        claimId: id,
        byRole: 'agent:verifier',
        verdict: { entailment: 'fail' },
      })
    }
    const before = await getActiveStandards(db)
    expect(before.consumeFloor).toBe(KERNEL_CONFIDENCE_FLOOR) // default
    const r = await runGovernanceCycle(db)
    expect(r.ran).toBe(true)
    expect(r.raisedGate).toBe(true)
    const after = await getActiveStandards(db)
    expect(after.consumeFloor).toBeGreaterThan(KERNEL_CONFIDENCE_FLOOR)
    expect(after.consumeFloor).toBeGreaterThanOrEqual(KERNEL_CONFIDENCE_FLOOR) // never below kernel
    expect(after.mustVerifyThreshold).toBeGreaterThanOrEqual(MUST_VERIFY_THRESHOLD)
    expect(after.factorWeights).toEqual(before.factorWeights) // controller never touches weights
  })

  it('a healthy cycle does NOT raise the gate (closed-loop, not tighten-forever)', async () => {
    await seedClaim({ status: 'active' }) // no draft backlog, no rejects, no conflicts
    const r = await runGovernanceCycle(db)
    expect(r.ran).toBe(true)
    expect(r.raisedGate).toBe(false)
    expect(r.changed).toBe(false)
    expect((await getActiveStandards(db)).consumeFloor).toBe(KERNEL_CONFIDENCE_FLOOR)
  })

  it('the controller can never relax the gate below an existing human-set higher floor (only tightens)', async () => {
    // human sets a strict floor; a mild controller cycle must not lower it
    await setStandards(db, {
      factorWeights: DEFAULT_WEIGHTS,
      consumeFloor: 0.7,
      mustVerifyThreshold: 0.8,
    })
    await seedClaim({ status: 'active' }) // healthy → controller target gate ≈ baseline (lower)
    const r = await runGovernanceCycle(db)
    expect(r.ran).toBe(true)
    expect(r.raisedGate).toBe(false) // gateWouldTighten=false: controller never writes a relaxation
    const after = await getActiveStandards(db)
    expect(after.consumeFloor).toBe(0.7) // human floor preserved
    expect(after.mustVerifyThreshold).toBe(0.8)
  })

  it('threshold change affects only NEW recalls; a snapshot taken BEFORE the tightening stays frozen', async () => {
    // recomputes to 0.525 under DEFAULT weights (authority 1, entailment .5, indepSupport 1)
    const id = randomUUID()
    await db.insert(claim).values({
      id,
      claimText: 'engram frozen snapshot demo',
      status: 'active',
      confidence: 0,
      confidenceRaw: 0,
      confidenceFactors: {
        factors: {
          authority: 1,
          humanReview: 0,
          entailment: 0.5,
          indepSupport: 1,
          usageCorrect: 0,
          ageDays: 0,
          activeContradicts: 0,
          staleDecay: 1,
          conflictDecay: 1,
        },
        weights: DEFAULT_WEIGHTS,
        calibrationVersion: CALIBRATION_IDENTITY,
      },
      embedding: await embedder.embed('engram frozen snapshot demo'),
      embeddingVersion: embedder.version,
      lineageId: randomUUID(),
      asOf: new Date(),
      createdBy: 'test',
    })
    const { sourceId } = await addSource(db, {
      content: 'b',
      contentHash: randomUUID(),
      kind: 'structured_spec',
      authorityScore: 0.9,
    })
    await db
      .insert(claimProvenance)
      .values({ id: randomUUID(), claimId: id, sourceId, locator: 'p1', relevance: 'exact' })

    // recall BEFORE the controller tightens — capture the snapshot value
    const [before] = await recallClaims(db, embedder, 'engram frozen snapshot demo')
    expect(before!.confidence.value).toBeCloseTo(0.525, 6)

    // controller raises the gate above 0.525 (drive promotionGateLevel via heavy entail-reject)
    for (let i = 0; i < 5; i++) {
      const cid = await seedClaim({})
      await writePatrolVerdict(db, {
        claimId: cid,
        byRole: 'agent:verifier',
        verdict: { entailment: 'fail' },
      })
    }
    await runGovernanceCycle(db) // raises consumeFloor well above 0.525
    expect((await getActiveStandards(db)).consumeFloor).toBeGreaterThan(0.525)

    // the OLD snapshot object is a frozen value copy — the tightening did not retro-mutate it
    expect(before!.confidence.value).toBeCloseTo(0.525, 6)
    // a NEW recall now drops the 0.525 claim (below the raised floor)
    expect(await recallClaims(db, embedder, 'engram frozen snapshot demo')).toHaveLength(0)
  })
})

describe('S26 governance — silent degrade (zero orchestration single point)', () => {
  it('a throwing metric reader degrades that metric (not the cycle) and the cycle still completes deterministically', async () => {
    await seedClaim({ status: 'draft' })
    const flaky: MetricReaders = {
      distillBacklog: readDistillBacklog,
      entailRejectRate: async () => {
        throw new Error('entail reader exploded')
      },
      conflictQueueDepth: readConflictQueueDepth,
      immuneLag: async () => 0,
      falseQuarantineRate: readFalseQuarantineRate,
    }
    const r = await runGovernanceCycle(db, { readers: flaky })
    expect(r.ran).toBe(true) // cycle survived the reader failure
    expect(r.degraded).toContain('entailRejectRate')
    expect(r.metrics!.entailRejectRate).toBe(0) // degraded to neutral, no phantom tightening
    expect(r.metrics!.distillBacklog).toBe(1) // healthy readers still read
  })

  it('if the whole cycle errors (e.g. DB pool down), it returns ran=false and the trunk (recall) still serves', async () => {
    // seed a recallable active claim on the live db
    const id = randomUUID()
    await db.insert(claim).values({
      id,
      claimText: 'engram trunk survives',
      status: 'active',
      confidence: 0,
      confidenceRaw: 0,
      confidenceFactors: {
        factors: {
          authority: 1,
          humanReview: 1,
          entailment: 0.5,
          indepSupport: 1,
          usageCorrect: 1,
          ageDays: 0,
          activeContradicts: 0,
          staleDecay: 1,
          conflictDecay: 1,
        },
        weights: DEFAULT_WEIGHTS,
        calibrationVersion: CALIBRATION_IDENTITY,
      },
      embedding: await embedder.embed('engram trunk survives'),
      embeddingVersion: embedder.version,
      lineageId: randomUUID(),
      asOf: new Date(),
      createdBy: 'test',
    })
    const { sourceId } = await addSource(db, {
      content: 'b',
      contentHash: randomUUID(),
      kind: 'structured_spec',
      authorityScore: 0.9,
    })
    await db
      .insert(claimProvenance)
      .values({ id: randomUUID(), claimId: id, sourceId, locator: 'p1', relevance: 'exact' })

    // a controller wired to a dead DB handle: cycle must NOT throw, just no-op
    const deadPool = new pg.Pool({
      connectionString: 'postgresql://nobody:nobody@127.0.0.1:1/none',
    })
    const deadDb = createDb(deadPool)
    const r = await runGovernanceCycle(deadDb)
    expect(r.ran).toBe(false)
    expect(r.reason).toMatch(/degraded silently/)
    await deadPool.end()

    // the trunk on the live db is completely unaffected — recall still serves
    expect(await recallClaims(db, embedder, 'engram trunk survives')).toHaveLength(1)
    // and no governance/standards rows were written by the failed cycle
    expect(await getGovernanceHistory(db)).toHaveLength(0)
  })
})
