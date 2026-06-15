import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { CALIBRATION_IDENTITY, DEFAULT_WEIGHTS } from '../confidence/confidence.js'
import { createDb, type DB } from '../db/client.js'
import { makeFakeEmbedder } from '../embedding/fake-embedder.js'
import { claim, claimProvenance } from '../db/schema.js'
import { addSource, appendClaim } from '../spi/append-claim.js'
import { reportUsage } from '../spi/report-usage.js'
import { refluxFailures, getRegressionPool } from '../spi/reflux.js'
import { resolveConflict } from '../spi/conflict-arbiter.js'
import { writePatrolVerdict } from '../verifier/patrol-verdict.js'
import { recordHumanOverturn } from '../editor/human-overturn.js'
import { freezeRedTeamGeneration, recordImmunityScore } from '../spi/redteam-generation.js'
import {
  attributeFailure,
  loopForRedTeamClass,
  PRECEDENCE,
  RESPONSIBLE_LOOP,
  RESPONSIBLE_LOOPS,
  type Attribution,
} from '../eval/attribution-spine.js'

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
  await pool.query(
    'TRUNCATE source, claim, claim_provenance, claim_verification, relation, metrics_events, regression_pool, l5_candidates, redteam_generations, redteam_immunity_scores CASCADE',
  )
})

/** A recallable active claim addressable by `query`, with a chosen provenance relevance. */
async function seedClaim(
  text: string,
  query: string,
  opts: {
    relevance?: 'exact' | 'supporting' | 'tangential' | 'irrelevant'
    createdBy?: string
  } = {},
): Promise<string> {
  const id = randomUUID()
  const vector = await embedder.embed(query, 'query')
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
    createdBy: opts.createdBy ?? 'agent:distiller',
    embedding: vector,
    embeddingVersion: embedder.version,
  })
  const { sourceId } = await addSource(db, {
    content: 'body',
    contentHash: randomUUID(),
    kind: 'structured_spec',
    authorityScore: 0.6,
  })
  await db.insert(claimProvenance).values({
    id: randomUUID(),
    claimId: id,
    sourceId,
    locator: 'p1',
    relevance: opts.relevance ?? 'exact',
  })
  return id
}

/** Make a refluxed regression item for `claimId` (a refuted usage outcome → regression_pool). Returns its pool id. */
async function refluxOne(claimId: string, query: string): Promise<string> {
  await reportUsage(db, claimId, 'refuted', { byRole: 'consumer:x', query })
  await refluxFailures(db)
  const pool = await getRegressionPool(db)
  const item = pool.find((p) => p.claimId === claimId)
  if (!item) throw new Error('refluxOne: no regression item for claim')
  return item.id
}

describe('S31 attribution spine — SINGLE-LOOP deterministic failure attribution (P3 gate)', () => {
  it('the responsible-loop domain is exactly the 4 classes (Distiller/Verifier/Arbiter/calibration)', () => {
    expect(new Set(RESPONSIBLE_LOOPS)).toEqual(
      new Set([
        'distiller_mis_extract',
        'verifier_miss',
        'arbiter_mis_adjudicate',
        'calibration_drift',
      ]),
    )
    // PRECEDENCE is a deterministic total order over all 4 (the single tie-break table)
    expect(new Set(PRECEDENCE)).toEqual(new Set(RESPONSIBLE_LOOPS))
    expect(PRECEDENCE.length).toBe(4)
  })

  // ── the 4 attribution classes, each tracing to EXACTLY ONE loop ──

  it('class 1 — Distiller mis-extract: a refluxed failure whose claim has NO exact/supporting provenance → distiller_mis_extract', async () => {
    // tangential-only provenance ⇒ the claim was distilled but never aligned to a supporting source.
    const c = await seedClaim('alpha answer one', 'alpha question one', { relevance: 'tangential' })
    const refId = await refluxOne(c, 'alpha question one')
    const a = await attributeFailure(db, { kind: 'reflux_regression', regressionId: refId })
    expect(a.responsibleLoop).toBe(RESPONSIBLE_LOOP.distillerMisExtract)
    expect(a.candidates).toContain(RESPONSIBLE_LOOP.distillerMisExtract)
    expect(a.claimId).toBe(c)
  })

  it('class 2 — Verifier miss: a grounded, never-patrolled, non-adjudicated failure → verifier_miss', async () => {
    // exact provenance (grounded) + never patrolled + not an adjudicated loser ⇒ the Verifier should have flagged it.
    const c = await seedClaim('beta answer two', 'beta question two', { relevance: 'exact' })
    const refId = await refluxOne(c, 'beta question two')
    const a = await attributeFailure(db, { kind: 'reflux_regression', regressionId: refId })
    expect(a.responsibleLoop).toBe(RESPONSIBLE_LOOP.verifierMiss)
  })

  it('class 3 — Arbiter mis-adjudicate: a grounded failure that was the WINNER of a resolved conflict → arbiter_mis_adjudicate', async () => {
    // EGR-CR-057 polarity: for a reflux failure, the failed claim is the one usage truth proved wrong.
    // "Arbiter mis-adjudicate" means the Arbiter crowned the WRONG claim as winner — so the failed
    // (refuted) claim having been the conflict WINNER is the mis-adjudication, NOT it having lost.
    const wrongWinner = await seedClaim('gamma answer three', 'gamma question three', {
      relevance: 'exact',
    })
    const rival = await seedClaim('gamma rival three', 'gamma rival three', { relevance: 'exact' })
    // Arbiter resolved the conflict crowning `wrongWinner`; usage truth later refutes it ⇒ wrong winner.
    await resolveConflict(db, {
      a: wrongWinner,
      b: rival,
      adjudication: {
        outcome: 'winner',
        winnerId: wrongWinner,
        loserId: rival,
        rung: 'authority',
        reason: 'test',
      },
      byRole: 'agent:arbiter',
    })
    const refId = await refluxOne(wrongWinner, 'gamma question three')
    const a = await attributeFailure(db, { kind: 'reflux_regression', regressionId: refId })
    expect(a.responsibleLoop).toBe(RESPONSIBLE_LOOP.arbiterMisAdjudicate)
  })

  it('class 4 — calibration drift: a grounded, patrolled, non-adjudicated failure → calibration_drift (the catch-all over-confident g)', async () => {
    const c = await seedClaim('delta answer four', 'delta question four', { relevance: 'exact' })
    // it WAS patrolled (so not a verifier miss), grounded (not distiller), not adjudicated ⇒ only g over-confidence remains.
    await writePatrolVerdict(db, {
      claimId: c,
      byRole: 'agent:verifier',
      verdict: { entailment: 'pass' },
    })
    const refId = await refluxOne(c, 'delta question four')
    const a = await attributeFailure(db, { kind: 'reflux_regression', regressionId: refId })
    expect(a.responsibleLoop).toBe(RESPONSIBLE_LOOP.calibrationDrift)
  })

  // ── EGR-CR-057: reflux winner/loser polarity (a refluxed failure claim is the one usage truth proved WRONG) ──

  it('EGR-CR-057 — reflux failure claim that was the conflict LOSER does NOT attribute to Arbiter (the Arbiter ruled it down correctly)', async () => {
    // The Arbiter correctly ruled the wrong claim down; that is NOT a mis-adjudication. The failure must
    // fall through to the downstream catch-all (here verifier_miss), NOT arbiter_mis_adjudicate.
    const loser = await seedClaim('cr057 loser answer', 'cr057 loser question', {
      relevance: 'exact', // grounded ⇒ excludes distiller_mis_extract
    })
    const winner = await seedClaim('cr057 winner answer', 'cr057 winner rival', {
      relevance: 'exact',
    })
    await resolveConflict(db, {
      a: loser,
      b: winner,
      adjudication: {
        outcome: 'winner',
        winnerId: winner,
        loserId: loser, // Arbiter correctly ruled the (to-be-refuted) claim the loser
        rung: 'authority',
        reason: 'test',
      },
      byRole: 'agent:arbiter',
    })
    // deliberately NOT patrolled ⇒ the catch-all lands on verifier_miss (sharper assertion)
    const refId = await refluxOne(loser, 'cr057 loser question')
    const a = await attributeFailure(db, { kind: 'reflux_regression', regressionId: refId })
    expect(a.responsibleLoop).not.toBe(RESPONSIBLE_LOOP.arbiterMisAdjudicate)
    expect(a.candidates).not.toContain(RESPONSIBLE_LOOP.arbiterMisAdjudicate)
    expect(a.responsibleLoop).toBe(RESPONSIBLE_LOOP.verifierMiss)
  })

  it('EGR-CR-057 — reflux failure claim that was the conflict WINNER attributes to Arbiter (it crowned the wrong winner)', async () => {
    const wrongWinner = await seedClaim('cr057 ww answer', 'cr057 ww question', {
      relevance: 'exact',
    })
    const rival = await seedClaim('cr057 ww rival', 'cr057 ww rival', { relevance: 'exact' })
    await resolveConflict(db, {
      a: wrongWinner,
      b: rival,
      adjudication: {
        outcome: 'winner',
        winnerId: wrongWinner, // Arbiter crowned the (to-be-refuted) claim as winner ⇒ mis-adjudicate
        loserId: rival,
        rung: 'authority',
        reason: 'test',
      },
      byRole: 'agent:arbiter',
    })
    const refId = await refluxOne(wrongWinner, 'cr057 ww question')
    const a = await attributeFailure(db, { kind: 'reflux_regression', regressionId: refId })
    expect(a.responsibleLoop).toBe(RESPONSIBLE_LOOP.arbiterMisAdjudicate)
    expect(a.candidates).toContain(RESPONSIBLE_LOOP.arbiterMisAdjudicate)
    expect(a.claimId).toBe(wrongWinner)
  })

  // ── EXACTLY-ONE is the gate: never zero, never multiple ──

  it('EXACTLY-ONE: every reflux failure resolves to a single responsible loop (never zero, never multiple)', async () => {
    // four independent failures, one per class
    const c1 = await seedClaim('e1', 'q1', { relevance: 'tangential' })
    const c2 = await seedClaim('e2', 'q2', { relevance: 'exact' })
    const c3 = await seedClaim('e3', 'q3', { relevance: 'exact' })
    const c3b = await seedClaim('e3b', 'q3b', { relevance: 'exact' })
    // EGR-CR-057 polarity: the refluxed failure claim (c3) must be the conflict WINNER to exercise the
    // arbiter_mis_adjudicate candidate (a refuted claim the Arbiter crowned = the wrong winner).
    await resolveConflict(db, {
      a: c3,
      b: c3b,
      adjudication: {
        outcome: 'winner',
        winnerId: c3,
        loserId: c3b,
        rung: 'authority',
        reason: 'r',
      },
      byRole: 'agent:arbiter',
    })
    const c4 = await seedClaim('e4', 'q4', { relevance: 'exact' })
    await writePatrolVerdict(db, {
      claimId: c4,
      byRole: 'agent:verifier',
      verdict: { entailment: 'pass' },
    })

    const ids = [
      await refluxOne(c1, 'q1'),
      await refluxOne(c2, 'q2'),
      await refluxOne(c3, 'q3'),
      await refluxOne(c4, 'q4'),
    ]
    for (const refId of ids) {
      const a = await attributeFailure(db, { kind: 'reflux_regression', regressionId: refId })
      // exactly one responsible loop, and it is a member of the frozen domain
      expect(RESPONSIBLE_LOOPS).toContain(a.responsibleLoop)
      // candidates[0] === responsibleLoop and it's always a non-empty, deduped, precedence-ordered list
      expect(a.candidates[0]).toBe(a.responsibleLoop)
      expect(a.candidates.length).toBeGreaterThanOrEqual(1)
      expect(new Set(a.candidates).size).toBe(a.candidates.length)
    }
  })

  it('TIE-BREAK precedence: a claim hitting MULTIPLE root-causes still resolves to exactly ONE via the deterministic table', async () => {
    // a claim that is BOTH mis-aligned (tangential only) AND an adjudicated WINNER (EGR-CR-057 polarity:
    // the refuted claim the Arbiter crowned) AND never patrolled: three candidates fire, but precedence
    // ⇒ distiller_mis_extract (the most specific upstream root) wins, alone.
    const multi = await seedClaim('multi answer', 'multi question', { relevance: 'tangential' })
    const rival = await seedClaim('multi rival', 'multi rival', { relevance: 'exact' })
    await resolveConflict(db, {
      a: multi,
      b: rival,
      adjudication: {
        outcome: 'winner',
        winnerId: multi,
        loserId: rival,
        rung: 'authority',
        reason: 'r',
      },
      byRole: 'agent:arbiter',
    })
    const refId = await refluxOne(multi, 'multi question')
    const a = await attributeFailure(db, { kind: 'reflux_regression', regressionId: refId })
    // multiple candidates hit, but the SINGLE responsible loop is the precedence-first one
    expect(a.candidates).toEqual(
      expect.arrayContaining([
        RESPONSIBLE_LOOP.distillerMisExtract,
        RESPONSIBLE_LOOP.arbiterMisAdjudicate,
        RESPONSIBLE_LOOP.verifierMiss,
      ]),
    )
    expect(a.responsibleLoop).toBe(RESPONSIBLE_LOOP.distillerMisExtract) // precedence[0] among the hits
    // candidates is exactly the precedence-ordered intersection (deterministic projection)
    expect(a.candidates).toEqual(PRECEDENCE.filter((l) => a.candidates.includes(l)))
  })

  it('DETERMINISTIC: the same logged failure → the same single responsible loop, every time (reproducible)', async () => {
    const multi = await seedClaim('det answer', 'det question', { relevance: 'tangential' })
    const rival = await seedClaim('det rival', 'det rival', { relevance: 'exact' })
    // EGR-CR-057 polarity: refluxed failure claim (multi) is the conflict WINNER (the wrong winner).
    await resolveConflict(db, {
      a: multi,
      b: rival,
      adjudication: {
        outcome: 'winner',
        winnerId: multi,
        loserId: rival,
        rung: 'authority',
        reason: 'r',
      },
      byRole: 'agent:arbiter',
    })
    const refId = await refluxOne(multi, 'det question')
    const runs: Attribution[] = []
    for (let i = 0; i < 5; i++) {
      runs.push(await attributeFailure(db, { kind: 'reflux_regression', regressionId: refId }))
    }
    // byte-for-byte identical attribution across repeated traces (no clock/random/order dependence)
    for (const r of runs) {
      expect(r).toEqual(runs[0])
    }
  })

  // ── red-team breach class ──

  it('red-team breach: each of the 4 redteam classes maps deterministically to exactly one loop', () => {
    expect(loopForRedTeamClass('false')).toBe(RESPONSIBLE_LOOP.verifierMiss)
    expect(loopForRedTeamClass('near_dup_poison')).toBe(RESPONSIBLE_LOOP.verifierMiss)
    expect(loopForRedTeamClass('contradiction')).toBe(RESPONSIBLE_LOOP.arbiterMisAdjudicate)
    expect(loopForRedTeamClass('stale')).toBe(RESPONSIBLE_LOOP.calibrationDrift)
  })

  it('red-team breach: a generation/class with detected<injected (a pathogen the worker FAILED to detect) attributes to a single loop', async () => {
    await freezeRedTeamGeneration(db, {
      version: 'rt-s31',
      items: [
        {
          id: 'i1',
          redteamClass: 'false',
          claimText: 'x',
          evidence: 'y',
          sourceKind: 'external_feed',
        },
      ],
      reason: 'test',
    })
    // a BREACH: 3 of 10 false-class pathogens slipped past the Verifier
    await recordImmunityScore(db, {
      generationVersion: 'rt-s31',
      redteamClass: 'false',
      injected: 10,
      detected: 7,
    })
    const a = await attributeFailure(db, {
      kind: 'redteam_breach',
      generationVersion: 'rt-s31',
      redteamClass: 'false',
    })
    expect(a.responsibleLoop).toBe(RESPONSIBLE_LOOP.verifierMiss)
    expect(a.candidates).toEqual([RESPONSIBLE_LOOP.verifierMiss]) // single
    expect(a.claimId).toBeNull()
  })

  it('red-team breach: NO breach (detected===injected) is not a failure — attributeFailure refuses it (no zero/false attribution)', async () => {
    await freezeRedTeamGeneration(db, {
      version: 'rt-clean',
      items: [
        {
          id: 'i1',
          redteamClass: 'stale',
          claimText: 'x',
          evidence: 'y',
          sourceKind: 'external_feed',
        },
      ],
      reason: 'test',
    })
    await recordImmunityScore(db, {
      generationVersion: 'rt-clean',
      redteamClass: 'stale',
      injected: 5,
      detected: 5,
    })
    await expect(
      attributeFailure(db, {
        kind: 'redteam_breach',
        generationVersion: 'rt-clean',
        redteamClass: 'stale',
      }),
    ).rejects.toThrow(/no breach/)
  })

  // ── human-overturn mis-quarantine class ──

  it('human-overturn mis-quarantine: an un_quarantine traces through the same claim-evidence table to one loop', async () => {
    const c = await seedClaim('hq answer', 'hq question', { relevance: 'tangential' })
    const { eventId } = await recordHumanOverturn(db, {
      overturn: 'un_quarantine',
      claimId: c,
      fromStatus: 'quarantined',
      toStatus: 'active',
      byRole: 'human:editor',
    })
    const a = await attributeFailure(db, {
      kind: 'human_overturn_mis_quarantine',
      overturnEventId: eventId,
    })
    // mis-aligned claim ⇒ distiller_mis_extract, single loop
    expect(a.responsibleLoop).toBe(RESPONSIBLE_LOOP.distillerMisExtract)
    expect(a.claimId).toBe(c)
  })

  it('EGR-CR-057 — human-overturn polarity is OPPOSITE to reflux: an un_quarantined claim that was a conflict LOSER attributes to Arbiter', async () => {
    // A mis-quarantined claim is a GOOD claim the agent wrongly suppressed. For it, "Arbiter mis-adjudicate"
    // means the Arbiter wrongly ruled this good claim DOWN (loser) — so the human_overturn polarity is 'lost',
    // the exact opposite of reflux's 'won'. This is why one wasAdjudicatedLoser() cannot cover all sources.
    const good = await seedClaim('hq-loser answer', 'hq-loser question', { relevance: 'exact' })
    const winner = await seedClaim('hq-loser rival', 'hq-loser rival', { relevance: 'exact' })
    await resolveConflict(db, {
      a: good,
      b: winner,
      adjudication: {
        outcome: 'winner',
        winnerId: winner,
        loserId: good, // Arbiter ruled the GOOD claim down ⇒ mis-adjudicate (human had to un-quarantine it)
        rung: 'authority',
        reason: 'test',
      },
      byRole: 'agent:arbiter',
    })
    const { eventId } = await recordHumanOverturn(db, {
      overturn: 'un_quarantine',
      claimId: good,
      fromStatus: 'quarantined',
      toStatus: 'active',
      byRole: 'human:editor',
    })
    const a = await attributeFailure(db, {
      kind: 'human_overturn_mis_quarantine',
      overturnEventId: eventId,
    })
    // grounded + adjudicated LOSER ⇒ arbiter_mis_adjudicate (polarity 'lost', opposite of reflux)
    expect(a.responsibleLoop).toBe(RESPONSIBLE_LOOP.arbiterMisAdjudicate)
    expect(a.candidates).toContain(RESPONSIBLE_LOOP.arbiterMisAdjudicate)
    expect(a.claimId).toBe(good)
  })

  it('EGR-CR-057 — human-overturn does NOT attribute to Arbiter when the un_quarantined claim was a conflict WINNER (opposite polarity to reflux)', async () => {
    // Mirror image: a good claim that happened to have WON a conflict is NOT an Arbiter mis-adjudication
    // for the human_overturn source (under 'lost' polarity it must have lost). Grounded + never patrolled
    // ⇒ falls through to verifier_miss, NOT arbiter.
    const good = await seedClaim('hq-winner answer', 'hq-winner question', { relevance: 'exact' })
    const rival = await seedClaim('hq-winner rival', 'hq-winner rival', { relevance: 'exact' })
    await resolveConflict(db, {
      a: good,
      b: rival,
      adjudication: {
        outcome: 'winner',
        winnerId: good,
        loserId: rival,
        rung: 'authority',
        reason: 'test',
      },
      byRole: 'agent:arbiter',
    })
    const { eventId } = await recordHumanOverturn(db, {
      overturn: 'un_quarantine',
      claimId: good,
      fromStatus: 'quarantined',
      toStatus: 'active',
      byRole: 'human:editor',
    })
    const a = await attributeFailure(db, {
      kind: 'human_overturn_mis_quarantine',
      overturnEventId: eventId,
    })
    expect(a.responsibleLoop).not.toBe(RESPONSIBLE_LOOP.arbiterMisAdjudicate)
    expect(a.candidates).not.toContain(RESPONSIBLE_LOOP.arbiterMisAdjudicate)
    expect(a.responsibleLoop).toBe(RESPONSIBLE_LOOP.verifierMiss)
  })

  it('human-overturn: a non-un_quarantine overturn (e.g. pardon) is rejected (only mis-quarantine is this failure)', async () => {
    const c = await seedClaim('pd answer', 'pd question', { relevance: 'exact' })
    const { eventId } = await recordHumanOverturn(db, {
      overturn: 'pardon',
      claimId: c,
      fromStatus: 'flagged',
      toStatus: 'active',
      byRole: 'human:editor',
    })
    await expect(
      attributeFailure(db, { kind: 'human_overturn_mis_quarantine', overturnEventId: eventId }),
    ).rejects.toThrow(/only un_quarantine/)
  })

  it('a missing failure ref is rejected (cannot attribute a phantom failure)', async () => {
    await expect(
      attributeFailure(db, { kind: 'reflux_regression', regressionId: randomUUID() }),
    ).rejects.toThrow(/not found/)
  })
})
