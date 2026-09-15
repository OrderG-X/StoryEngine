import { z } from "zod";

import { resolveEntityLabel } from "../presence/entity-labels.js";
import { coerceStringArray } from "./lenient-args.js";

/**
 * 做厚工具的「单体定向」共享件 —— 让角色/资产/地点做厚支持「只补指名的这几个」，而非永远整批重做。
 *
 * 由来（设计 2026-06-25）：做厚原本是全量批处理，用户「补一个新角色」会把已手改过的全员 enrich 覆盖掉
 * （可撤销但要先发现，=默认会发生的数据损坏）。"补即直接厚"这条直路要求补谁就只补谁。落地=各做厚工具
 * inputSchema 摊进 `targetFields`、run 里先 `collect 全部` 再 `filterByEntityTarget`，命中为空时诚实回报。
 * 题材中立、纯确定性、不调 LLM；不传 target=补全部（向后兼容）。
 */
export const targetFields = {
  targetNames: coerceStringArray(z.array(z.string()).optional()).describe(
    "可选：只补全这几个（按名字）。用户刚补充/指名某个时必须填，避免整批重做覆盖已有做厚。省略=补全部。",
  ),
  targetIds: coerceStringArray(z.array(z.string()).optional()).describe(
    "可选：只补全这几个（按 id，比名字精确）；与 targetNames 任一命中即选中。省略=补全部。",
  ),
};

export interface EntityTarget {
  readonly ids: ReadonlySet<string>;
  readonly names: ReadonlySet<string>;
  /** 「没找到 X」提示用的人类可读标签（铁律④：绝不回显裸 char-/asset- 等引擎 id）。 */
  readonly labels: readonly string[];
}

/**
 * 把 targetNames/targetIds 整理成命中集合；都为空返回 undefined（=补全部）。
 *
 * P2 铁律④（绝不泄露裸 id）：labels 此前在「只给了 id」时直接回显 `[...ids]`——四个做厚工具的
 * 「没找到 X（…）」摘要会把 `char-1a2b3c` 这类引擎 slug 原样塞进给用户看的文本。现在统一过
 * resolveEntityLabel：id 能映射成名字就映射，映射不到的引擎 id 显示「未知角色」而非裸 id。
 * 匹配逻辑仍走 ids/names 集合，labels 只影响显示。
 */
export function parseEntityTarget(input: {
  readonly targetNames?: readonly string[] | undefined;
  readonly targetIds?: readonly string[] | undefined;
  /** id → 显示名映射（由调用方从 overview 角色矩阵提供）；缺省=只按名字回显 */
  readonly nameById?: ReadonlyMap<string, string> | undefined;
}): EntityTarget | undefined {
  const names = new Set((input.targetNames ?? []).map((s) => s.trim()).filter((s) => s.length > 0));
  const ids = new Set((input.targetIds ?? []).map((s) => s.trim()).filter((s) => s.length > 0));
  if (names.size === 0 && ids.size === 0) return undefined;
  const nameById = input.nameById ?? new Map<string, string>();
  // 优先用名字；只给了 id 时映射成名字，映射不到的引擎 id 归一成「未知角色」，绝不裸奔
  const labels = names.size > 0
    ? [...names]
    : [...ids].map((id) => resolveEntityLabel(id, nameById));
  return { ids, names, labels };
}

/** 按 target 过滤实体清单（实体含 name + 可选 id）；target 为空=原样返回。 */
export function filterByEntityTarget<T extends { readonly name?: string; readonly id?: string }>(
  entities: readonly T[],
  target: EntityTarget | undefined,
): readonly T[] {
  if (!target) return entities;
  return entities.filter(
    (e) => (e.id ? target.ids.has(e.id) : false) || (e.name ? target.names.has(e.name.trim()) : false),
  );
}
