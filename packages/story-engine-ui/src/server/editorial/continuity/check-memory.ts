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
import { writeFileAtomic } from "../../lib/project-io.js";
import type { ContinuityIssueV2, EarlierText } from "./check-chapter.js";

/** 查错逻辑有实质改动时加一，旧记忆作废（不再原样复用）。 */
export const CHECK_MEMORY_VERSION = 4;

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
 * 前文 + 账本 + 设定本（v3 起账本数字对账也算核账的输入：账本改了，上次的结果不能原样复用；
 * 设定本同理——核账有一遍专对设定本，作者改了设定再核，不能端出按旧设定核的结果，长篇连写 2026-10-24）。
 * 键尾固定拼 |engine:reader（R3 前新旧两路的记忆键不一样，防切换后互相复用；旧组合查错留下的记忆
 * 没带这个尾巴，自然对不上、会重新核一次——两路查出来的东西本来就不一样）。
 */
export function hashEarlier(earlier: EarlierText, ledger: readonly unknown[] = [], setting = ""): string {
  return sha([...earlier.chapters]
    .sort((a, b) => a.chapter - b.chapter)
    .map((item) => `${item.chapter}:${item.sentences.join("")}`)
    .join("\n")
    .replace(/\s+/gu, "") + (ledger.length > 0 ? `|ledger:${JSON.stringify(ledger)}` : "") + (setting ? `|setting:${setting}` : "") + "|engine:reader");
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
  await stat(projectDir); // 书已删就别再写（免得建出幽灵目录）
  const path = memoryPath(projectDir, memory.chapter);
  await mkdir(dirname(path), { recursive: true });
  const file: CheckMemory = { version: CHECK_MEMORY_VERSION, checkedAt: new Date().toISOString(), ...memory };
  await writeFileAtomic(path, `${JSON.stringify(file, null, 2)}\n`);
}

/**
 * 按核账改过的句子（改前 → 改后），每章一份：再核时核账员又说改后那句不对的，降成「可能」交作者定
 * （长篇连写 2026-10-24：倒计时第一遍核账说该减成八天、改了，第二遍又说同一天不该是八天——两遍说法相反，
 * 「改掉本章 N 处」就来回改）。存 .story-engine-ui/continuity-checks/NNNN.fixes.json，只留最近 FIX_LOG_MAX 条。
 */
export interface FixRecord {
  readonly from: string;
  readonly to: string;
}

const FIX_LOG_MAX = 50;

const fixLogPath = (projectDir: string, chapter: number): string =>
  join(projectDir, ".story-engine-ui", "continuity-checks", `${String(chapter).padStart(4, "0")}.fixes.json`);

export async function readFixLog(projectDir: string, chapter: number): Promise<readonly FixRecord[]> {
  try {
    const parsed = JSON.parse(await readFile(fixLogPath(projectDir, chapter), "utf-8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((record): record is FixRecord =>
      Boolean(record) && typeof record.from === "string" && typeof record.to === "string" && record.to.trim().length > 0);
  } catch {
    return [];
  }
}

export async function appendFixLog(projectDir: string, chapter: number, changes: readonly FixRecord[]): Promise<void> {
  const fresh = changes.filter((change) => change.to.trim().length > 0 && change.to !== change.from);
  if (fresh.length === 0) return;
  await stat(projectDir); // 书已删就别再写
  const path = fixLogPath(projectDir, chapter);
  await mkdir(dirname(path), { recursive: true });
  const log = [...(await readFixLog(projectDir, chapter)), ...fresh.map(({ from, to }) => ({ from, to }))].slice(-FIX_LOG_MAX);
  await writeFileAtomic(path, `${JSON.stringify(log, null, 2)}\n`);
}
