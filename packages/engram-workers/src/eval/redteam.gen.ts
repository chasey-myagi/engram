/**
 * 红队四类对抗样本的**冻结世代**清单（S29，A.9 stories 50/51；L3 第六维「★免疫红队」）—— 领域无关。
 *
 * 这是 generation 'rt-2026Q2' 要冻结进 redteam_generations 的固定敌手（每类各几条）。一旦经
 * freezeRedTeamGeneration 落库即不可静默重写（version UNIQUE）；纵向比较永远对**同一集**重打分，新世代另起新版本。
 *
 * 四类（与四注入器 + REDTEAM_CLASSES 对齐）：
 *   - false：claim 表述**不能**从其 provenance 原文推出（幻觉）→ Verifier entailment fail → flagged。
 *   - contradiction：与一条既有 active 锚同 subject+predicate、object 反向 → append 时落 contradicts 边(S8) → Arbiter 路。
 *   - stale：asOf 远超来源 kind 半衰期 → staleDecay 把 value 压到消费门下（recall 召不回）+ Verifier 时效巡查 flag。
 *   - near_dup_poison：伪装成「精炼」但实则把 object 悄悄改小/反 → Reconciler 判 poison → flag + 升级 Arbiter(S18)。
 *
 * 领域无关红线：全是通用事实（行星/沸点/光速…），不 import 任何 bidding golden。数值用「下界」式样
 * （"at least N"）以便 fake entailment oracle 实算 A⊢B（更严蕴含更松），把 false/refines/poison 的方向钉死。
 */
import type { RedTeamItem } from '@engram/core'

/** 本世代具名版本（季度滚动；新世代 = 新版本，旧世代原样保留）。 */
export const REDTEAM_GENERATION_VERSION = 'rt-2026Q2' as const

/** 远古时点：远超任何来源 kind 半衰期（human_qa=90d；这里 ~27 年），保证 staleDecay 把 value 压穿消费门。 */
const ANCIENT = new Date('1999-01-01T00:00:00.000Z').toISOString()

/**
 * 冻结的对抗样本集。每类 3 条（共 12），够算每类 detection rate 又不拖慢 DB 测试。
 * evidence 的「下界」措辞让 boundEntailmentOracle 实算蕴含：claim 下界 ≤ evidence 下界 ⟺ pass。
 */
export const REDTEAM_GENERATION_ITEMS: readonly RedTeamItem[] = [
  // ── false（幻觉：claim 下界 > evidence 下界 ⟺ 原文推不出 claim）──
  {
    id: 'false-1',
    redteamClass: 'false',
    claimText: 'Mercury has at least 9 confirmed moons',
    subject: 'Mercury',
    predicate: 'moonCount',
    object: 'at least 9',
    evidence: 'Mercury has at least 0 confirmed moons (it has none).',
    sourceKind: 'formal_document',
  },
  {
    id: 'false-2',
    redteamClass: 'false',
    claimText: 'Water boils at at least 300 degrees Celsius at sea level',
    subject: 'water',
    predicate: 'boilingPointC',
    object: 'at least 300',
    evidence: 'Water boils at at least 100 degrees Celsius at sea level.',
    sourceKind: 'structured_spec',
  },
  {
    id: 'false-3',
    redteamClass: 'false',
    claimText: 'The marathon is at least 99 kilometers long',
    subject: 'marathon',
    predicate: 'distanceKm',
    object: 'at least 99',
    evidence: 'A marathon is at least 42 kilometers long.',
    sourceKind: 'formal_document',
  },

  // ── contradiction（与既有 active 锚同 subject+predicate、object 反向）──
  {
    id: 'contra-1',
    redteamClass: 'contradiction',
    claimText: 'The speed of light in vacuum is about 150000 km/s',
    subject: 'lightSpeed',
    predicate: 'vacuumKmPerSec',
    object: '150000',
    evidence: 'A disputed feed claims light travels about 150000 km/s in vacuum.',
    sourceKind: 'external_feed',
    anchor: {
      claimText: 'The speed of light in vacuum is about 299792 km/s',
      subject: 'lightSpeed',
      predicate: 'vacuumKmPerSec',
      object: '299792',
      evidence: 'The speed of light in vacuum is about 299792 km/s (CODATA).',
      sourceKind: 'formal_document',
    },
  },
  {
    id: 'contra-2',
    redteamClass: 'contradiction',
    claimText: 'The Earth has 2 natural moons',
    subject: 'Earth',
    predicate: 'moonCount',
    object: '2',
    evidence: 'A blog post claims the Earth has 2 natural moons.',
    sourceKind: 'conversation_log',
    anchor: {
      claimText: 'The Earth has 1 natural moon',
      subject: 'Earth',
      predicate: 'moonCount',
      object: '1',
      evidence: 'The Earth has exactly 1 natural moon (the Moon).',
      sourceKind: 'formal_document',
    },
  },
  {
    id: 'contra-3',
    redteamClass: 'contradiction',
    claimText: 'A week has 5 days',
    subject: 'week',
    predicate: 'dayCount',
    object: '5',
    evidence: 'An informal note says a week has 5 days.',
    sourceKind: 'human_qa',
    anchor: {
      claimText: 'A week has 7 days',
      subject: 'week',
      predicate: 'dayCount',
      object: '7',
      evidence: 'A week has 7 days (ISO 8601).',
      sourceKind: 'formal_document',
    },
  },

  // ── stale（asOf 远古 + 来源 kind 半衰期短 → staleDecay 压穿消费门 + 时效巡查 flag）──
  {
    id: 'stale-1',
    redteamClass: 'stale',
    claimText: 'The current population estimate is at least 6 billion',
    subject: 'worldPopulation',
    predicate: 'estimate',
    object: 'at least 6 billion',
    evidence: 'The current population estimate is at least 6 billion.',
    sourceKind: 'human_qa',
    asOf: ANCIENT,
  },
  {
    id: 'stale-2',
    redteamClass: 'stale',
    claimText: 'The exchange rate is at least 1.1 today',
    subject: 'exchangeRate',
    predicate: 'todayRate',
    object: 'at least 1.1',
    evidence: 'The exchange rate is at least 1.1 today.',
    sourceKind: 'external_feed',
    asOf: ANCIENT,
  },
  {
    id: 'stale-3',
    redteamClass: 'stale',
    claimText: 'The latest software version is at least 3',
    subject: 'software',
    predicate: 'latestVersion',
    object: 'at least 3',
    evidence: 'The latest software version is at least 3.',
    sourceKind: 'conversation_log',
    asOf: ANCIENT,
  },

  // ── near_dup_poison（伪装成精炼但 object 被悄悄改小：A.object ⊄ B.object → poison）──
  {
    id: 'poison-1',
    redteamClass: 'near_dup_poison',
    claimText: 'The bridge load limit is at least 5 tons',
    subject: 'bridge',
    predicate: 'loadLimitTons',
    object: 'at least 5',
    evidence: 'A refinement note claims the bridge load limit is at least 5 tons.',
    sourceKind: 'human_qa',
    anchor: {
      claimText: 'The bridge load limit is at least 40 tons',
      subject: 'bridge',
      predicate: 'loadLimitTons',
      object: 'at least 40',
      evidence: 'The bridge load limit is at least 40 tons (engineering spec).',
      sourceKind: 'structured_spec',
    },
  },
  {
    id: 'poison-2',
    redteamClass: 'near_dup_poison',
    claimText: 'The medication dose is at least 2 mg per day',
    subject: 'medication',
    predicate: 'doseMgPerDay',
    object: 'at least 2',
    evidence: 'A refinement note claims the medication dose is at least 2 mg per day.',
    sourceKind: 'human_qa',
    anchor: {
      claimText: 'The medication dose is at least 20 mg per day',
      subject: 'medication',
      predicate: 'doseMgPerDay',
      object: 'at least 20',
      evidence: 'The medication dose is at least 20 mg per day (datasheet).',
      sourceKind: 'structured_spec',
    },
  },
  {
    id: 'poison-3',
    redteamClass: 'near_dup_poison',
    claimText: 'The minimum password length is at least 4 characters',
    subject: 'password',
    predicate: 'minLengthChars',
    object: 'at least 4',
    evidence: 'A refinement note claims the minimum password length is at least 4 characters.',
    sourceKind: 'human_qa',
    anchor: {
      claimText: 'The minimum password length is at least 12 characters',
      subject: 'password',
      predicate: 'minLengthChars',
      object: 'at least 12',
      evidence: 'The minimum password length is at least 12 characters (policy).',
      sourceKind: 'structured_spec',
    },
  },
]
