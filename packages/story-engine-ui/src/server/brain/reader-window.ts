/**
 * 专员窗口底座（2026-10-12 编辑部第 1 步）：每本书、每个角色一个持续的对话窗口。
 *
 * 窗口 = 角色说明 + 每章（定稿原文 → 专员自己写的笔记）。专员一章一章跟读，读完写笔记；
 * 之后要它干活（核账等），就在读完某一章那一刻的窗口后面接上新活。窗口只往后追加，前缀不变，服务商缓存能命中。
 *
 * 笔记存盘（<书目录>/agents/<角色>/notes/NNNN.json），带该章定稿正文的哈希：原文改了，这一章和往后的笔记全部作废重写
 * （后面的笔记是在旧窗口上写的）。窗口太长就把最老的几章原文折掉、只留笔记。
 * 只依赖文件系统和注入的 callModel，不碰旧 agent/ 目录——以后整块搬进独立包。
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type BrainMessage = { readonly role: "system" | "user" | "assistant"; readonly content: string };
export type BrainCallModel = (messages: readonly BrainMessage[], options: { readonly json: boolean }) => Promise<string>;

export interface ReaderRole {
  /** 目录名，如 "checker"。 */
  readonly id: string;
  /** 角色说明（窗口第一条）。 */
  readonly system: string;
  /** 读完一章后写笔记的要求（拼在该章原文后面）。 */
  readonly noteTask: string;
}

/** 窗口总字数超过这个就把最老的原文折掉（按所有消息 content 的字数算）。 */
export const READER_WINDOW_MAX_CHARS = 150_000;
/** 折叠按这么多章一块：窗口前缀不随每章变化，缓存能持续命中。 */
const FOLD_BLOCK_CHAPTERS = 10;

interface NoteFile {
  readonly chapter: number;
  /** 该章定稿正文的哈希：原文改了就对不上。 */
  readonly textHash: string;
  readonly note: string;
  readonly createdAt: string;
  /** 角色说明 + 记笔记要求的哈希：提示词改了，旧笔记不再算数。 */
  readonly roleHash: string;
}

export interface ReaderWindowEntry {
  readonly chapter: number;
  readonly body: string;
  readonly note: string;
}

const sha = (text: string): string => createHash("sha256").update(text, "utf-8").digest("hex").slice(0, 16);

const chapterFile = (projectDir: string, chapter: number): string =>
  join(projectDir, "chapters", `${String(chapter).padStart(4, "0")}.md`);

const notesDir = (root: string, roleId: string): string => join(root, "agents", roleId, "notes");

const noteFile = (root: string, roleId: string, chapter: number): string =>
  join(notesDir(root, roleId), `${String(chapter).padStart(4, "0")}.json`);

const roleHashOf = (role: ReaderRole): string => sha(`${role.system}\n\n${role.noteTask}`);

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
async function writeNote(projectDir: string, root: string, roleId: string, file: NoteFile): Promise<void> {
  await stat(projectDir); // 书已删就别再写（免得建出幽灵目录）
  const path = noteFile(root, roleId, file.chapter);
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf-8");
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 作废第 fromChapter 章起（含）往后的全部笔记，包括超出这次要读到的章号的。 */
async function removeNotesFrom(root: string, roleId: string, fromChapter: number): Promise<void> {
  const files = await readdir(notesDir(root, roleId)).catch(() => [] as string[]);
  for (const file of files) {
    const match = /^(\d{4})\.json$/u.exec(file);
    if (match && Number(match[1]) >= fromChapter) await rm(join(notesDir(root, roleId), file), { force: true });
  }
}

const readUserContent = (role: ReaderRole, chapter: number, body: string): string =>
  `【第 ${chapter} 章 定稿原文】\n${body}\n\n${role.noteTask}`;

const foldedUserContent = (chapter: number): string => `【第 ${chapter} 章（原文已省略，见你当时的笔记）】`;

/**
 * 拼窗口：[system] + 每章两条（user＝定稿原文 + 记笔记要求；assistant＝笔记）。entries 必须是从第 1 章起连续的。
 * 超预算就从第 1 章起按每 FOLD_BLOCK_CHAPTERS 章一块把原文折掉、只留笔记，折到不超为止
 * （整块折完还超，才再一章一章折）。写笔记时的窗口和之后核账时的窗口都用这个函数拼，所以前缀逐字一样。
 */
export function assembleReaderWindow(
  role: ReaderRole,
  entries: readonly ReaderWindowEntry[],
  maxChars: number = READER_WINDOW_MAX_CHARS,
): BrainMessage[] {
  const fullSizes = entries.map((entry) => readUserContent(role, entry.chapter, entry.body).length);
  const saved = entries.map((entry, index) => fullSizes[index]! - foldedUserContent(entry.chapter).length);
  let total = role.system.length + fullSizes.reduce((sum, size) => sum + size, 0) + entries.reduce((sum, entry) => sum + entry.note.length, 0);
  let folded = 0;
  while (total > maxChars && folded < entries.length) {
    const next = folded + FOLD_BLOCK_CHAPTERS <= entries.length ? folded + FOLD_BLOCK_CHAPTERS : folded + 1;
    for (let index = folded; index < next; index += 1) total -= saved[index]!;
    folded = next;
  }
  const messages: BrainMessage[] = [{ role: "system", content: role.system }];
  entries.forEach((entry, index) => {
    messages.push(
      { role: "user", content: index < folded ? foldedUserContent(entry.chapter) : readUserContent(role, entry.chapter, entry.body) },
      { role: "assistant", content: entry.note },
    );
  });
  return messages;
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

export interface EnsuredReaderWindow {
  /** 读完第 upTo 章那一刻的窗口；maxCatchUp 触发（missing > 0）时为空。 */
  readonly messages: BrainMessage[];
  /** 这次新写的笔记数。 */
  readonly built: number;
  /** 直接复用的笔记数。 */
  readonly reused: number;
  /** 需要新写但这次没写的笔记数（超过 maxCatchUp）。 */
  readonly missing: number;
}

/**
 * 确保专员读到了第 upTo 章：第 1..upTo 章每章的笔记都在、且对得上当前定稿正文，缺的按顺序补写。
 * 第一个对不上（或缺失）的章起往后的笔记全部作废重写。某章定稿读不到就停在它前一章（不报错）。
 * 补笔记的模型调用失败照实抛出——已写下的笔记留着，下次接着补。
 */
export async function ensureReaderWindow(input: {
  readonly projectDir: string;
  readonly role: ReaderRole;
  readonly upTo: number;
  readonly callModel: BrainCallModel;
  /** 笔记存放的根目录；缺省就是书目录（评测时传临时目录，不动书）。 */
  readonly notesRoot?: string;
  /** 需要新写的笔记超过这个数就不写了，直接返回 missing > 0（调用方改走旧路，并在后台补）。缺省不限。 */
  readonly maxCatchUp?: number;
  /** 窗口字数预算；缺省 READER_WINDOW_MAX_CHARS（测试用小值）。 */
  readonly maxChars?: number;
  readonly onProgress?: (chapter: number) => void;
}): Promise<EnsuredReaderWindow> {
  const root = input.notesRoot ?? input.projectDir;
  const maxChars = input.maxChars ?? READER_WINDOW_MAX_CHARS;
  const inspect = () => inspectNotes({ projectDir: input.projectDir, root, role: input.role, upTo: input.upTo });
  const notReady = (state: NotesState): EnsuredReaderWindow =>
    ({ messages: [], built: 0, reused: state.valid.length, missing: state.upTo - state.valid.length });
  const tooMany = (state: NotesState): boolean => input.maxCatchUp !== undefined && state.upTo - state.valid.length > input.maxCatchUp;

  if (input.maxCatchUp !== undefined) {
    // 进队前先看一眼：要补的太多就马上说没准备好，别排在后台补笔记的长队后面干等。
    const peek = await inspect();
    if (tooMany(peek)) return notReady(peek);
  }
  return withCatchUpLock(`${root}\u0000${input.role.id}`, async () => {
    const state = await inspect();
    if (tooMany(state)) return notReady(state);
    const entries = [...state.valid];
    const firstStale = entries.length + 1;
    if (firstStale <= state.upTo) await removeNotesFrom(root, input.role.id, firstStale);
    const roleHash = roleHashOf(input.role);
    for (let chapter = firstStale; chapter <= state.upTo; chapter += 1) {
      const body = state.bodies[chapter - 1]!;
      const note = (await input.callModel(
        [...assembleReaderWindow(input.role, entries, maxChars), { role: "user", content: readUserContent(input.role, chapter, body) }],
        { json: false },
      )).trim();
      if (!note) throw new Error(`第 ${chapter} 章的读书笔记是空的`);
      await writeNote(input.projectDir, root, input.role.id, { chapter, textHash: sha(body), note, createdAt: new Date().toISOString(), roleHash });
      entries.push({ chapter, body, note });
      input.onProgress?.(chapter);
    }
    return { messages: assembleReaderWindow(input.role, entries, maxChars), built: entries.length - state.valid.length, reused: state.valid.length, missing: 0 };
  });
}
