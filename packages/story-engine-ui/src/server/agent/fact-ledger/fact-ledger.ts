/**
 * fact-ledger —— 硬事实账本：抽取提示词/解析 + 读写 story/fact-ledger.json + 编排 + 改账本。
 * 纯逻辑、callModel 注入便于单测。题材中立、绝不静默失败（抽取失败非致命、如实回报）。
 */
import { mkdir, readFile, stat } from "node:fs/promises";
import { writeFileAtomic } from "../../lib/project-io.js";
import { withProjectCommitLock } from "@actalk/story-engine";
import { dirname, join } from "node:path";

/** 事实条目：类型只在引擎定义一份（2026-10-10 账本 v2；以前两个包各一份靠注释同步）。 */
export type { FactEntry } from "@actalk/story-engine";
import type { FactEntry } from "@actalk/story-engine";
export interface FactLedgerFile {
  readonly version: "v0";
  readonly facts: readonly FactEntry[];
}
export type FactCallModel = (
  messages: readonly { readonly role: "system" | "user"; readonly content: string }[],
) => Promise<string>;

/** 名字含空白/标点/符号即判畸形（中文名不含这些）。 */
const NAME_PUNCT_OR_SPACE = /[\s\p{P}\p{S}]/u;

/**
 * 对 LLM 抽出的「新人物名」做确定性安全过滤（题材中立、不调模型）：
 * 长度 2-4、无空白/标点、不在已知角色里、去重。LLM 已被要求只给真名，这里是兜底网。
 */
export function validateNewCharacterNames(
  names: readonly string[],
  knownNames: ReadonlySet<string>,
): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (name.length < 2 || name.length > 4) continue;
    if (NAME_PUNCT_OR_SPACE.test(name)) continue;
    if (knownNames.has(name) || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

const ledgerPath = (projectDir: string): string => join(projectDir, "story", "fact-ledger.json");
const normalize = (text: string): string => text.replace(/\s+/gu, "").trim();

/** 账本文件损坏（存在但非合法 JSON）时抛出此错——调用方据此 ok:false，绝不把坏文件当空表覆盖丢数据（修 P1·2）。 */
export class CorruptFactLedgerError extends Error {}

export async function readFactLedger(projectDir: string): Promise<{ readonly version: "v0"; readonly facts: FactEntry[] }> {
  let raw: string;
  try {
    raw = await readFile(ledgerPath(projectDir), "utf-8");
  } catch (error) {
    // 文件不存在 → 当空表初始化；其它读错误（权限等）不吞、不覆盖。
    if ((error as { code?: string })?.code === "ENOENT") return { version: "v0", facts: [] };
    throw error;
  }
  let parsed: Partial<FactLedgerFile>;
  try {
    parsed = JSON.parse(raw) as Partial<FactLedgerFile>;
  } catch {
    throw new CorruptFactLedgerError("story/fact-ledger.json 内容损坏（不是合法 JSON）。已停止操作以免覆盖丢数据，请先修复或删除该文件再试。");
  }
  return { version: "v0", facts: Array.isArray(parsed.facts) ? (parsed.facts as FactEntry[]) : [] };
}

async function writeLedger(projectDir: string, facts: readonly FactEntry[]): Promise<void> {
  const path = ledgerPath(projectDir);
  // 书已被删/移走时不再写（定稿后的事实抽取要跑一阵，期间书被删会凭空重建出只有账本的空书目录）。
  await stat(projectDir);
  await mkdir(dirname(path), { recursive: true });
  // 手改账本和定稿事务都写这个文件：排进同一把书的写锁，免得交叠互相覆盖。
  await withProjectCommitLock(projectDir, () => writeFileAtomic(path, JSON.stringify({ version: "v0", facts }, null, 2)));
}

/** 本章下一个事实序号：取已有最大序号 + 1（按条数算的旧法在删过条目后会撞号）。 */
function nextFactSeq(facts: readonly FactEntry[], chapter: number): number {
  const prefix = `fact-${chapter}-`;
  let max = -1;
  for (const fact of facts) {
    if (!fact.id.startsWith(prefix)) continue;
    const seq = Number(fact.id.slice(prefix.length));
    if (Number.isInteger(seq) && seq > max) max = seq;
  }
  return Math.max(max + 1, facts.filter((fact) => fact.chapter === chapter).length);
}

/** 追加事实（整个读改写在书的写锁里，不和定稿事务交叠）。 */
export function appendFacts(
  projectDir: string,
  chapter: number,
  texts: readonly string[],
  source: "auto" | "manual" = "auto",
): Promise<number> {
  return withProjectCommitLock(projectDir, () => appendFactsUnlocked(projectDir, chapter, texts, source));
}

async function appendFactsUnlocked(
  projectDir: string,
  chapter: number,
  texts: readonly string[],
  source: "auto" | "manual" = "auto",
): Promise<number> {
  let facts: FactEntry[];
  try {
    ({ facts } = await readFactLedger(projectDir));
  } catch (error) {
    // 账本损坏：跳过本次自动记事实，绝不覆盖丢已有数据（修 P1·2）。
    if (error instanceof CorruptFactLedgerError) return 0;
    throw error;
  }
  const seen = new Set(facts.map((fact) => normalize(fact.text)));
  let seq = nextFactSeq(facts, chapter);
  const added: FactEntry[] = [];
  for (const raw of texts) {
    const text = raw.trim();
    if (!text || seen.has(normalize(text))) continue;
    seen.add(normalize(text));
    added.push({ id: `fact-${chapter}-${seq++}`, chapter, text, source });
  }
  if (added.length === 0) return 0;
  await writeLedger(projectDir, [...facts, ...added]);
  return added.length;
}

/** 手改账本（整个读改写在书的写锁里，不和定稿事务交叠）。 */
export function applyFactEdit(
  projectDir: string,
  op: "add" | "update" | "remove" | "supersede",
  args: { readonly id?: string; readonly chapter?: number; readonly text?: string; readonly targetText?: string; readonly supersededByFactId?: string },
): Promise<{ readonly ok: boolean; readonly summary: string }> {
  return withProjectCommitLock(projectDir, () => applyFactEditUnlocked(projectDir, op, args));
}

async function applyFactEditUnlocked(
  projectDir: string,
  op: "add" | "update" | "remove" | "supersede",
  args: { readonly id?: string; readonly chapter?: number; readonly text?: string; readonly targetText?: string; readonly supersededByFactId?: string },
): Promise<{ readonly ok: boolean; readonly summary: string }> {
  let facts: FactEntry[];
  try {
    ({ facts } = await readFactLedger(projectDir));
  } catch (error) {
    // 账本损坏 → 如实 ok:false，绝不覆盖（修 P1·2）。
    if (error instanceof CorruptFactLedgerError) return { ok: false, summary: error.message };
    throw error;
  }
  // 模型无关·canonical：id 统一 trim（网关常给 id 带尾空白）；空白视同没给。
  const id = args.id?.trim() ? args.id.trim() : undefined;
  if (op === "supersede") {
    const fromChapter = args.chapter;
    if (typeof fromChapter !== "number" || !Number.isFinite(fromChapter) || fromChapter <= 0) {
      return { ok: false, summary: "标记取代需要『从第几章起失效』(正整数章号)。" };
    }
    // 定位要取代的旧事实：优先 id；否则按『描述文本』模糊匹配（agent 通常不知道真实 id，靠用户的描述找）。
    let targetId = id;
    if (!targetId && args.targetText && args.targetText.trim()) {
      const query = normalize(args.targetText);
      const candidates = facts.filter(
        (fact) => fact.supersededByChapter === undefined
          && (normalize(fact.text).includes(query) || query.includes(normalize(fact.text))),
      );
      if (candidates.length === 0) {
        return { ok: false, summary: `没找到与『${args.targetText.trim()}』匹配的、仍有效的硬事实——要不要先看看账本里有哪些条目？` };
      }
      if (candidates.length > 1) {
        return {
          ok: false,
          summary: `有多条硬事实都沾『${args.targetText.trim()}』：${candidates.map((c) => `第${c.chapter}章「${c.text}」`).join("；")}。请说得更具体（哪一章/哪句）。`,
        };
      }
      targetId = candidates[0].id;
    }
    if (!targetId) return { ok: false, summary: "标记取代需要『要取代哪条』——给条目 id 或那条旧事实的描述文本。" };
    let supersededText = "";
    let hit = false;
    const next = facts.map((fact) =>
      fact.id === targetId
        ? ((hit = true), (supersededText = fact.text), {
          ...fact,
          supersededByChapter: fromChapter,
          ...(args.supersededByFactId ? { supersededByFactId: args.supersededByFactId } : {}),
        })
        : fact,
    );
    if (!hit) return { ok: false, summary: `没找到 id=${targetId} 的硬事实。` };
    await writeLedger(projectDir, next);
    return { ok: true, summary: `已把『${supersededText}』标记为第 ${fromChapter} 章起被取代——旧设定从此不再喂正文（原文保留、可撤销）。` };
  }
  if (op === "add") {
    const text = (args.text ?? "").trim();
    if (!text) return { ok: false, summary: "没给要新增的事实内容。" };
    // 修 P1·3：不再默认第 0 章。章号须为正整数（由工具从当前章 context 解析后传入），解析不到就如实 ok:false。
    const chapter = args.chapter;
    if (typeof chapter !== "number" || !Number.isInteger(chapter) || chapter <= 0) {
      return { ok: false, summary: "记硬事实需要『发生在第几章』(正整数章号)——没定位到当前章的话，先告诉我章号。" };
    }
    const seq = nextFactSeq(facts, chapter);
    await writeLedger(projectDir, [...facts, { id: `fact-${chapter}-${seq}`, chapter, text, source: "manual" }]);
    return { ok: true, summary: `已记一条硬事实：${text}` };
  }
  if (op === "remove") {
    if (!id) return { ok: false, summary: "没给要删除的条目 id。" };
    const next = facts.filter((fact) => fact.id !== id);
    if (next.length === facts.length) return { ok: false, summary: `没找到 id=${id} 的硬事实。` };
    await writeLedger(projectDir, next);
    return { ok: true, summary: "已删除该条硬事实。" };
  }
  // update
  const text = (args.text ?? "").trim();
  if (!id || !text) return { ok: false, summary: "改硬事实需要 id 和新内容。" };
  let hit = false;
  const next = facts.map((fact) =>
    fact.id === id ? ((hit = true), { ...fact, text, source: "manual" as const }) : fact,
  );
  if (!hit) return { ok: false, summary: `没找到 id=${id} 的硬事实。` };
  await writeLedger(projectDir, next);
  return { ok: true, summary: `已更新该条硬事实：${text}` };
}
