/**
 * 受信调用者身份（HITL 授权边界）—— 实时 HITL 权威门只认 `isHuman` 布尔，不再正则裸 role 串。
 *
 * 背景（EGR-CR-002）：7 个实时门曾各自 `isHumanRole(裸字符串)`，而那些字符串是 caller 在调用时**新传入**的实时
 * 授权入参（非历史落库的既成 by_role 事实），上游无受信校验。任何 caller 传 `'human:fake'` 即可冒充人放松/晋升/
 * 迁移/裁决/写人审。把授权判据从「正则匹配 role 串」改成「读 isHuman 布尔」——`agentActor` 即便 role 传
 * `'human:fake'` 也 `isHuman:false`，门据此拒；只有受信代码路径（editor inbox / 人审 UI 后端等）才用
 * `trustedHumanActor` 构造 `isHuman:true`。role 仍是 `human:<id>` / `agent:<id>` 形态，**只用于落库审计**。
 */

/** 实时 HITL 门的调用者身份。授权只看 isHuman；role 仅落库审计（by_role）。 */
export interface ActorContext {
  /** 是否为受信的人类调用者。门的授权判据**只读此布尔**（不再正则 role 串）。 */
  isHuman: boolean
  /** 落库审计身份（`human:<id>` / `agent:<id>`），写进 by_role / confirmedBy / decidedBy 等审计字段。 */
  role: string
}

/**
 * 受信的人类调用者：`isHuman:true`。**仅受信代码路径**可构造（editor inbox / 人审 UI 后端等已确认请求来自人的入口）。
 * role 落库审计用，须是 `human:<id>` 形态。
 */
export function trustedHumanActor(role: string): ActorContext {
  return { isHuman: true, role }
}

/**
 * 非受信 / agent 调用者：`isHuman:false`。**即便 role 传 `'human:fake'` 也 `isHuman:false`** —— 这是关键：
 * 授权只认布尔，role 串伪装成人也越不过门。role 落库审计用。
 */
export function agentActor(role: string): ActorContext {
  return { isHuman: false, role }
}
