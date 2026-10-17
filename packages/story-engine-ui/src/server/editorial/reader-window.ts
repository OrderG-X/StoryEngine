/**
 * 专员窗口底座（2026-10-12 编辑部第 1 步）：每本书、每个角色一个持续的对话窗口。
 *
 * 窗口 = 角色说明 + 每章（定稿原文 → 专员自己写的笔记）。专员一章一章跟读，读完写笔记；
 * 之后要它干活（核账等），就在读完某一章那一刻的窗口后面接上新活。窗口只往后追加，前缀不变，服务商缓存能命中。
 *
 * 笔记存盘（<书目录>/agents/<角色>/notes/NNNN.json），带该章定稿正文的哈希：原文改了，这一章和往后的笔记全部作废重写
 * （后面的笔记是在旧窗口上写的）。窗口太长先把最老的几章原文折掉、只留笔记（第 1 步）；
 * 折掉之后还超，就把整块的十份笔记缩写成一份卷笔记（2026-10-12 T5 长书）：
 *   - 卷笔记存 <书目录>/agents/<角色>/volumes/<起章>-<止章>.json，带十份下级材料的哈希，笔记变了就作废重写；
 *   - 窗口里用一条 user「【第 a～b 章（只留卷笔记）】」+ 一条 assistant 卷笔记代替这十章；
 *   - 书长得连卷笔记都装不下时（约一千章起），十条卷笔记再合成一条更高级的卷笔记，逐级往上，
 *     任何章数下窗口都不超过预算（READER_WINDOW_MAX_CHARS）。
 * 只依赖文件系统和注入的 callModel，不碰旧 agent/ 目录——以后整块搬进独立包。
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { registerReaderWaiting, unregisterReaderWaiting } from "./waiting-registry.js";
import type { ReaderWaited } from "./reader-progress.js";

export type BrainMessage = { readonly role: "system" | "user" | "assistant"; readonly content: string };
export type BrainCallModel = (messages: readonly BrainMessage[], options: { readonly json: boolean }) => Promise<string>;

export interface ReaderRole {
  /** 目录名，如 "checker"。 */
  readonly id: string;
  /** 角色说明（窗口第一条）。 */
  readonly system: string;
  /** 读完一章后写笔记的要求（拼在该章原文后面）。 */
  readonly noteTask: string;
  /** 把十份笔记（或十条下级卷笔记）缩写成一份卷笔记的要求。缺省没有：这种角色超预算时只折原文、不折卷。 */
  readonly volumeTask?: string;
}

/** 窗口总字数超过这个就把最老的原文折掉（按所有消息 content 的字数算）。 */
export const READER_WINDOW_MAX_CHARS = 150_000;
/** 折叠按这么多章一块：窗口前缀不随每章变化，缓存能持续命中。 */
const FOLD_BLOCK_CHAPTERS = 10;
/** 一份卷笔记写到盘上时最多留这么长（提示词要求 1500 字以内；这里只是兜底，防模型写飞把预算顶穿）。 */
const VOLUME_NOTE_MAX_CHARS = 2_000;
/** 规划卷笔记时还没生成的那份按这个字数估（宁可高估：估大了只会多折一点，不会超预算）。 */
const VOLUME_NOTE_ESTIMATE_CHARS = 1_700;
/** 卷笔记规划最多反复几轮（生成一份按实际字数重规划；正常两三轮就稳，到这里说明有毛病）。 */
const VOLUME_PLAN_MAX_ROUNDS = 64;

interface NoteFile {
  readonly chapter: number;
  /** 该章定稿正文的哈希：原文改了就对不上。 */
  readonly textHash: string;
  readonly note: string;
  readonly createdAt: string;
  /** 角色说明 + 记笔记要求的哈希：提示词改了，旧笔记不再算数。 */
  readonly roleHash: string;
}

interface VolumeFile {
  /** 起章（含）。 */
  readonly from: number;
  /** 止章（含）。 */
  readonly to: number;
  /** 覆盖的下级材料（十份笔记 / 十条下级卷笔记）按序拼起来的哈希：任何一份变了就作废重写。 */
  readonly textHash: string;
  /** 角色说明 + 卷笔记要求的哈希。 */
  readonly roleHash: string;
  readonly note: string;
  readonly createdAt: string;
}

/** 窗口里可以直接用的一条卷笔记（已生成、校验过）。 */
export interface VolumeNoteEntry {
  readonly from: number;
  readonly to: number;
  readonly note: string;
}

export interface ReaderWindowEntry {
  readonly chapter: number;
  readonly body: string;
  readonly note: string;
}

// ---------------------------------------------------------------------------
// 冷窗口（2026-10-13 编辑部 R4.4）：专员还没读完全书时先干活用的窗口
// ---------------------------------------------------------------------------

/** 冷窗口里「最近 K 章原文」的 K 上限（章数）。 */
export const COLD_RECENT_CHAPTERS = 8;
/** 冷窗口里「最近 K 章原文」这部分最多多少字（超了从最老的一章起让位，至少保住最近一章）。 */
export const COLD_RECENT_MAX_CHARS = 60_000;

/** 冷窗口实际对照到哪里（回执如实用，不给作者看裸结构）。 */
export interface ColdCoverage {
  /** 已有笔记到第几章（0＝一章笔记都还没有）。 */
  readonly notedThrough: number;
  /** 这次给了原文的第几章起（0＝一章原文都没给）。 */
  readonly rawFrom: number;
  /** 这次给了原文到第几章（含）。 */
  readonly rawTo: number;
}

export interface ColdReaderWindow {
  readonly messages: BrainMessage[];
  readonly coverage: ColdCoverage;
  /** 前文里这次看不到原文的章数（只剩笔记的 + 什么都没有的）：核账员据此决定要不要翻原文。 */
  readonly foldedChapters: number;
}

/** 冷窗口原文块（一条 user 消息）：先说清「只给了最近这几章、中间哪些章没给」，再按章给原文。 */
function coldRawMessage(chapters: readonly { readonly chapter: number; readonly body: string }[], notedThrough: number): string {
  if (chapters.length === 0) return "【前文原文】这次一章原文都没给你，前面只有已写下的笔记（见上）。";
  const from = chapters[0]!.chapter;
  const to = chapters[chapters.length - 1]!.chapter;
  const parts = [`【第 ${from}～${to} 章 定稿原文（你还没读过这些章、也没写过笔记，这次直接给你原文）】`];
  if (from > notedThrough + 1) {
    parts.push(`（第 ${notedThrough + 1}～${from - 1} 章这次没给你——既没笔记也没原文，那些章的细节这次对不到。）`);
  }
  for (const item of chapters) parts.push(`【第 ${item.chapter} 章】\n${item.body}`);
  return parts.join("\n\n");
}

/**
 * 冷窗口（R4.4 冷窗口兜底）：要补的笔记太多（后台补读还在跑）时不跳过，先拿这个窗口干活——
 * 角色说明 + 已有笔记（有几章算几章，按「原文已省略」的折叠形态，和正常窗口折过的前缀同构）
 * + 最近 K 章原文（默认最多 COLD_RECENT_CHAPTERS 章、这部分 ≤ COLD_RECENT_MAX_CHARS 字）。
 * 只读磁盘：不调模型、一个字都不落盘（绝不把冷窗口当成读书笔记写进 agents/<role>/notes，免得和正常补读混在一起）。
 * 总预算超了先从最老的笔记起丢（最近的状态最要紧），实在装不下时至少保住最近一章原文。
 */
export async function buildColdReaderWindow(input: {
  readonly projectDir: string;
  readonly role: ReaderRole;
  /** 要对照到的最后一章（核第 N 章时是 N-1）。 */
  readonly upTo: number;
  /** 笔记存放的根目录；缺省就是书目录。 */
  readonly notesRoot?: string;
  readonly maxRecentChapters?: number;
  readonly maxRecentChars?: number;
  /** 窗口总字数预算；缺省 READER_WINDOW_MAX_CHARS（测试用小值）。 */
  readonly maxChars?: number;
}): Promise<ColdReaderWindow> {
  const root = input.notesRoot ?? input.projectDir;
  const maxRecentChapters = input.maxRecentChapters ?? COLD_RECENT_CHAPTERS;
  const maxRecentChars = input.maxRecentChars ?? COLD_RECENT_MAX_CHARS;
  const maxChars = input.maxChars ?? READER_WINDOW_MAX_CHARS;
  const state = await inspectNotes({ projectDir: input.projectDir, root, role: input.role, upTo: input.upTo });
  // 最近 K 章原文：从「笔记断点的下一章」和「倒数第 K 章」里取更靠后的那个起，能读到的正文读不到就停。
  const recent: { readonly chapter: number; readonly body: string }[] = [];
  for (let chapter = Math.max(state.valid.length + 1, state.upTo - maxRecentChapters + 1); chapter <= state.upTo; chapter += 1) {
    const body = state.bodies[chapter - 1] ?? "";
    if (!body) break;
    recent.push({ chapter, body });
  }
  while (recent.length > 1 && recent.reduce((sum, item) => sum + item.body.length, 0) > maxRecentChars) recent.shift();
  const rawText = coldRawMessage(recent, state.valid.length);
  const noteSize = (entry: ReaderWindowEntry): number => foldedUserContent(entry.chapter).length + entry.note.length;
  const totalWith = (notes: readonly ReaderWindowEntry[]): number =>
    input.role.system.length + notes.reduce((sum, entry) => sum + noteSize(entry), 0) + rawText.length;
  let notes = state.valid;
  while (notes.length > 0 && totalWith(notes) > maxChars) notes = notes.slice(1);
  const messages: BrainMessage[] = [
    { role: "system", content: input.role.system },
    ...notes.flatMap((entry): BrainMessage[] => [
      { role: "user", content: foldedUserContent(entry.chapter) },
      { role: "assistant", content: entry.note },
    ]),
    { role: "user", content: rawText },
  ];
  return {
    messages,
    coverage: { notedThrough: state.valid.length, rawFrom: recent[0]?.chapter ?? 0, rawTo: recent[recent.length - 1]?.chapter ?? 0 },
    foldedChapters: Math.max(0, state.upTo - recent.length),
  };
}

const sha = (text: string): string => createHash("sha256").update(text, "utf-8").digest("hex").slice(0, 16);

const chapterFile = (projectDir: string, chapter: number): string =>
  join(projectDir, "chapters", `${String(chapter).padStart(4, "0")}.md`);

const notesDir = (root: string, roleId: string): string => join(root, "agents", roleId, "notes");

const noteFile = (root: string, roleId: string, chapter: number): string =>
  join(notesDir(root, roleId), `${String(chapter).padStart(4, "0")}.json`);

const volumesDir = (root: string, roleId: string): string => join(root, "agents", roleId, "volumes");

const volumeFile = (root: string, roleId: string, from: number, to: number): string =>
  join(volumesDir(root, roleId), `${from}-${to}.json`);

const volumeKey = (from: number, to: number): string => `${from}-${to}`;

const roleHashOf = (role: ReaderRole): string => sha(`${role.system}\n\n${role.noteTask}`);

const volumeRoleHashOf = (role: ReaderRole): string => sha(`${role.system}\n\n${role.volumeTask ?? ""}`);

/** 卷笔记的下级材料按序拼起来（求哈希用）：第 1 份在前，中间用空字符隔开。 */
const materialsJoin = (materials: readonly string[]): string => materials.join("\n\u0000\n");

/** 已定稿正文（去掉首行标题、trim）。读不到或是空的返回空串。 */
async function readFinalBody(projectDir: string, chapter: number): Promise<string> {
  const raw = await readFile(chapterFile(projectDir, chapter), "utf-8").catch(() => "");
  return raw.replace(/^#[^\n]*\n/u, "").trim();
}

async function readNote(root: string, roleId: string, chapter: number): Promise<NoteFile | undefined> {
  try {
    const parsed = JSON.parse(await readFile(noteFile(root, roleId, chapter), "utf-8")) as Partial<NoteFile>;
    if (parsed.chapter !== chapter || typeof parsed.textHash !== "string" || typeof parsed.roleHash !== "string") return undefined;
    if (typeof parsed.note !== "string" || !parsed.note.trim()) return undefined;
    return { chapter, textHash: parsed.textHash, note: parsed.note, createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "", roleHash: parsed.roleHash };
  } catch {
    // 没写过 / 文件坏了 → 当没有（坏了最多是这一章重读一次）
    return undefined;
  }
}

/** 写临时文件再 rename：崩溃只会留下旧内容或新内容，不会留半截文件。 */
export async function writeAtomically(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, text, "utf-8");
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeNote(projectDir: string, root: string, roleId: string, file: NoteFile): Promise<void> {
  await stat(projectDir); // 书已删就别再写（免得建出幽灵目录）
  await writeAtomically(noteFile(root, roleId, file.chapter), `${JSON.stringify(file, null, 2)}\n`);
}

/** 作废第 fromChapter 章起（含）往后的全部笔记，包括超出这次要读到的章号的。 */
async function removeNotesFrom(root: string, roleId: string, fromChapter: number): Promise<void> {
  const files = await readdir(notesDir(root, roleId)).catch(() => [] as string[]);
  for (const file of files) {
    const match = /^(\d{4})\.json$/u.exec(file);
    if (match && Number(match[1]) >= fromChapter) await rm(join(notesDir(root, roleId), file), { force: true });
  }
}

/** 作废起章 ≥ fromChapter 的全部卷笔记（盖住的笔记重写了，它就不再算数）。 */
async function removeVolumesFrom(root: string, roleId: string, fromChapter: number): Promise<void> {
  const files = await readdir(volumesDir(root, roleId)).catch(() => [] as string[]);
  for (const file of files) {
    const match = /^(\d+)-(\d+)\.json$/u.exec(file);
    if (match && Number(match[1]) >= fromChapter) await rm(join(volumesDir(root, roleId), file), { force: true });
  }
}

const readUserContent = (role: ReaderRole, chapter: number, body: string): string =>
  `【第 ${chapter} 章 定稿原文】\n${body}\n\n${role.noteTask}`;

const foldedUserContent = (chapter: number): string => `【第 ${chapter} 章（原文已省略，见你当时的笔记）】`;

const volumeUserContent = (from: number, to: number): string => `【第 ${from}～${to} 章（只留卷笔记）】`;

// ---------------------------------------------------------------------------
// 窗口布局：哪些章放原文、哪些章只留笔记、哪些章合成卷笔记
// ---------------------------------------------------------------------------

/** 布局里的一条卷笔记：盖住 from..to 章（都在折叠区内）。叶子（children 为空）盖一个十块，材料是那十章的笔记。 */
interface LayoutVolume {
  readonly from: number;
  readonly to: number;
  /** 层级：叶子是 1，每被合成一次 +1（找「同层相邻的一段」用）。 */
  readonly level: number;
  readonly children: readonly LayoutVolume[];
}

interface WindowLayout {
  /** 第 1..foldedThrough 章原文已折掉（只剩笔记或卷笔记）。 */
  readonly foldedThrough: number;
  readonly volumes: readonly LayoutVolume[];
}

/** 一条卷笔记渲染出来占的字数。 */
const volumeRenderedSize = (from: number, to: number, noteLength: number): number =>
  volumeUserContent(from, to).length + noteLength;

/** 一条卷笔记一次最多把几条下级卷笔记合成一条。 */
const MERGE_RUN_MAX = 10;

/**
 * 纯规划（不渲染）：超预算先按十块折原文；折光了还超，就把十块的十份笔记换成一条卷笔记（一条盖一个十块）；
 * 全换完还超（约一千章往上），再把最前面一段同层相邻的卷笔记（最多十条、至少两条）合成一条，逐级上去——
 * 任何章数都能折到预算以内。
 * noteSizeFor 给某条卷笔记的字数：已生成的给实际字数，没生成的给估值（undefined＝这条用不了、不折它）。
 * 估大了只会多折一点，不会超预算；规划只从最老的章往前折，章越来越多折得只会更多，前缀稳定。
 */
function planWindowLayout(input: {
  readonly role: ReaderRole;
  readonly entries: readonly ReaderWindowEntry[];
  readonly maxChars: number;
  readonly noteSizeFor: (from: number, to: number) => number | undefined;
}): WindowLayout {
  const { entries } = input;
  const fullSizes = entries.map((entry) => readUserContent(input.role, entry.chapter, entry.body).length);
  const foldedSizes = entries.map((entry) => foldedUserContent(entry.chapter).length + entry.note.length);
  const blockCount = Math.floor(entries.length / FOLD_BLOCK_CHAPTERS);
  let total = input.role.system.length + fullSizes.reduce((sum, size) => sum + size, 0) + entries.reduce((sum, entry) => sum + entry.note.length, 0);
  let folded = 0;
  while (total > input.maxChars && folded < entries.length) {
    const next = folded + FOLD_BLOCK_CHAPTERS <= entries.length ? folded + FOLD_BLOCK_CHAPTERS : folded + 1;
    for (let index = folded; index < next; index += 1) total -= fullSizes[index]! - foldedUserContent(entries[index]!.chapter).length;
    folded = next;
  }
  if (total <= input.maxChars || !input.role.volumeTask) return { foldedThrough: folded, volumes: [] };

  // 卷笔记阶段（到这里时原文已全折掉）。
  const covered = new Set<number>(); // 已被卷笔记盖住的十块下标
  const volumes: LayoutVolume[] = [];
  while (total > input.maxChars) {
    // ① 最老的还没盖住的完整十块 → 十份笔记换成一条卷笔记。
    let block = 0;
    while (block < blockCount && covered.has(block)) block += 1;
    if (block < blockCount) {
      const from = block * FOLD_BLOCK_CHAPTERS + 1;
      const to = (block + 1) * FOLD_BLOCK_CHAPTERS;
      const size = input.noteSizeFor(from, to);
      if (size === undefined) break; // 这条卷笔记没有也用不了：没得再折
      volumes.push({ from, to, level: 1, children: [] });
      total += volumeRenderedSize(from, to, size) - foldedSizes.slice(from - 1, to).reduce((sum, each) => sum + each, 0);
      covered.add(block);
      continue;
    }
    // ② 全盖住了还超：最前面一段同层相邻的卷笔记（最多十条、至少两条）合成一条，逐级往上。
    let start = 0;
    let count = 0;
    for (let index = 0; index < volumes.length; index += 1) {
      let run = 1;
      while (index + run < volumes.length && volumes[index + run]!.level === volumes[index]!.level) run += 1;
      if (run >= 2) {
        start = index;
        count = Math.min(MERGE_RUN_MAX, run);
        break;
      }
      index += run - 1;
    }
    if (count === 0) break; // 没得再合了（只剩一条卷笔记）
    const children = volumes.slice(start, start + count);
    const from = children[0]!.from;
    const to = children[children.length - 1]!.to;
    const size = input.noteSizeFor(from, to);
    if (size === undefined) break;
    volumes.splice(start, count, { from, to, level: children[0]!.level + 1, children });
    total += volumeRenderedSize(from, to, size)
      - children.reduce((sum, child) => sum + volumeRenderedSize(child.from, child.to, input.noteSizeFor(child.from, child.to) ?? VOLUME_NOTE_ESTIMATE_CHARS), 0);
  }
  return { foldedThrough: folded, volumes };
}

/** 按布局渲染窗口：卷笔记盖住的段出两条消息，其余按折叠 / 原文出。没给笔记的卷记空串（不该发生，防御）。 */
function renderWindowLayout(role: ReaderRole, entries: readonly ReaderWindowEntry[], layout: WindowLayout, volumeNotes: ReadonlyMap<string, VolumeNoteEntry>): BrainMessage[] {
  const messages: BrainMessage[] = [{ role: "system", content: role.system }];
  let chapter = 1;
  const pushChapters = (through: number, folded: boolean): void => {
    for (; chapter <= through && chapter <= entries.length; chapter += 1) {
      const entry = entries[chapter - 1]!;
      messages.push(
        { role: "user", content: folded ? foldedUserContent(entry.chapter) : readUserContent(role, entry.chapter, entry.body) },
        { role: "assistant", content: entry.note },
      );
    }
  };
  for (const volume of layout.volumes) {
    pushChapters(volume.from - 1, true);
    messages.push(
      { role: "user", content: volumeUserContent(volume.from, volume.to) },
      { role: "assistant", content: volumeNotes.get(volumeKey(volume.from, volume.to))?.note ?? "" },
    );
    chapter = volume.to + 1;
  }
  pushChapters(layout.foldedThrough, true);
  pushChapters(entries.length, false);
  return messages;
}

/**
 * 拼窗口：[system] + 每章两条（user＝定稿原文 + 记笔记要求；assistant＝笔记）。entries 必须是从第 1 章起连续的。
 * 超预算就从第 1 章起按每 FOLD_BLOCK_CHAPTERS 章一块把原文折掉、只留笔记，折到不超为止（整块折完还超，才再一章一章折）。
 * 角色有 volumeTask 且传进了卷笔记时，超预算的块用一条卷笔记代替十章（只认传进来的，不自己生成）。
 * 写笔记时的窗口和之后核账时的窗口都用同一套规划，所以前缀逐字一样。
 */
export function assembleReaderWindow(
  role: ReaderRole,
  entries: readonly ReaderWindowEntry[],
  maxChars: number = READER_WINDOW_MAX_CHARS,
  volumes: readonly VolumeNoteEntry[] = [],
): BrainMessage[] {
  const volumeNotes = new Map(volumes.map((volume) => [volumeKey(volume.from, volume.to), volume]));
  const layout = planWindowLayout({
    role,
    entries,
    maxChars,
    // 纯拼窗口（不生成）：给多少卷笔记用多少
    noteSizeFor: (from, to) => volumeNotes.get(volumeKey(from, to))?.note.length,
  });
  return renderWindowLayout(role, entries, layout, volumeNotes);
}

interface NotesState {
  /** 能读到的定稿章数（遇到读不到的章就停在前一章）。 */
  readonly upTo: number;
  /** 第 1..upTo 章的定稿正文。 */
  readonly bodies: readonly string[];
  /** 从第 1 章起连续有效（对得上正文和提示词）的笔记。 */
  readonly valid: readonly ReaderWindowEntry[];
}

async function inspectNotes(input: { readonly projectDir: string; readonly root: string; readonly role: ReaderRole; readonly upTo: number }): Promise<NotesState> {
  const roleHash = roleHashOf(input.role);
  const bodies: string[] = [];
  const valid: ReaderWindowEntry[] = [];
  let broken = false;
  for (let chapter = 1; chapter <= input.upTo; chapter += 1) {
    const body = await readFinalBody(input.projectDir, chapter);
    if (!body) break;
    bodies.push(body);
    if (broken) continue;
    const note = await readNote(input.root, input.role.id, chapter);
    if (note && note.textHash === sha(body) && note.roleHash === roleHash) valid.push({ chapter, body, note: note.note });
    else broken = true;
  }
  return { upTo: bodies.length, bodies, valid };
}

/** 已定稿到第几章（chapters/NNNN.md 里最大的章号）。目录读不到是 0。 */
export async function countCommittedChapters(projectDir: string): Promise<number> {
  const files = await readdir(join(projectDir, "chapters")).catch(() => [] as string[]);
  return files.reduce((max, file) => {
    const match = /^(\d{4})\.md$/u.exec(file);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
}

/** 同一本书、同一角色同时只跑一个补笔记（进程内排队）：后来的等前面的结束，再自己检查一遍。 */
const catchUpLocks = new Map<string, Promise<unknown>>();

async function withCatchUpLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = catchUpLocks.get(key) ?? Promise.resolve();
  const current = previous.then(run);
  const tail = current.catch(() => undefined);
  catchUpLocks.set(key, tail);
  try {
    return await current;
  } finally {
    if (catchUpLocks.get(key) === tail) catchUpLocks.delete(key);
  }
}

/** 读一条卷笔记：字段齐、哈希对得上（下级材料 + 卷笔记提示词）才要。 */
async function readVolume(root: string, role: ReaderRole, from: number, to: number, materials: readonly string[]): Promise<VolumeNoteEntry | undefined> {
  try {
    const parsed = JSON.parse(await readFile(volumeFile(root, role.id, from, to), "utf-8")) as Partial<VolumeFile>;
    if (parsed.from !== from || parsed.to !== to) return undefined;
    if (typeof parsed.note !== "string" || !parsed.note.trim()) return undefined;
    if (parsed.textHash !== sha(materialsJoin(materials)) || parsed.roleHash !== volumeRoleHashOf(role)) return undefined;
    return { from, to, note: parsed.note };
  } catch {
    // 没写过 / 文件坏了 → 当没有（坏了最多是这条卷笔记重生成一次）
    return undefined;
  }
}

/** 生成一条卷笔记的调用：把十份下级材料列给专员，让它缩写成一份（1500 字以内）。 */
function buildVolumeMessages(role: ReaderRole, from: number, to: number, materials: readonly string[]): BrainMessage[] {
  const listed = materials
    .map((note, index) => `【${from + index} 章的读书笔记】\n${note}`)
    .join("\n\n");
  return [
    { role: "system", content: role.system },
    { role: "user", content: `【第 ${from}～${to} 章的读书笔记（缩写成卷笔记）】\n${listed}\n\n${role.volumeTask ?? ""}` },
  ];
}

export interface EnsuredReaderWindow {
  /** 读完第 upTo 章那一刻的窗口；maxCatchUp 触发（missing > 0）时为空。 */
  readonly messages: BrainMessage[];
  /** 这次新写的笔记数。 */
  readonly built: number;
  /** 直接复用的笔记数。 */
  readonly reused: number;
  /** 需要新写但这次没写的笔记数（超过 maxCatchUp）。 */
  readonly missing: number;
  /** 这次新生成 / 重生成的卷笔记数。 */
  readonly volumesBuilt: number;
  /** 窗口里原文被折掉的章数（含被卷笔记盖住的）：核账员据此决定要不要翻原文。 */
  readonly foldedChapters: number;
  /** 实际读到第几章（某章定稿读不到时停在它前一章）。 */
  readonly readThrough: number;
  /** 这次等过补读（R6.1）：开口那一刻之后笔记多出来的章（第 from～to 章）、等了 ms 毫秒——
   *  不管笔记是谁补上的（自己当场补 / 排在后台补读后面等它补完），回执据此如实说等过。笔记本来就齐不带。 */
  readonly waited?: ReaderWaited;
}

/**
 * 确保专员读到了第 upTo 章：第 1..upTo 章每章的笔记都在、且对得上当前定稿正文，缺的按顺序补写。
 * 第一个对不上（或缺失）的章起往后的笔记全部作废重写（盖住它们的卷笔记一并作废）。某章定稿读不到就停在它前一章（不报错）。
 * 折掉原文还超预算时按规划生成卷笔记（角色要有 volumeTask）：写每一章笔记用的窗口也先卷好，
 * 保证任何时刻发给模型的消息都不超预算。补笔记的模型调用失败照实抛出——已写下的笔记留着，下次接着补。
 */
export async function ensureReaderWindow(input: {
  readonly projectDir: string;
  readonly role: ReaderRole;
  readonly upTo: number;
  readonly callModel: BrainCallModel;
  /** 笔记存放的根目录；缺省就是书目录（评测时传临时目录，不动书）。 */
  readonly notesRoot?: string;
  /** 需要新写的笔记超过这个数就不写了，直接返回 missing > 0（调用方如实说「还在读前文」，笔记在后台补）。缺省不限。 */
  readonly maxCatchUp?: number;
  /** 窗口字数预算；缺省 READER_WINDOW_MAX_CHARS（测试用小值）。 */
  readonly maxChars?: number;
  /** 每写完一章笔记调一次（后台补读拿它落进度）；返回 Promise 会等它落完再写下一章。 */
  readonly onProgress?: (chapter: number) => void | Promise<void>;
  /** 当场补读真正开始前调一次（done＝已有笔记数；R5.2 等读标注用）。不会补（笔记齐了 / 超额走冷窗口）就不调。 */
  readonly onCatchUpBegin?: (done: number, total: number) => void | Promise<void>;
  /** 当场补读结束（含中途失败）调一次（done＝落下的笔记数；R5.2 等读标注收尾用）。 */
  readonly onCatchUpEnd?: (done: number, total: number) => void | Promise<void>;
  /** 等读期间进度行标注的动作名（R6.1）：核账 / 拟纲 / 记账。进锁前在进程内登记「这个动作在等这个角色」、
   *  finally 里注销——排在后台补读后面干等也标出来；冷窗口（超额）没等就不登记。 */
  readonly waitingAs?: string;
}): Promise<EnsuredReaderWindow> {
  const root = input.notesRoot ?? input.projectDir;
  const maxChars = input.maxChars ?? READER_WINDOW_MAX_CHARS;
  const inspect = () => inspectNotes({ projectDir: input.projectDir, root, role: input.role, upTo: input.upTo });
  const notReady = (state: NotesState): EnsuredReaderWindow =>
    ({ messages: [], built: 0, reused: state.valid.length, missing: state.upTo - state.valid.length, volumesBuilt: 0, foldedChapters: 0, readThrough: state.valid.length });
  const tooMany = (state: NotesState): boolean => input.maxCatchUp !== undefined && state.upTo - state.valid.length > input.maxCatchUp;

  // 开口那一刻（R6.1）：进锁前先看一眼已有几章有效笔记＋记下时间。等没等、等的是哪几章都按它算——
  // 排在后台补读后面时，轮到我们笔记已经齐了（built=0），但「开口时缺的章等完补上了」照样算等过。
  // maxCatchUp 没传（后台补读自己用）也要记：谁都能拿到 waited，调用方不用自己按 built>0 猜。
  const startedAt = Date.now();
  const peek = await inspect();
  if (tooMany(peek)) return notReady(peek); // 缺得太多走冷窗口：没等，不登记
  const spokeWith = peek.valid.length;
  const run = (): Promise<EnsuredReaderWindow> => withCatchUpLock(`${root}\u0000${input.role.id}`, async () => {
    const state = await inspect();
    if (tooMany(state)) return notReady(state);
    const entries = [...state.valid];
    const firstStale = entries.length + 1;
    if (firstStale <= state.upTo) {
      await removeNotesFrom(root, input.role.id, firstStale);
      await removeVolumesFrom(root, input.role.id, firstStale);
    }
    const roleHash = roleHashOf(input.role);
    const volumeNotes = new Map<string, VolumeNoteEntry>();
    let volumesBuilt = 0;
    /** 还没生成的那份卷笔记按这个字数估：已生成的平均长度（夹在 400～1700），一份都没有时按上限估。
     *  估大了只会多折、不会超预算；照着已生成的估能少生成一堆马上就用不上的中间卷笔记。 */
    const estimateVolumeChars = (): number => {
      if (volumeNotes.size === 0) return VOLUME_NOTE_ESTIMATE_CHARS;
      const sizes = [...volumeNotes.values()].map((volume) => volume.note.length);
      return Math.min(VOLUME_NOTE_ESTIMATE_CHARS, Math.max(400, Math.round(sizes.reduce((sum, size) => sum + size, 0) / sizes.length)));
    };
    /** 拿到一条卷笔记：内存里有就用，盘上对得上就用，否则把下级材料备齐（叶子＝十章笔记，否则＝下级卷笔记）、调模型生成、存盘。 */
    const volumeNoteOf = async (volume: LayoutVolume): Promise<VolumeNoteEntry> => {
      const key = volumeKey(volume.from, volume.to);
      const cached = volumeNotes.get(key);
      if (cached) return cached;
      const materials: string[] = [];
      if (volume.children.length === 0) {
        for (let chapter = volume.from; chapter <= volume.to; chapter += 1) materials.push(entries[chapter - 1]!.note);
      } else {
        for (const child of volume.children) materials.push((await volumeNoteOf(child)).note);
      }
      const existing = await readVolume(root, input.role, volume.from, volume.to, materials);
      if (existing) {
        volumeNotes.set(key, existing);
        return existing;
      }
      const note = (await input.callModel(buildVolumeMessages(input.role, volume.from, volume.to, materials), { json: false }))
        .trim()
        .slice(0, VOLUME_NOTE_MAX_CHARS);
      if (!note) throw new Error(`第 ${volume.from}～${volume.to} 章的卷笔记是空的`);
      await stat(input.projectDir); // 书已删就别再写
      await writeAtomically(
        volumeFile(root, input.role.id, volume.from, volume.to),
        `${JSON.stringify({ from: volume.from, to: volume.to, textHash: sha(materialsJoin(materials)), roleHash: volumeRoleHashOf(input.role), note, createdAt: new Date().toISOString() } satisfies VolumeFile, null, 2)}\n`,
      );
      const entry = { from: volume.from, to: volume.to, note };
      volumeNotes.set(key, entry);
      volumesBuilt += 1;
      return entry;
    };
    /** 按当前笔记把窗口规划稳：该有的卷笔记都备齐（生成或从盘上认领），返回布局。 */
    const settleVolumes = async (): Promise<WindowLayout> => {
      for (let round = 0; round < VOLUME_PLAN_MAX_ROUNDS; round += 1) {
        const layout = planWindowLayout({
          role: input.role,
          entries,
          maxChars,
          noteSizeFor: (from, to) => volumeNotes.get(volumeKey(from, to))?.note.length ?? estimateVolumeChars(),
        });
        const missing = layout.volumes.filter((volume) => !volumeNotes.has(volumeKey(volume.from, volume.to)));
        if (missing.length === 0) return layout;
        for (const volume of missing) await volumeNoteOf(volume);
      }
      throw new Error("卷笔记规划没有收敛");
    };
    const renderWindow = async (): Promise<{ readonly messages: BrainMessage[]; readonly foldedChapters: number }> => {
      const layout = input.role.volumeTask ? await settleVolumes() : planWindowLayout({
        role: input.role,
        entries,
        maxChars,
        noteSizeFor: () => undefined,
      });
      return { messages: renderWindowLayout(input.role, entries, layout, volumeNotes), foldedChapters: layout.foldedThrough };
    };
    if (firstStale <= state.upTo) {
      // 真要当场补笔记了：先标一笔「开始等」（R5.2 等读标注），再一章一章补。
      await input.onCatchUpBegin?.(entries.length, state.upTo);
    }
    try {
      for (let chapter = firstStale; chapter <= state.upTo; chapter += 1) {
        const body = state.bodies[chapter - 1]!;
        const window = await renderWindow();
        const note = (await input.callModel(
          [...window.messages, { role: "user", content: readUserContent(input.role, chapter, body) }],
          { json: false },
        )).trim();
        if (!note) throw new Error(`第 ${chapter} 章的读书笔记是空的`);
        await writeNote(input.projectDir, root, input.role.id, { chapter, textHash: sha(body), note, createdAt: new Date().toISOString(), roleHash });
        entries.push({ chapter, body, note });
        await input.onProgress?.(chapter);
      }
    } finally {
      // 等读收尾（含中途失败）：把进度从「在读」翻回「读完」，失败时 done 如实停在落下的那章。
      if (firstStale <= state.upTo) await input.onCatchUpEnd?.(entries.length, state.upTo);
    }
    const final = await renderWindow();
    return {
      messages: final.messages,
      built: entries.length - state.valid.length,
      reused: state.valid.length,
      missing: 0,
      volumesBuilt,
      foldedChapters: final.foldedChapters,
      readThrough: state.upTo,
      // 等过了（R6.1）：拿到窗口时读到的章比开口时多——多的就是这中间补上的（谁补的都算），如实带回执。
      ...(state.upTo > spokeWith ? { waited: { from: spokeWith + 1, to: state.upTo, ms: Date.now() - startedAt } satisfies ReaderWaited } : {}),
    };
  });
  if (!input.waitingAs) return run();
  registerReaderWaiting(root, input.role.id, input.waitingAs);
  try {
    return await run();
  } finally {
    unregisterReaderWaiting(root, input.role.id, input.waitingAs);
  }
}
