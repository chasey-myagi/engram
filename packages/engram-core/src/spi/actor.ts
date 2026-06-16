/**
 * 受信 actor 信任锚（EGR-CR-002，红线#2 的承重边界）—— 把「人身份」从「调用方自报的裸字符串」收口到
 * 「只有本模块 factory 能盖戳的受信 ActorContext」。
 *
 * 背景：红线#2「只人能放松/裁定」此前唯一的判据是 `isHumanRole(callerSuppliedString)` 纯前缀检查——任何调用方
 * 只要把 `by` 写成 `'human:whatever'` 就能冒充人，触发 red-edge 放松、draft→active 旁路、写 f1 人审、human 冲突裁定。
 * 它只能区分「自报 human 前缀 vs 自报 agent 前缀」，**无法区分真人 vs 冒充人的 agent**。
 *
 * 修法：`ActorContext` 带一个 `unique symbol` brand，business caller 无法手搓出带 brand 的对象；`isHuman` 只由本
 * 模块的两个 factory 依据「来源」设定——`trustedHumanActor` 永远 isHuman:true，`agentActor` 永远 isHuman:false
 * （即使把 role 字面量写成 `'human:fake'` 也不抬权）。授权门改读受信的 `actor.isHuman`，不再吃裸字符串。
 *
 * `role` 仍是人类可读的审计字符串（落库 by_role 字段不变）；它**只用于审计/留痕，绝不参与授权判定**——
 * 授权只看 `isHuman`。即「显示身份」与「是否为人」彻底解耦：前者可任写，后者由信任锚铁定。
 */

/** 角色串格式：`'human'` / `'human:<id>'` / `'agent:<id>'` / `'consumer:<id>'` 等，冒号分隔。空/全空白 → 拒。 */
function assertRole(role: string): void {
  if (typeof role !== 'string' || role.trim().length < 1) {
    throw new Error('actor: role must be a non-empty, non-whitespace string')
  }
}

/**
 * 信任戳：模块私有 symbol，**不导出**。business caller 拿不到它 ⇒ 无法构造带此 key 的对象 ⇒ 无法手搓出
 * 一个 structurally-compatible 的 ActorContext（更别说把 isHuman 设成 true）。是「人身份真实性」的根锚。
 */
const TRUSTED_BRAND: unique symbol = Symbol('engram.trustedActor')

/**
 * 受信调用方上下文。授权门**只读 `isHuman`**（受信、不可伪造）；`role` 仅作审计字符串（落库 by_role）。
 * 无法由 business caller 直接构造——必须经下面的 factory（factory 才能盖 `TRUSTED_BRAND` 戳）。
 */
export interface ActorContext {
  /** 审计用显示身份（'human:judge' / 'agent:patrol' / ...）。**不参与授权**，授权只看 isHuman。 */
  readonly role: string
  /** 是否为人。**唯一**的授权判据，只由 factory 依据来源设定，business caller 无法伪造。 */
  readonly isHuman: boolean
  /** 信任戳：只有本模块的 factory 能盖。外部拿不到这个 symbol ⇒ 拿不到能构造 ActorContext 的入口。 */
  readonly [TRUSTED_BRAND]: true
}

/**
 * 从受信来源（HITL 会话 / 服务端认证）构造一个**人** actor —— `isHuman` 恒为 true。
 * 调用本 factory 即代表调用点已在受信边界（编排器把住人会话），是建立「人身份真实性」的唯一合法入口。
 * `role` 仅作审计串（默认人审身份须以 'human' 开头以保持审计语义一致，但抬权与否只由本 factory 决定、不看串）。
 */
export function trustedHumanActor(role: string): ActorContext {
  assertRole(role)
  return { role, isHuman: true, [TRUSTED_BRAND]: true }
}

/**
 * 构造一个 **agent**（非人）actor —— `isHuman` 恒为 false，**即使 role 字面量被写成 `'human:fake'` 也不抬权**。
 * 这是收口的关键：agent 自由写 role 串只影响审计显示，绝不能让它通过任何人专属门。
 */
export function agentActor(role: string): ActorContext {
  assertRole(role)
  return { role, isHuman: false, [TRUSTED_BRAND]: true }
}
