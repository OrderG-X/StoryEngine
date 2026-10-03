/**
 * commit preview token 存储（进程内）。
 *
 * commit_preview 生成预览计划时，把「项目 + 章节 + 当时草稿内容哈希」登记成一个 previewToken
 * 存进内存；commit_apply 入库前必须带上同章节、且草稿未变（同哈希）的有效 token，否则诚实拒绝
 * （守卫：必须先 commit_preview 过，且预览之后草稿没改动）。
 *
 * 【R3·2026-06-24 无状态重算】token = sha256(projectDir·chapter·draftHash) 是 (项目,章,草稿哈希)
 * 的纯函数，apply 时可按「当前磁盘草稿」重算期望 token 比对，不再必须依赖这张内存表：带对了当前草稿的
 * token = 预览过这版草稿且未改动。内存 store 仍登记、用于给更精确的失败原因（草稿改过 vs 没预览），
 * 但「record 蒸发」不再阻断入库——治「进程重启/HMR/换会话 token 失效」「跨回合 agent 捞历史死
 * token」「断流后草稿没变却因 token 被消费而入不了库」三连（审计 A8 / A5-P2#5）。
 */
import { createHash } from "node:crypto";
import type { ChapterDeltaDeclaration } from "@actalk/story-engine";
import type { ChapterDeltaDeclarationOutcome } from "../../services/commit-service.js";

export interface CommitPreviewTokenRecord {
  readonly token: string;
  readonly projectDir: string;
  readonly chapter: number;
  /** 预览时草稿内容的哈希——apply 时据此判定草稿是否在预览之后被改过。 */
  readonly draftHash: string;
  /** 预览时计划是否通过（passed=false 不会发 token，这里恒为 true，留作显式语义）。 */
  readonly passed: boolean;
  /**
   * 预览阶段算好的章节语义声明（ChapterDelta）。apply 阶段从这里取回复用、不重复调模型。
   * 缺失（模型未配置/抽取失败/进程重启后凭 token 无状态放行）→ apply 走引擎正则回退，等价老行为。
   */
  readonly declaration?: ChapterDeltaDeclaration;
  /** 预览阶段声明步骤的状态+原因（fallback 时 apply 要把「本章按确定性规则兜底」如实带给用户）。 */
  readonly declarationOutcome?: ChapterDeltaDeclarationOutcome;
  readonly createdAt: number;
}

/** key = `${projectDir}\n${chapter}`，同章节只保留最近一次预览。 */
const store = new Map<string, CommitPreviewTokenRecord>();

export function hashDraftContent(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

/** token 的纯函数定义：(项目, 章, 草稿哈希) → token。预览登记与 apply 校验同源，apply 据此可无状态重算。 */
export function expectedToken(projectDir: string, chapter: number, draftHash: string): string {
  return createHash("sha256")
    .update(`${projectDir}\n${chapter}\n${draftHash}`, "utf-8")
    .digest("hex");
}

function keyFor(projectDir: string, chapter: number): string {
  return `${projectDir}\n${chapter}`;
}

/** 登记一次成功的预览，返回 token。可携带预览阶段算好的 declaration 供 apply 复用。 */
export function recordCommitPreview(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly draftHash: string;
  readonly declaration?: ChapterDeltaDeclaration;
  readonly declarationOutcome?: ChapterDeltaDeclarationOutcome;
}): CommitPreviewTokenRecord {
  const token = expectedToken(input.projectDir, input.chapter, input.draftHash);
  const record: CommitPreviewTokenRecord = {
    token,
    projectDir: input.projectDir,
    chapter: input.chapter,
    draftHash: input.draftHash,
    passed: true,
    ...(input.declaration ? { declaration: input.declaration } : {}),
    ...(input.declarationOutcome ? { declarationOutcome: input.declarationOutcome } : {}),
    createdAt: Date.now(),
  };
  store.set(keyFor(input.projectDir, input.chapter), record);
  return record;
}

/** 读取同项目同章节最近一次成功预览；不存在表示当前进程内没有可接管的预览票据。 */
export function findCommitPreview(projectDir: string, chapter: number): CommitPreviewTokenRecord | undefined {
  return store.get(keyFor(projectDir, chapter));
}

export type CommitPreviewGuardFailure =
  | "no_preview"
  | "chapter_mismatch"
  | "token_mismatch"
  | "draft_changed_since_preview";

export interface CommitPreviewGuardResult {
  readonly ok: boolean;
  readonly failure?: CommitPreviewGuardFailure;
  readonly record?: CommitPreviewTokenRecord;
}

/**
 * 守卫：校验 apply 请求的 (projectDir, chapter, token, 当前草稿哈希) 是否匹配一次有效预览。
 * R3 无状态重算：带对了「当前草稿的期望 token」即放行（等价于预览过这版草稿且未改动），不依赖 store record。
 * store record 仍用于在失败时区分「草稿改过」与「没预览」，给更可执行的提示。
 * - 没预览过且 token 不对当前草稿 → no_preview
 * - token 与该章登记的 token 不符、且也不对当前草稿 → token_mismatch
 * - 当前草稿哈希 ≠ 预览时哈希 → draft_changed_since_preview（草稿改过，必须重新预览）
 */
export function verifyCommitPreview(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly token?: string;
  readonly currentDraftHash: string;
}): CommitPreviewGuardResult {
  const record = store.get(keyFor(input.projectDir, input.chapter));
  // R3：带对了当前草稿的 token = 预览过这版草稿且没改 → 放行（store 有无均可，治重启/跨回合/断流死 token）。
  const matchesCurrentDraft = input.token != null
    && input.token === expectedToken(input.projectDir, input.chapter, input.currentDraftHash);
  if (matchesCurrentDraft) return { ok: true, record };

  if (!record) return { ok: false, failure: "no_preview" };
  if (!input.token || input.token !== record.token) {
    return { ok: false, failure: "token_mismatch", record };
  }
  // token 与登记一致，但当前草稿哈希变了（matchesCurrentDraft 必为 false 才走到这）→ 草稿改过。
  if (input.currentDraftHash !== record.draftHash) {
    return { ok: false, failure: "draft_changed_since_preview", record };
  }
  // token 与登记一致且草稿未改：理论上 matchesCurrentDraft 应已为 true 并提前返回；兜底放行。
  return { ok: true, record };
}

/** 入库成功后清除该章节的预览 token（清 store record；R3 后重复入库防护改由 commit_apply 幂等探测兜底）。 */
export function consumeCommitPreview(projectDir: string, chapter: number): void {
  store.delete(keyFor(projectDir, chapter));
}

/** 测试用：清空全部 token。 */
export function __resetCommitPreviewStore(): void {
  store.clear();
}
