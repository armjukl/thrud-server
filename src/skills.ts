// 技能升级原语 (养成 1004/1008/1016 共用). 只改存档, 编包与推送交 payloads.ts 的 handler.
//
// 三条通道的上限口径各不相同, 是最容易配错的地方:
//   主动/极奏 (SkillValue_Xls)  -> LeaderBreak_Xls[本突].skillLevel 卡按钮, Skill_Xls.maxLevel 卡总上限
//   被动/普攻 (TalentSkill_Xls)  -> 同上
//   式杖      (TalentSkill_Xls)  -> 该 skillId 在 TalentSkill 里的最大 skillLevel
// 式杖**绝不能**读 Skill_Xls.maxLevel: 它对式杖技能恒为 1, 每个技能都会被判成满级而拒绝升级.
import type { SaveCharacter, SaveData } from "./save.js";
import { all, num } from "./tbl.js";
import { checkConsume, payConsume, type Effects } from "./econ.js";

export type SkillKind = "active" | "talent" | "stick";

const store = (c: SaveCharacter, kind: SkillKind): Record<string, number> =>
  kind === "active" ? c.activeLv : kind === "talent" ? c.talentLv : c.stickLv;

/** 存档里的等级; 没登记按 1 级 (客户端 HeroData 同口径). */
export function skillLv(c: SaveCharacter, sid: number, kind: SkillKind): number {
  return Math.floor(Number(store(c, kind)[String(sid)]) || 1);
}

export function setSkillLv(c: SaveCharacter, sid: number, kind: SkillKind, lv: number): void {
  store(c, kind)[String(sid)] = lv;
}

const num0 = (o: Record<string, unknown>, k: string): number => {
  const n = Number(o[k]);
  return Number.isFinite(n) ? n : 0;
};

/**
 * "某级技能"的配置行 (路 B skillRow:2803). 主动走 SkillValue_Xls, 被动/式杖走 TalentSkill_Xls,
 * 都是按 (skillId, skillLevel) 找第一条 —— 与客户端 GetActiveSkillConfigByLv 同口径.
 */
export function skillRow(sid: number, lv: number, kind: SkillKind): Record<string, unknown> | undefined {
  const table = kind === "active" ? "SkillValue" : "TalentSkill";
  return all(table).find(
    (r) => num0(r, "skillId") === sid && (num0(r, "skillLevel") || 0) === lv,
  ) as Record<string, unknown> | undefined;
}

/** 本突允许的主动技能等级上限 (路 B skillBreakCap:2816); 无本突行返回 0 = 不封顶. */
export function skillBreakCap(leaderId: number, breach: number): number {
  let cap = 0;
  for (const r of all("LeaderBreak")) {
    if (num0(r, "leaderId") === leaderId && (num0(r, "breakNum") || 0) === (breach || 0)) cap = num0(r, "skillLevel");
  }
  return cap;
}

/** 式杖技能上限 = TalentSkill_Xls 里该 skillId 的最大 skillLevel (路 B :4082). */
export function stickMaxLv(sid: number): number {
  let mx = 1;
  for (const r of all("TalentSkill")) {
    if (num0(r, "skillId") === sid) mx = Math.max(mx, num0(r, "skillLevel"));
  }
  return mx;
}

/** 升到下一级要扣的消耗行 id; 0 = 该级没有配置 (满级/断档). */
export function skillConsumeId(sid: number, lv: number, kind: SkillKind): number {
  const r = skillRow(sid, lv, kind);
  return r ? num0(r, "consumeId") : 0;
}

/**
 * 技能 +1 级 (路 B upgradeSkill:4011). 返回 [是否升级成功, 失败原因].
 * 失败**不扣费也不回包**: 客户端对 UpgradeLeaderTalentSkill_S2C 是无条件弹 UIHeroLevelUp,
 * 回一个等级没变的包就是弹假升级窗.
 */
export function upgradeSkill(s: SaveData, c: SaveCharacter, sid: number, kind: SkillKind, eff: Effects): [boolean, string] {
  if (!sid) return [false, "no-skillId"];
  const cur = skillLv(c, sid, kind);

  if (kind === "stick") {
    // 式杖的升级材料在 TalentSkill 里确有 consumeId, 但路 B 实测"不扣也不影响能升级",
    // 而 LeaderWandSkill 的 8200xxx 是获取途径/跳转 id 不是价格 —— 无从坐实, 先不拒绝.
    const max = stickMaxLv(sid);
    if (cur >= max) return [false, `stickMax ${sid} ${cur}/${max}`];
    setSkillLv(c, sid, kind, cur + 1);
    return [true, ""];
  }

  const r = skillRow(sid, cur, kind);
  if (!r) return [false, `skillRow? ${sid} lv${cur}`];
  let cap = skillBreakCap(c.id, c.breach) || 10;
  if (cur >= cap) return [false, `breakCap ${sid} ${cur}<${cap}`];
  const total = num("Skill", sid, "maxLevel", 0);
  if (total > 0 && cur >= total) cap = total;
  if (cur >= cap) return [false, `maxLevel ${sid} ${cur}`];

  const cid = num0(r, "consumeId");
  if (cid) {
    const [ok, why] = checkConsume(s, cid);
    if (!ok) return [false, `cost ${why}`];
    payConsume(s, cid, eff);
  }
  setSkillLv(c, sid, kind, cur + 1);
  return [true, ""];
}
