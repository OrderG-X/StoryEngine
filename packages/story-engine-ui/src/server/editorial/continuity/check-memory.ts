/**
 * 核账记忆（2026-10-10「让核账结果稳下来」）：每章记住上一次核账的结果。
 *
 * 模型每次核出来的不一样（考卷：同一章跑两次，「确定」的只有约三成重合），作者连点两次看到两套结果就不信了。
 * 所以：
 *  - 这一章和前文都没改过 → 直接给上次的结果，不调模型（同样的输入永远同样的输出，也省 token）；
 *  - 改过了 → 重新核，同时把上次报过、两边原句都还在的问题带上一起复核：没改掉的问题不会凭运气消失，
 *    改掉的（原句没了）自然不再报。
 * 存 .story-engine-ui/continuity-checks/NNNN.json（作者的查错记录，不是故事资料，不进账本、不进快照）。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeBookCache } from "../../lib/operations/fence.js";
import { writeFileAtomic } from "../../lib/project-io.js";
import { basisDigestBefore, type TruthBasis } from "@actalk/story-core";
import type { ContinuityIssueV2 } from "./check-chapter.js";

/** 查错逻辑有实质改动时加一，旧记忆作废（不再原样复用）。v6：前文指纹改用真相依据。 */
export const CHECK_MEMORY_VERSION = 6;

export interface CheckMemory {
  readonly version: number;
  readonly chapter: number;
  /** 本章正文的哈希。 */
  readonly bodyHash: string;
  /** 本章正文（v4 起）：两句都在本章的问题，要比两句中间那段改没改。 */
  readonly body: string;
  /** 前文（参与核对的各章原文）的哈希。 */
  readonly earlierHash: string;
  readonly checkedAt: string;
  readonly issues: readonly ContinuityIssueV2[];
}

const memoryPath = (projectDir: string, chapter: number): string =>
  join(projectDir, ".story-engine-ui", "continuity-checks", `${String(chapter).padStart(4, "0")}.json`);

const sha = (text: string): string => createHash("sha256").update(text, "utf-8").digest("hex").slice(0, 24);

export function hashBody(body: string): string {
  return sha(body.replace(/\s+/gu, ""));
}

/**
 * 前文指纹（v6 起，写作版本 P1a）：真相依据里本章之前的正文、全书的账、作者裁定、设定卡（basisDigestBefore），
 * 一个字节变了就不复用——前文、账本、设定、裁定哪样改了，上次的结果都不能原样端出来。
 * 核账实际吃的几样派生材料也照旧拼进来（账本数字、设定摘要、时间线）：本章没定稿时它的天数来自章纲（不在真相里），
 * 核账员照表判「昨天 / 前天」；没搬上核心的老书，设定和账还在老文件里。
 * 调用方要先读依据、再读核账的材料：中间有写，记下的指纹旧、下次自然重核，不会把新材料的结果挂在旧指纹上。
 */
export function hashEarlier(
  basis: TruthBasis,
  chapter: number,
  derived: { readonly ledger?: readonly unknown[]; readonly setting?: string; readonly timeline?: string } = {},
): string {
  const ledger = derived.ledger && derived.ledger.length > 0 ? `|ledger:${JSON.stringify(derived.ledger)}` : "";
  const setting = derived.setting ? `|setting:${derived.setting}` : "";
  const timeline = derived.timeline ? `|timeline:${derived.timeline}` : "";
  return sha(`${basisDigestBefore(basis, chapter, { laterLedgers: true })}${ledger}${setting}${timeline}|engine:reader`);
}

export async function readCheckMemory(projectDir: string, chapter: number): Promise<CheckMemory | undefined> {
  try {
    const parsed = JSON.parse(await readFile(memoryPath(projectDir, chapter), "utf-8")) as Partial<CheckMemory>;
    if (parsed.chapter !== chapter || typeof parsed.bodyHash !== "string" || typeof parsed.body !== "string" || typeof parsed.earlierHash !== "string" || !Array.isArray(parsed.issues)) {
      return undefined;
    }
    const issues = parsed.issues.filter((issue): issue is ContinuityIssueV2 =>
      Boolean(issue) && typeof issue.quote === "string" && typeof issue.earlierQuote === "string" && Number.isInteger(issue.earlierChapter));
    return {
      version: typeof parsed.version === "number" ? parsed.version : 0,
      chapter,
      bodyHash: parsed.bodyHash,
      body: parsed.body,
      earlierHash: parsed.earlierHash,
      checkedAt: typeof parsed.checkedAt === "string" ? parsed.checkedAt : "",
      issues,
    };
  } catch {
    // 没核过 / 文件坏了 → 当没有（坏了最多是重新核一次）
    return undefined;
  }
}

export async function writeCheckMemory(projectDir: string, memory: Omit<CheckMemory, "version" | "checkedAt">): Promise<void> {
  const path = memoryPath(projectDir, memory.chapter);
  const file: CheckMemory = { version: CHECK_MEMORY_VERSION, checkedAt: new Date().toISOString(), ...memory };
  await writeBookCache(projectDir, async () => {
    await mkdir(dirname(path), { recursive: true });
    await writeFileAtomic(path, `${JSON.stringify(file, null, 2)}\n`);
  });
}
