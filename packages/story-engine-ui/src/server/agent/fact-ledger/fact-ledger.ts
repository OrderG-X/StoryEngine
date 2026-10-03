/**
 * fact-ledger —— 硬事实账本：抽取提示词/解析 + 读写 story/fact-ledger.json + 编排 + 改账本。
 * 纯逻辑、callModel 注入便于单测。题材中立、绝不静默失败（抽取失败非致命、如实回报）。
 */
import { mkdir, readFile } from "node:fs/promises";
import { writeFileAtomic } from "../../lib/project-io.js";
import { dirname, join } from "node:path";
import { z } from "zod";

export interface FactEntry {
  readonly id: string;
  readonly chapter: number;
  readonly text: string;
  readonly source: "auto" | "manual";
  /** 有效区间（章为单位）。缺省=从来源章起、永不失效（向后兼容旧账本）。与引擎 types.ts FactEntry 同步。 */
  readonly effectiveFromChapter?: number;
  readonly supersededByChapter?: number;
  readonly supersededByFactId?: string;
}
export interface FactLedgerFile {
  readonly version: "v0";
  readonly facts: readonly FactEntry[];
}
export type FactCallModel = (
  messages: readonly { readonly role: "system" | "user"; readonly content: string }[],
) => Promise<string>;

const extractionSchema = z.object({
  facts: z.array(z.object({ text: z.string().trim().min(1) }).strict()).default([]),
  newCharacters: z.array(z.object({ name: z.string().trim().min(1) }).strict()).default([]),
}).strict();

export function buildFactExtractionMessages(
  draftText: string,
  knownNames: readonly string[] = [],
): { readonly role: "system" | "user"; readonly content: string }[] {
  const system = [
    "你是中文小说的『硬事实记录员』。只读这章正文，抽出后文必须保持一致的硬事实，并指出本章首次出现的新人物。",
    "只抽正文真实写到的，禁臆造、禁补剧情、禁预设走向。本章没有就给空数组。",
    "硬事实重点：①主角做出的承诺/约定/交易条款（带金额/数量/时间/地点/方式）②事件性质（尤其『私下/非正式』vs『公开/官方』这类一旦定下不可改的属性）③关键数字/日期/场次/编号/身份等硬细节。每条一句话、具体可核对；不要抽『情绪/感受/评价』这类软信息。",
    "新人物：只列本章正文里【首次出现、且不在『已知角色』名单里】的【具名】人物（真名，宁缺毋滥）；代词/泛称/职务（他、那人、保安）一律不算。",
    "只输出一个 JSON：{\"facts\":[{\"text\":\"\"}],\"newCharacters\":[{\"name\":\"\"}]}。不要 Markdown、不要解释。",
  ].join("\n");
  const known = knownNames.length > 0 ? `\n【已知角色（这些都不是新人物）】\n${knownNames.join("、")}` : "";
  return [{ role: "system", content: system }, { role: "user", content: `【本章正文】\n${draftText}${known}` }];
}

export function parseFactExtraction(
  modelText: string,
): { readonly facts: readonly string[]; readonly newCharacters: readonly string[] } {
  const match = modelText.match(/\{[\s\S]*\}/u);
  if (!match) throw new Error("硬事实抽取结果不是 JSON。");
  const parsed = extractionSchema.parse(JSON.parse(match[0]));
  return {
    facts: parsed.facts.map((fact) => fact.text.trim()).filter((text) => text.length > 0),
    newCharacters: parsed.newCharacters.map((c) => c.name.trim()).filter((name) => name.length > 0),
  };
}

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
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, JSON.stringify({ version: "v0", facts }, null, 2));
}

export async function appendFacts(
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
  let seq = facts.filter((fact) => fact.chapter === chapter).length;
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

export async function applyFactEdit(
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
    const seq = facts.filter((fact) => fact.chapter === chapter).length;
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

export async function extractAndAppendFacts(input: {
  readonly projectDir: string;
  readonly chapter: number;
  readonly draftText: string;
  readonly callModel: FactCallModel;
  readonly knownNames?: readonly string[];
}): Promise<{ readonly ok: boolean; readonly added: number; readonly summary: string; readonly newCharacters: readonly string[] }> {
  if (!input.draftText.trim()) return { ok: true, added: 0, summary: "", newCharacters: [] };
  let facts: readonly string[];
  let rawNew: readonly string[];
  try {
    const out = await input.callModel(buildFactExtractionMessages(input.draftText, input.knownNames ?? []));
    ({ facts, newCharacters: rawNew } = parseFactExtraction(out));
  } catch {
    return { ok: false, added: 0, summary: "（这章的硬事实没抽成，可让我重抽一次。）", newCharacters: [] };
  }
  const added = await appendFacts(input.projectDir, input.chapter, facts, "auto");
  const newCharacters = validateNewCharacterNames(rawNew, new Set(input.knownNames ?? []));
  return {
    ok: true,
    added,
    summary: added > 0 ? `📌 这章记下 ${added} 条硬事实（后文不得改写）。` : "",
    newCharacters,
  };
}
