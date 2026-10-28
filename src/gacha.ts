// 抽卡按池真实掉落 roll: 复刻客户端 LotteryInstance_Xls -> Drop_Xls -> DropSet_Xls -> DropGroup_Xls 树.
// 表来自客户端 Lua (src/data/{lottery,drop,dropset,dropgroup}.ts).
//   Drop 行: layers[]/targetId[]/numMin[]/numMax[]/probability[]; layer 1=道具 2=DropGroup 3=DropSet.
//   DropSet 行: dropGroupId[]/weight[]  (按 weight 选一个组)
//   DropGroup 行: layers[]/targetId[]/numMin[]/numMax[]/weight[]  (递归)
import { LOTTERY } from "./data/lottery.js";
import { DROP } from "./data/drop.js";
import { DROPSET } from "./data/dropset.js";
import { DROPGROUP } from "./data/dropgroup.js";

export interface DrawResult {
  itemId: number;
  num: number;
}

// 真实掉落链最深约 11 层, 客户端无递归上限; 这里给足余量避免误判为环而回 null.
const MAX_DEPTH = 32;

function pickIdx(weights: number[]): number {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  let r = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r < 0) return i;
  }
  return weights.length - 1;
}

function randInt(a: number, b: number): number {
  const lo = Math.min(a, b), hi = Math.max(a, b);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function resolve(layer: number, target: number, num: number, depth: number): DrawResult | null {
  if (layer === 2) return rollGroup(target, num, depth + 1);
  if (layer === 3) return rollSet(target, depth + 1);
  return { itemId: target, num };
}

function rollSet(setId: number, depth: number): DrawResult | null {
  if (depth > MAX_DEPTH) return null;
  const s = DROPSET[setId];
  if (!s) return null;
  const [groups, w] = s;
  const i = pickIdx(w.length ? w : groups.map(() => 1));
  return rollGroup(groups[i] ?? 0, 1, depth + 1);
}

function rollGroup(groupId: number, num: number, depth: number): DrawResult | null {
  if (depth > MAX_DEPTH) return null;
  const g = DROPGROUP[groupId];
  if (!g) return null;
  const [layers, targets, nmin, nmax, w] = g;
  const i = pickIdx(w.length ? w : layers.map(() => 1));
  const layer = layers[i] ?? 1;
  const target = targets[i] ?? 0;
  const n = num || randInt(nmin[i] ?? 1, nmax[i] ?? 1);
  return resolve(layer, target, n, depth + 1);
}

function rollDrop(dropId: number, depth: number): DrawResult | null {
  if (depth > MAX_DEPTH) return null;
  const d = DROP[dropId];
  if (!d) return null;
  const [layers, targets, nmin, nmax, prob] = d;
  const i = pickIdx(prob.length ? prob : layers.map(() => 1));
  const layer = layers[i] ?? 1;
  const target = targets[i] ?? 0;
  const num = randInt(nmin[i] ?? 1, nmax[i] ?? 1);
  return resolve(layer, target, num, depth);
}

/** 按卡池 roll 一次掉落 (真实归属该池). */
export function poolDraw(poolId: number): DrawResult | null {
  const p = LOTTERY[poolId];
  if (!p) return null;
  const dropOrSet = p[0] || p[1]; // cardBoxGroup[1] (Drop id) 或 cardDropSetId
  return rollDrop(dropOrSet, 0);
}

/** 单次 roll 一个 Drop 行 (奖励列直接指 Drop 的那些关/挂机用). */
export function dropRoll(dropId: number): DrawResult | null {
  return rollDrop(dropId, 0);
}

/**
 * "必掉全部"口径 (路 B rollDropAll): 只有当这一行**每一条**都是 `layer=1 且 probability>=10000`
 * 时才整批发; 只要有一条是子树(DropSet/DropGroup)或权重不满, 它本质是"多选一"的池,
 * 退回 roll 一次 —— 否则会把 9000/1000 这种权重行当成双倍必掉.
 */
export function dropAll(dropId: number): DrawResult[] | null {
  const d = DROP[dropId];
  if (d) {
    const [layers, targets, nmin, nmax, prob] = d;
    let nAll = 0;
    let nFull = 0;
    const out: DrawResult[] = [];
    for (let i = 0; i < targets.length; i++) {
      const tid = targets[i] ?? 0;
      const w = prob[i] ?? 0;
      if (tid > 0 && w > 0) {
        nAll++;
        if ((layers[i] ?? 0) === 1 && w >= 10000) {
          nFull++;
          out.push({ itemId: tid, num: randInt(nmin[i] ?? 1, nmax[i] ?? nmin[i] ?? 1) });
        }
      }
    }
    if (nAll > 0 && nFull === nAll) return out;
  }
  const one = rollDrop(dropId, 0);
  return one ? [one] : null;
}

/** 池信息 (无则 null): [g1,cardDropSetId,swearType,itemId,itemNum,itemNum1,b1,b2,bottomGroup,bottomGroup2,cardBoxNumber]. */
export function poolInfo(poolId: number): readonly [number, number, number, number, number, number, number, number, number, number, number] | null {
  return LOTTERY[poolId] ?? null;
}
