/**
 * 用户结构化动作（2026-10-07 拆补丁塔）：界面按钮（定稿清单「确认定稿」、建议条、卡上的按钮）发来的明确指令，
 * 服务端直接执行，不经模型判断——按钮点击本身就是授权，不再用正则去猜用户原话。
 *
 * 新操作、「接着做」「不要了」、等作者点的按钮都交给执行器（写作版本 P2a），事件协议与 agent 回合一致，收尾文本确定性生成，不调模型。
 */
import { isOperationId } from "../lib/operations/store.js";
import type { InspectMode } from "../services/inspect-service.js";
import { PLAN_PROPOSE_KIND, readPlanProposeParams, type PlanProposeParams } from "../services/operations/recipes/plan-propose.js";
import { SETTINGS_CHANGE_KIND } from "../services/operations/recipes/settings-change.js";
import { LEDGER_CHANGE_KIND, MAX_LEDGER_CHANGES } from "../services/operations/recipes/ledger-change.js";
import { readLedgerRequest, type LedgerChangeRequest } from "../services/ledger-change/plan.js";
import { CANON_PROPOSE_KIND, canonInputOf, readCanonProposeParams, type CanonProposeInput } from "../services/operations/recipes/canon-propose.js";
import { COMMIT_PREPARE_KIND, readCommitPrepareParams, type CommitPrepareParams } from "../services/operations/recipes/commit-prepare.js";
import { HISTORY_CHANGE_KIND, readHistoryChangeParams } from "../services/operations/recipes/history-change.js";
import {
  isCandidateDecisionKind,
  isDraftEditMode,
  readCandidateDecisionParams,
  readDraftChangeParams,
  readDraftEditParams,
  type CandidateDecisionKind,
  type CandidateDecisionParams,
  type DraftChangeMode,
  type DraftChangeParams,
  type DraftEditMode,
  type DraftEditParams,
} from "../services/draft-change/params.js";
import { runOperationAction } from "./operation-turn.js";

/**
 * 按钮交给执行器的（写作版本 P2a 契约第四节）：新操作（核账、审稿……）出按钮的时候就带好请求号和 issuedAt，点几次都是这一次；
 * 「接着做」「不要了」接着一次停着的操作。检查（inspect.run）、写稿和改稿（draft.change：写这一章 / 重写 / 接着往下写 /
 * 改这处 / 改掉这句 / 选中文字改写）、换上 / 不要 AI 稿（draft.adopt / draft.discard）、想走法（plan.propose）是操作，别的按钮随各自那一片迁过来。
 */
export type OperationAction =
  | {
    readonly kind: "new";
    readonly type: "inspect.run";
    readonly mode: InspectMode;
    readonly params: { readonly chapter: number; readonly fresh?: true };
    readonly requestKey: string;
    readonly issuedAt: string;
  }
  | {
    readonly kind: "new";
    readonly type: "draft.change";
    readonly mode: DraftChangeMode;
    readonly params: DraftChangeParams;
    readonly requestKey: string;
    readonly issuedAt: string;
  }
  /** 改稿（片 2C）：核账卡「改这处 / 改掉这 N 处」= fix、AI 味卡「改掉这句 / 一键全修」= deai、选中文字改写 = revise（先给作者看）。 */
  | {
    readonly kind: "new";
    readonly type: "draft.change";
    readonly mode: DraftEditMode;
    readonly params: DraftEditParams;
    readonly requestKey: string;
    readonly issuedAt: string;
  }
  /** 作者挑的 AI 稿（片 2D）：稿纸提示条「换成 AI 这版 / 不要了」、「另外几版」卡「用这版」。 */
  | {
    readonly kind: "new";
    readonly type: CandidateDecisionKind;
    readonly params: CandidateDecisionParams;
    readonly requestKey: string;
    readonly issuedAt: string;
  }
  /** 想走法（片 2D）：稿纸上方「给我几种走法」「再来几种」。idea = 作者填的想法原话；avoid = 已经给过的走法名字。 */
  | {
    readonly kind: "new";
    readonly type: typeof PLAN_PROPOSE_KIND;
    readonly params: PlanProposeParams;
    readonly requestKey: string;
    readonly issuedAt: string;
  }
  /** 「认下」（片 3）：那次改设定里 AI 刚写进去的那几处算作者写的。accept = 那次改设定的操作号。 */
  | {
    readonly kind: "new";
    readonly type: typeof SETTINGS_CHANGE_KIND;
    readonly params: { readonly accept: string };
    readonly requestKey: string;
    readonly issuedAt: string;
  }
  /** 作者在线索板 / 梗概上直接改账（片 3）：这几笔不再问，直接记（作者档、存档、可撤销）。 */
  | {
    readonly kind: "new";
    readonly type: typeof LEDGER_CHANGE_KIND;
    readonly mode: "author";
    readonly params: { readonly changes: readonly LedgerChangeRequest[] };
    readonly requestKey: string;
    readonly issuedAt: string;
  }
  /** 核账卡「以第 N 章为准 / 以本章为准 / 以设定为准 / 以定论为准」、设定本「查前文」、定论卡「重新查」：查全书出定论卡。 */
  | {
    readonly kind: "new";
    readonly type: typeof CANON_PROPOSE_KIND;
    readonly mode: "pick" | "statement";
    readonly params: CanonProposeInput;
    readonly requestKey: string;
    readonly issuedAt: string;
  }
  /** 「定稿」「就这么短，照样定稿」：出这一章的定稿清单（allowShort 只认按钮）。 */
  | {
    readonly kind: "new";
    readonly type: typeof COMMIT_PREPARE_KIND;
    readonly params: CommitPrepareParams;
    readonly requestKey: string;
    readonly issuedAt: string;
  }
  /** 「撤销上一步」= 撤最近一次还没撤的改动；「撤回来」「撤销这次定稿」带着那次操作的号（片 4C）。 */
  | {
    readonly kind: "new";
    readonly type: typeof HISTORY_CHANGE_KIND;
    readonly mode: "undo";
    readonly params: { readonly opId?: string };
    readonly requestKey: string;
    readonly issuedAt: string;
  }
  /** 「撤销到此」：整本恢复到那个存档（操作历史里的「恢复」走 HTTP，也是这一种）。 */
  | {
    readonly kind: "new";
    readonly type: typeof HISTORY_CHANGE_KIND;
    readonly mode: "restore";
    readonly params: { readonly snapshot: string };
    readonly requestKey: string;
    readonly issuedAt: string;
  }
  /** 「接着做」；等作者点按钮的（「换上 / 再改一版」「确认改设定」「确认改账」「确认定稿」）带上是哪个按钮、点的哪个、划掉了哪几处、填的几栏。 */
  | {
    readonly kind: "resume";
    readonly opId: string;
    /** 填的几栏（定稿清单上作者改的天数）：只收形状对的，是不是卡上有的、在不在范围里由执行器对着待办核。 */
    readonly answer?: { readonly actionId: string; readonly decision: string; readonly excluded?: readonly string[]; readonly values?: Readonly<Record<string, number>> };
  }
  | { readonly kind: "cancel"; readonly opId: string };

export type UserAction = OperationAction;

/** 清单一次最多划掉多少处（防异常请求体）。 */
const MAX_EXCLUDED = 500;
/** 按钮一次最多填几栏。 */
const MAX_VALUES = 8;

/** body.action 解析：缺省 → none（普通对话）；形状不对 → invalid（路由回 400，绝不静默当普通对话）。 */
export type ParsedUserAction =
  | { readonly kind: "none" }
  | { readonly kind: "invalid"; readonly reason: string }
  | { readonly kind: "action"; readonly action: UserAction };

const INSPECT_MODES: readonly InspectMode[] = ["continuity", "quality", "review", "flavor"];
const MAX_DRAFT_DIRECTION = 2000;

/** 按钮带的请求号：出按钮时给的 UUID（字母数字和 `-_`，1～64 位）。 */
function readRequestKey(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(value) ? value : undefined;
}

/** 按钮交给执行器的动作（新操作 / 接着做 / 不要了）：形状不对一律 invalid，不当普通对话。 */
function parseOperationAction(record: Record<string, unknown>): ParsedUserAction {
  if (record.kind === "resume" || record.kind === "cancel") {
    const opId = typeof record.opId === "string" ? record.opId.trim() : "";
    if (!isOperationId(opId)) return { kind: "invalid", reason: "这次操作的号不对。" };
    if (record.kind === "resume" && record.answer !== undefined) {
      const answer = typeof record.answer === "object" && record.answer !== null ? record.answer as Record<string, unknown> : {};
      const actionId = typeof answer.actionId === "string" && /^[A-Za-z0-9:_-]{1,64}$/u.test(answer.actionId) ? answer.actionId : undefined;
      const decision = typeof answer.decision === "string" && /^[A-Za-z0-9_-]{1,32}$/u.test(answer.decision) ? answer.decision : undefined;
      if (!actionId || !decision) return { kind: "invalid", reason: "这个按钮缺了标记，请刷新后再点。" };
      // 划掉的几处（定论卡上每句的键）：只收形状对的，是不是卡上有的由执行器对着待办核。
      const excluded = answer.excluded === undefined ? [] : Array.isArray(answer.excluded) ? answer.excluded : undefined;
      if (!excluded || excluded.length > MAX_EXCLUDED || excluded.some((key) => typeof key !== "string" || !/^[A-Za-z0-9:_-]{1,40}$/u.test(key))) {
        return { kind: "invalid", reason: "划掉的那几处不对，请刷新后再点。" };
      }
      const rawValues = answer.values === undefined ? {} : typeof answer.values === "object" && answer.values !== null && !Array.isArray(answer.values) ? answer.values as Record<string, unknown> : undefined;
      const valueEntries = rawValues ? Object.entries(rawValues) : undefined;
      if (!valueEntries || valueEntries.length > MAX_VALUES || valueEntries.some(([key, value]) => !/^[A-Za-z0-9_]{1,32}$/u.test(key) || typeof value !== "number" || !Number.isInteger(value))) {
        return { kind: "invalid", reason: "填的数不对，请刷新后再点。" };
      }
      const values = Object.fromEntries(valueEntries) as Record<string, number>;
      return {
        kind: "action",
        action: {
          kind: "resume",
          opId,
          answer: { actionId, decision, ...(excluded.length > 0 ? { excluded: excluded as string[] } : {}), ...(valueEntries.length > 0 ? { values } : {}) },
        },
      };
    }
    return { kind: "action", action: { kind: record.kind, opId } };
  }
  if (record.kind !== "new") return { kind: "invalid", reason: "不支持的操作。" };
  if (record.type !== "inspect.run" && record.type !== "draft.change" && record.type !== PLAN_PROPOSE_KIND && record.type !== SETTINGS_CHANGE_KIND && record.type !== LEDGER_CHANGE_KIND && record.type !== CANON_PROPOSE_KIND && record.type !== COMMIT_PREPARE_KIND && record.type !== HISTORY_CHANGE_KIND && !isCandidateDecisionKind(record.type)) {
    return { kind: "invalid", reason: "不支持的操作。" };
  }
  const params = typeof record.params === "object" && record.params !== null && !Array.isArray(record.params) ? record.params as Record<string, unknown> : {};
  const requestKey = readRequestKey(record.requestKey);
  const issuedAt = typeof record.issuedAt === "string" && record.issuedAt.length <= 40 && Number.isFinite(Date.parse(record.issuedAt)) ? record.issuedAt : undefined;
  if (!requestKey || !issuedAt) return { kind: "invalid", reason: "这个按钮缺了标记，请刷新后再点。" };
  const stamp = { requestKey, issuedAt: new Date(Date.parse(issuedAt)).toISOString() };
  if (record.type === SETTINGS_CHANGE_KIND) {
    // 按钮只有「认下」这一种（改设定本身是对话 AI 交的；作者自己改走设定本）。
    const accept = typeof params.accept === "string" && isOperationId(params.accept) ? params.accept : undefined;
    if (!accept) return { kind: "invalid", reason: "这个按钮缺了标记，请刷新后再点。" };
    return { kind: "action", action: { kind: "new", type: SETTINGS_CHANGE_KIND, params: { accept }, ...stamp } };
  }
  if (record.type === LEDGER_CHANGE_KIND) {
    // 按钮只有作者直接改这一种（对话 AI 提的改账停着等「确认改账」，点的是 resume）。
    const items = Array.isArray(params.changes) ? params.changes : [];
    const changes = items.map(readLedgerRequest);
    if (record.mode !== "author" || items.length === 0 || items.length > MAX_LEDGER_CHANGES || changes.some((item) => item === undefined)) {
      return { kind: "invalid", reason: "改账内容不对，请刷新后再点。" };
    }
    return { kind: "action", action: { kind: "new", type: LEDGER_CHANGE_KIND, mode: "author", params: { changes: changes as LedgerChangeRequest[] }, ...stamp } };
  }
  if (record.type === CANON_PROPOSE_KIND) {
    const canon = readCanonProposeParams("button", params, typeof record.mode === "string" ? record.mode : undefined);
    if ("invalid" in canon) return { kind: "invalid", reason: canon.invalid };
    return { kind: "action", action: { kind: "new", type: CANON_PROPOSE_KIND, mode: canon.mode, params: canonInputOf(canon), ...stamp } };
  }
  if (record.type === COMMIT_PREPARE_KIND) {
    const commit = readCommitPrepareParams("button", params);
    if ("invalid" in commit) return { kind: "invalid", reason: "缺少有效章号。" };
    return { kind: "action", action: { kind: "new", type: COMMIT_PREPARE_KIND, params: commit, ...stamp } };
  }
  if (record.type === HISTORY_CHANGE_KIND) {
    // 按钮只有撤销和整本恢复（裁剪是对话里交的，停着等「确认裁剪」，点的是 resume）。
    const mode = record.mode === "undo" || record.mode === "restore" ? record.mode : undefined;
    const history = mode ? readHistoryChangeParams("button", params, mode) : { invalid: "不支持的操作。" };
    if ("invalid" in history) return { kind: "invalid", reason: history.invalid };
    if (history.mode === "undo") {
      return { kind: "action", action: { kind: "new", type: HISTORY_CHANGE_KIND, mode: "undo", params: history.target ? { opId: history.target.opId } : {}, ...stamp } };
    }
    if (history.mode === "restore") {
      return { kind: "action", action: { kind: "new", type: HISTORY_CHANGE_KIND, mode: "restore", params: { snapshot: history.snapshot }, ...stamp } };
    }
    return { kind: "invalid", reason: "不支持的操作。" };
  }
  const chapter = params.chapter;
  if (typeof chapter !== "number" || !Number.isInteger(chapter) || chapter <= 0) return { kind: "invalid", reason: "缺少有效章号。" };
  if (isCandidateDecisionKind(record.type)) {
    const decision = readCandidateDecisionParams(record.type, params);
    if (!decision) return { kind: "invalid", reason: "这个按钮缺了标记，请刷新后再点。" };
    return { kind: "action", action: { kind: "new", type: record.type, params: decision, ...stamp } };
  }
  if (record.type === PLAN_PROPOSE_KIND) {
    const plan = readPlanProposeParams(params);
    if (!plan) return { kind: "invalid", reason: "缺少有效章号。" };
    return { kind: "action", action: { kind: "new", type: PLAN_PROPOSE_KIND, params: plan, ...stamp } };
  }
  if (record.type === "draft.change" && isDraftEditMode(record.mode)) {
    const edit = readDraftEditParams(record.mode, params);
    if (!edit) return { kind: "invalid", reason: "要改的地方不对。" };
    return { kind: "action", action: { kind: "new", type: "draft.change", mode: edit.mode, params: edit, ...stamp } };
  }
  if (record.type === "draft.change") {
    // 方向是作者在稿纸上挑的走法、按钮带来的原话：太长的截到 2000 字（和原来「写这一章」按钮同一口径）。
    const direction = typeof params.direction === "string" ? params.direction.trim().slice(0, MAX_DRAFT_DIRECTION) : undefined;
    const read = readDraftChangeParams(record.mode, { ...params, ...(direction !== undefined ? { direction } : {}) });
    if (!read) return { kind: "invalid", reason: "不认识要怎么写这一章。" };
    return { kind: "action", action: { kind: "new", type: "draft.change", mode: read.mode, params: read.params, ...stamp } };
  }
  const mode = record.mode as InspectMode;
  if (!INSPECT_MODES.includes(mode)) return { kind: "invalid", reason: "不认识要做哪种检查。" };
  return {
    kind: "action",
    action: {
      kind: "new",
      type: "inspect.run",
      mode,
      params: { chapter, ...(mode === "continuity" && params.fresh === true ? { fresh: true as const } : {}) },
      ...stamp,
    },
  };
}

export function parseUserAction(raw: unknown): ParsedUserAction {
  if (raw === undefined || raw === null) return { kind: "none" };
  if (typeof raw !== "object" || Array.isArray(raw)) return { kind: "invalid", reason: "动作格式不对。" };
  return parseOperationAction(raw as Record<string, unknown>);
}

/** 执行一次用户结构化动作：交给执行器，按 agent 回合同款事件推给前端。 */
export async function runUserAction(args: {
  readonly action: UserAction;
  readonly sendEvent: (event: string, data: unknown) => void;
  readonly scrubber: { push(text: string): string; flush(): string };
  /** 书目录（交给执行器的操作要它）。 */
  readonly projectDir?: string;
  /** 作者断开了（关页、网断）：交给执行器的操作照跑，只是不再转发。 */
  readonly signal?: AbortSignal;
}): Promise<void> {
  if (!args.projectDir) {
    const scrubbed = args.scrubber.push("没有打开的书，这一步没做。");
    if (scrubbed) args.sendEvent("text-delta", { text: scrubbed });
    return;
  }
  await runOperationAction({
    action: args.action,
    projectDir: args.projectDir,
    sendEvent: args.sendEvent,
    scrubber: args.scrubber,
    signal: args.signal ?? new AbortController().signal,
  });
}
