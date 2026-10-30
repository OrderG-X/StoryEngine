/**
 * 服务端自己生成的「下一步」选项（确定性，不调模型）：按钮动作、操作收尾、定论收尾共用。
 * 带 action 的选项前端点了直接发 body.action，不经模型；新操作的选项出的时候就带好请求号和 issuedAt（写作版本 P2a：
 * 点几次都是同一次，重发沿用）。
 */
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { hasWorkingDraftText } from "../lib/working-draft-text.js";
import type { DraftChangeMode, DraftChangeParams } from "../services/draft-change/params.js";
import type { InspectMode } from "../services/inspect-service.js";
import { PLAN_PROPOSE_KIND, type PlanProposeParams } from "../services/operations/recipes/plan-propose.js";
import { SETTINGS_CHANGE_KIND } from "../services/operations/recipes/settings-change.js";
import { CANON_PROPOSE_KIND, type CanonCard, type CanonProposeInput } from "../services/operations/recipes/canon-propose.js";
import { COMMIT_PREPARE_KIND } from "../services/operations/recipes/commit-prepare.js";
import type { OperationAction, UserAction } from "./user-actions.js";

export interface NextStepChoice {
  readonly label: string;
  readonly intent: string;
  readonly recommended?: boolean;
  /**
   * 结构化动作（R4.7/验收 3.8）：带上它的选项，前端点击直接发 body.action 到 /api/agent/chat，
   * 不再发一句意图给模型（一次省 3～5 万输入）。只给**服务端自己生成**的确定性选项填
   * （定稿/再核一次/写下一章…）；模型 suggest_next_steps 生成的选项没有这个字段，照旧发文本。
   */
  readonly action?: UserAction;
}

/** 给用户看的收尾文本：模型的话里偶有工具名（「先 prepare_commit」），换成人话。 */
export function humanizeToolNames(text: string): string {
  return text.replace(/prepare_commit/gu, "定稿");
}

/**
 * 一次新操作的按钮动作：出的时候就给请求号和 issuedAt（服务端时钟），随选项存进消息；作者点几次都是这一次。
 */
export function newOperationAction(type: "inspect.run", mode: InspectMode, params: { readonly chapter: number; readonly fresh?: true }): OperationAction {
  return { kind: "new", type, mode, params, requestKey: randomUUID(), issuedAt: new Date().toISOString() };
}

/** 一次写稿的按钮动作（写这一章 / 重写 / 接着往下写 / 再写一次）：和 newOperationAction 一样出的时候就给号。 */
export function newDraftAction(mode: DraftChangeMode, params: DraftChangeParams): OperationAction {
  return { kind: "new", type: "draft.change", mode, params, requestKey: randomUUID(), issuedAt: new Date().toISOString() };
}

/** 想走法（「再想一次」）：和 newOperationAction 一样出的时候就给号。 */
export function newPlanAction(params: PlanProposeParams): OperationAction {
  return { kind: "new", type: PLAN_PROPOSE_KIND, params, requestKey: randomUUID(), issuedAt: new Date().toISOString() };
}

/** 「认下」：那次改设定里 AI 刚写进去的那几处算作者写的（新的一次操作，参数带那次的号）。 */
export function settingsAcceptAction(fromOpId: string): OperationAction {
  return { kind: "new", type: SETTINGS_CHANGE_KIND, params: { accept: fromOpId }, requestKey: randomUUID(), issuedAt: new Date().toISOString() };
}

/** 定论（「再查一次」）：和 newOperationAction 一样出的时候就给号。 */
export function newCanonAction(mode: "pick" | "statement", params: CanonProposeInput): OperationAction {
  return { kind: "new", type: CANON_PROPOSE_KIND, mode, params, requestKey: randomUUID(), issuedAt: new Date().toISOString() };
}

/** 「重新查」：按卡上那条定论再查一遍全书（核账报过、这次没查出改法的那几句点名带上）。 */
export function recheckCanonAction(card: CanonCard): OperationAction {
  const also = card.missed.map((item) => ({ where: "chapter" as const, chapter: item.chapter, quote: item.quote }));
  return newCanonAction("statement", { statement: card.canon, ...(card.chapter !== undefined ? { chapter: card.chapter } : {}), ...(also.length > 0 ? { also } : {}) });
}

/** 「定稿」：出这一章的定稿清单（记账员记账，作者在清单上点「确认定稿」才定）。 */
export function commitAction(chapter: number): OperationAction {
  return { kind: "new", type: COMMIT_PREPARE_KIND, params: { chapter }, requestKey: randomUUID(), issuedAt: new Date().toISOString() };
}

/** 下一步里的「定稿」。 */
export function commitChoice(chapter: number, options: { readonly label?: string; readonly recommended?: boolean } = {}): NextStepChoice {
  return { label: options.label ?? "定稿", intent: `定稿第 ${chapter} 章`, ...(options.recommended ? { recommended: true } : {}), action: commitAction(chapter) };
}

/** 「核账」「再核一遍」：交一次核账。fresh＝正文没改也重新核。 */
export function checkChapterAction(chapter: number, options: { readonly fresh?: boolean } = {}): OperationAction {
  return newOperationAction("inspect.run", "continuity", { chapter, ...(options.fresh ? { fresh: true as const } : {}) });
}

/**
 * 已定稿章号（只列 chapters/ 目录名，不读文件内容）。目录读不到（老书/异常）→ 空数组，调用方按旧口径 N+1 兜底。
 * 纯 readdir，一次目录扫描，代价可忽略。
 */
export async function readCommittedChapterNumbers(projectDir: string): Promise<readonly number[]> {
  const files = await readdir(join(projectDir, "chapters")).catch(() => [] as string[]);
  const numbers: number[] = [];
  for (const file of files) {
    const match = /^(\d{4})\.md$/u.exec(file);
    if (match?.[1]) {
      const chapter = Number(match[1]);
      if (Number.isInteger(chapter) && chapter > 0) numbers.push(chapter);
    }
  }
  return numbers;
}

/**
 * 写作前沿章（R7.7·报告 4.2）：第 N 章之后第一个还没定稿的章；N 之后全都定稿了就是 N+1（旧口径）。
 * 重新定稿旧章（比如回到第 3 章改，第 4、5 章早定稿了）后，旧代码推荐「写第 4 章」会把作者拽回
 * 早就写完的旧章——正确推荐是接着写没定稿的那章（第 6 章）。从 N+1 起找而不是从 1 起找：
 * 「第一个没定稿的章」常常正是手头这本草稿（核账/出稿都在未定稿章上做），不能推荐回去重写它。
 * 纯确定性计算（扫定稿文件名），不猜说法。
 */
export function nextDraftChapterAfter(chapter: number, committed: readonly number[]): number {
  const set = new Set(committed.filter((n) => Number.isInteger(n) && n > 0));
  let next = Math.max(1, Math.trunc(chapter)) + 1;
  while (set.has(next)) next += 1;
  return next;
}

/** 写作前沿章和它是不是已经有工作稿（「写下一章」选项用）。 */
export interface NextDraftTarget {
  readonly chapter: number;
  readonly hasDraft: boolean;
}

/**
 * 「写下一章」那个选项（确定性）：下一章还空着 → AI 写；已经有工作稿（回头重定了旧章，下一章正写到一半）→
 * 改成核那一章。不能顶着「AI 写」的名字把手头的稿子换掉（长篇连写 2026-10-24；写稿操作有稿的章不重写，点了也只出「重写」按钮）。
 */
export function writeNextChoice(target: NextDraftTarget, label: string = `AI 写第 ${target.chapter} 章`): NextStepChoice {
  return target.hasDraft
    ? { label: `核第 ${target.chapter} 章`, intent: `核第 ${target.chapter} 章的账`, action: checkChapterAction(target.chapter) }
    : { label, intent: `继续写第 ${target.chapter} 章的正文`, action: newDraftAction("write", { chapter: target.chapter }) };
}

/** 「接着往下写」那个选项（P13）：稿子短了，从最后一句接着写，已写的不动。 */
export function continueChoice(chapter: number): NextStepChoice {
  return { label: "接着往下写", intent: `第 ${chapter} 章接着往下写`, action: newDraftAction("continue", { chapter }) };
}

/** 写作前沿章（R7.7）：有书目录时按定稿文件现算；没传目录/读不到定稿章 → N+1 旧口径兜底。顺带看那章有没有工作稿。 */
export async function resolveNextDraftTarget(projectDir: string | undefined, chapter: number): Promise<NextDraftTarget> {
  if (!projectDir) return { chapter: chapter + 1, hasDraft: false };
  const committed = await readCommittedChapterNumbers(projectDir);
  const next = committed.length > 0 ? nextDraftChapterAfter(chapter, committed) : chapter + 1;
  return { chapter: next, hasDraft: await hasWorkingDraftText(projectDir, next).catch(() => false) };
}

/** 把下一步选项按工具结果的样子推给前端（suggest_next_steps 那张卡）。没有选项不推。 */
export function sendNextSteps(
  sendEvent: (event: string, data: unknown) => void,
  question: string,
  choices: readonly NextStepChoice[],
  stamp: number = Date.now(),
): void {
  if (choices.length === 0) return;
  const toolCallId = `user-action-next-${stamp}`;
  sendEvent("tool-call", { toolCallId, toolName: "suggest_next_steps", args: {} });
  sendEvent("tool-result", { toolCallId, toolName: "suggest_next_steps", output: { ok: true, question, choices } });
}
