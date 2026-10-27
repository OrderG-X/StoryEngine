// @vitest-environment node
//
// 定稿两步（重构 P3 起走新核心）：commit_preview 出清单 + 票 → 作者点「确认定稿」→ commit_apply 照票定稿。
// 模型用假的：要笔记交笔记、要账单交给定的那份；定稿后的编辑部预热 mock 掉，不连网。
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createStoryProject } from "../../book/project-store.js";
import { cardWrite, projectBook, readCards, readChapterLedger, readHead, runCommand } from "@actalk/story-core";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BrainCallModel } from "../../editorial/reader-window.js";
import { MIRROR_FILES } from "../../book/mirror/build.js";
import { MIRROR_BACKUP_DIR } from "../../book/mirror/sync.js";
import { makeHomeTempDir } from "../../lib/home-test-tmp.js";
import { listSnapshots, restoreSnapshot } from "../../lib/snapshot.js";
import { buildProjectRequestContext, markUserConfirmedTool } from "../request-context.js";
import { commitApplyTool, openThreadsHintDue } from "./commit-apply.js";
import { buildCommitPreviewToolOutput, commitPreviewTool, OPT_IN_PREFIX } from "./commit-preview.js";

const warmUpReadersMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../editorial/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../editorial/index.js")>()),
  warmUpReaders: warmUpReadersMock,
}));

type ToolExec = (input: Record<string, unknown>, context: ToolExecutionContext) => Promise<unknown>;
const applyExecute = commitApplyTool.execute as unknown as ToolExec;
const previewExecute = commitPreviewTool.execute as unknown as ToolExec;

interface ApplyOut {
  readonly ok: boolean;
  readonly committed: boolean;
  readonly refused: boolean;
  readonly snapshotId?: string;
  readonly blockedReason?: string;
  readonly needsConfirmation?: boolean;
  readonly confirmAction?: { toolName: string; chapter: number; previewToken?: string };
  readonly report?: { chapter: number; ledger: Record<string, number> };
  readonly draftBody?: string;
  readonly draftTitle?: string;
  readonly summary: string;
}

let root: string;
let book: string;
beforeEach(async () => {
  warmUpReadersMock.mockClear();
  root = await makeHomeTempDir("commit-chain-");
  ({ projectDir: book } = await createStoryProject({ rootDir: root, title: "钟楼", genre: "悬疑", logline: "钟停了。", protagonistName: "林远" }));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const FILLER = "林远在钟楼里来回踱步，反复掂量手里那把钥匙的分量，盘算着接下来每一步该怎么走。".repeat(10);
const CH1 = `# 第1章 · 钟停\n\n周二傍晚，钟停在三点十五分。林远推开钟楼的门，老周没有拦他。\n\n他在钟箱里摸到一把铜钥匙，揣进了包里。钟为什么偏偏停在这个时刻？\n\n${FILLER}\n`;
const CH2 = `# 第2章 · 四点\n\n第二天上午，钟楼的钟停在四点整。老周站在门口，没让外人进。\n\n林远把钥匙锁进铜盒。他终于明白了，钟是被人故意拨停的。\n\n${FILLER}\n`;

const LEDGER1 = {
  summary: { text: "林远进钟楼拿走钥匙", quote: "他在钟箱里摸到一把铜钥匙" },
  time: { basis: "text", weekday: "周二", timeOfDay: "傍晚", quote: "周二傍晚" },
  presence: [
    { name: "林远", nameUsed: "林远", viewpoint: true, quote: "林远推开钟楼的门" },
    { name: "周守义", nameUsed: "老周", quote: "老周没有拦他" },
  ],
  facts: [
    { nature: "state", subject: "铜钥匙", attribute: "在哪", value: "林远包里", text: "铜钥匙在林远包里", quote: "揣进了包里" },
    { nature: "hard", subject: "钟", attribute: "停的时刻", value: "三点十五分", text: "钟停在三点十五分", quote: "钟停在三点十五分" },
  ],
  threads: [{ op: "open", type: "question", title: "钟为什么停", note: "钟停在三点十五分", quote: "钟为什么偏偏停在这个时刻" }],
};
const LEDGER2 = {
  summary: { text: "林远锁好钥匙，明白钟是被拨停的", quote: "林远把钥匙锁进铜盒" },
  time: { basis: "text", daysSincePrevious: 1, timeOfDay: "上午", quote: "第二天上午" },
  presence: [{ name: "林远", nameUsed: "林远", viewpoint: true, quote: "林远把钥匙锁进铜盒" }, { name: "周守义", nameUsed: "老周", quote: "老周站在门口" }],
  facts: [
    { nature: "state", subject: "铜钥匙", attribute: "在哪", value: "铜盒里", text: "铜钥匙锁在铜盒里", quote: "林远把钥匙锁进铜盒" },
    { nature: "hard", subject: "钟", attribute: "停的时刻", value: "四点整", text: "钟停在四点整", quote: "钟楼的钟停在四点整" },
  ],
  threads: [{ op: "close", thread: "T1", note: "钟是被人故意拨停的", quote: "钟是被人故意拨停的" }],
};

function fakeModel(ledger: unknown): BrainCallModel {
  return async (messages) => {
    const last = messages.at(-1)?.content ?? "";
    return last.includes("交这一章的账单") ? JSON.stringify(ledger) : "笔记：老周＝周守义。";
  };
}

async function writeDraft(chapter: number, text: string): Promise<void> {
  await mkdir(join(book, "drafts", "fast"), { recursive: true });
  await writeFile(join(book, "drafts", "fast", `chapter-${String(chapter).padStart(4, "0")}.md`), text, "utf-8");
}

function modelContext(chapter?: number): ToolExecutionContext {
  return { requestContext: buildProjectRequestContext(book, chapter) } as unknown as ToolExecutionContext;
}

/** 作者点了「确认定稿」按钮的执行上下文（结构化动作通道设的标记）——只有它才真写盘。 */
function buttonContext(chapter?: number): ToolExecutionContext {
  const requestContext = buildProjectRequestContext(book, chapter);
  markUserConfirmedTool(requestContext, "commit_apply");
  return { requestContext } as unknown as ToolExecutionContext;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

describe("commit_preview", () => {
  it("没有工作稿 / 太短：canCommit=false，不发票，原因是人话、不带路径", async () => {
    const missing = await buildCommitPreviewToolOutput({ projectDir: book, chapter: 1, callModel: fakeModel(LEDGER1) });
    expect(missing).toMatchObject({ ok: false, canCommit: false, notRecorded: [] });
    expect(missing.previewToken).toBeUndefined();
    expect(missing.summary).toContain("还没有工作稿");
    expect(missing.summary).not.toContain(book);

    await writeDraft(1, "# 第1章\n\n钟停了。\n");
    const short = await buildCommitPreviewToolOutput({ projectDir: book, chapter: 1, callModel: fakeModel(LEDGER1) });
    expect(short.canCommit).toBe(false);
    expect(short.draftQualityIssues.map((issue) => issue.type)).toContain("too_short");
    expect(short.blockingReasons.join("")).toContain("下限");
    // 下限是作者自己的写作规则：这章就该这么短，作者点按钮放这一章（作者长篇实跑 2026-10-26：原来只能去改全书下限）。
    expect(short.blockingReasons.join("")).toContain("「就这么短，照样定稿」");
    expect(short.shortOnly).toBe(true);
    expect(short.previewToken).toBeUndefined();
  });

  it("合格草稿：天数一行在最前，要看的标 needsConfirm，自动记的随后；摘要不带工具名和编号", async () => {
    await writeDraft(1, CH1);
    const out = await buildCommitPreviewToolOutput({ projectDir: book, chapter: 1, callModel: fakeModel(LEDGER1) });
    expect(out).toMatchObject({ ok: true, canCommit: true, notRecorded: [] });
    expect(out.previewToken).toMatch(/^[0-9a-f]{16,}$/u);
    const list = out.ledgerChecklist ?? [];
    expect(list[0]).toMatchObject({ id: "day", kind: "time", editableDay: 1, removable: false, detail: "周二傍晚" });
    expect(list[0]?.label).toContain("故事第 1 天");
    // 星期按 0=周一 存（记账员、时间线同口径）；预览曾按 0=周日显示，「周二」变「星期一」（真机试写）。
    expect(list[0]?.label).toContain("周二");
    const reviewed = list.filter((item) => item.needsConfirm);
    expect(reviewed.map((item) => item.label)).toEqual([expect.stringContaining("周守义")]);
    expect(list.filter((item) => item.kind === "fact")).toHaveLength(2);
    expect(out.summary).toBe("第 1 章可以定稿：要你看 1 条，其余 5 条自动记下（不对的都能去掉）。");
    expect(JSON.stringify(out.summary)).not.toMatch(/commit_apply|c1-|t1-/u);
    // 要看的是哪几条点名给模型，免得转述成别的（换题材长篇实跑 2026-10-27）。
    expect(out.modelHint).toContain(`要作者看的就是这几条（别说成别的）：${reviewed[0]?.label}。`);
  });

  it("第 1 章正文没写时间：天数说「先这么记」，不提没有的上一章（2026-10-23 桌面包走查）", async () => {
    await writeDraft(1, CH1);
    const { time: _time, ...noTime } = LEDGER1;
    const out = await buildCommitPreviewToolOutput({ projectDir: book, chapter: 1, callModel: fakeModel(noTime) });
    const day = (out.ledgerChecklist ?? [])[0];
    expect(day?.label).toContain("故事第 1 天");
    expect(day?.label).toContain("先这么记");
    expect(day?.label).not.toContain("上一章");
  });

  it("工具入口：不传章号用前端带的当前章；都没有就如实报缺章号", async () => {
    await expect(previewExecute({}, modelContext())).rejects.toThrow("缺少章号");
    const out = (await previewExecute({}, modelContext(1))) as { chapter: number; canCommit: boolean };
    expect(out).toMatchObject({ chapter: 1, canCommit: false });
  });
});

describe("commit_apply", () => {
  it("模型发起：没预览如实拒；有预览只出确认按钮，不写盘、不存档；稿改过如实拒", async () => {
    await writeDraft(1, CH1);
    const noPreview = (await applyExecute({ chapter: 1 }, modelContext(1))) as ApplyOut;
    expect(noPreview).toMatchObject({ committed: false, blockedReason: "no_preview" });
    expect(noPreview.confirmAction).toBeUndefined();

    const preview = await buildCommitPreviewToolOutput({ projectDir: book, chapter: 1, callModel: fakeModel(LEDGER1) });
    const before = (await listSnapshots(book)).length;
    const asked = (await applyExecute({}, modelContext(1))) as ApplyOut;
    expect(asked).toMatchObject({ ok: false, committed: false, needsConfirmation: true, blockedReason: "awaiting_user_confirmation" });
    expect(asked.confirmAction).toEqual({ toolName: "commit_apply", chapter: 1, previewToken: preview.previewToken });
    expect(asked.summary).toContain("确认定稿");
    expect(await exists(join(book, "chapters", "0001.md"))).toBe(false);
    expect(await listSnapshots(book)).toHaveLength(before);

    await writeDraft(1, `${CH1}林远又补了一句。\n`);
    const changed = (await applyExecute({ chapter: 1 }, modelContext(1))) as ApplyOut;
    expect(changed).toMatchObject({ committed: false, blockedReason: "draft_changed_since_preview" });
  });

  it("作者点确认：去掉的不记；写正文 + 账单 + 老格式镜像；后台预热；再点一次不重复写", async () => {
    // 建书时写了设定卡（主角卡）：书的版本号从 1 起。
    const base = (await readHead(book)).version;
    await writeDraft(1, CH1);
    const preview = await buildCommitPreviewToolOutput({ projectDir: book, chapter: 1, callModel: fakeModel(LEDGER1) });
    const stranger = preview.ledgerChecklist?.find((item) => item.needsConfirm && item.label.includes("周守义"));
    const out = (await applyExecute(
      { chapter: 1, previewToken: preview.previewToken, excluded: [stranger?.id, "day"], dayOverride: 3 },
      buttonContext(1),
    )) as ApplyOut;

    expect(out).toMatchObject({ ok: true, committed: true, draftTitle: "第1章 · 钟停" });
    expect(out.snapshotId).toMatch(/^[0-9a-f]{40}$/u);
    expect(out.report).toMatchObject({ chapter: 1, ledger: { facts: 2, threadsOpened: 1, threadsClosed: 0, present: 1, day: 3, notRecorded: 0 } });
    expect(out.draftBody?.startsWith("周二傍晚")).toBe(true);
    expect(out.summary).toContain("第 1 章已定稿");
    expect(await readFile(join(book, "chapters", "0001.md"), "utf-8")).toBe(CH1);
    const view = await projectBook(book);
    expect(view.chapters[0]).toMatchObject({ day: 3, dayBasis: "author", present: ["林远"] });
    expect(await exists(join(book, ".story-core-mirror.json"))).toBe(true);
    expect(warmUpReadersMock).toHaveBeenCalledWith(book, 1);

    const again = (await applyExecute({ chapter: 1, previewToken: preview.previewToken, excluded: [stranger?.id] }, buttonContext(1))) as ApplyOut;
    expect(again).toMatchObject({ ok: true, committed: true });
    expect(again.summary).toContain("已经定稿过了");
    expect(await readHead(book)).toMatchObject({ version: base + 1 });
  });

  it("字数下限后来才定、这章原来就短：改了再定稿不挡，提醒一句；原来够数的照样挡（作者长篇实跑 2026-10-26）", async () => {
    await writeDraft(1, CH1);
    const first = await buildCommitPreviewToolOutput({ projectDir: book, chapter: 1, callModel: fakeModel(LEDGER1) });
    await applyExecute({ chapter: 1, previewToken: first.previewToken }, buttonContext(1));
    await runCommand(book, cardWrite, { ops: [{ op: "rules.set", field: "minWords", value: 2000 }] }, { caller: "author", idempotencyKey: "min-2000" });

    await writeDraft(1, CH1.replace("老周没有拦他。", "老周没拦他。"));
    const again = await buildCommitPreviewToolOutput({ projectDir: book, chapter: 1, callModel: fakeModel(LEDGER1) });
    expect(again.canCommit).toBe(true);
    expect(again.notes).toContain("这章原来定稿时就不到 2000 字，字数下限这次不挡");

    // 新的一章照样按下限挡。
    await writeDraft(2, CH2);
    const fresh = await buildCommitPreviewToolOutput({ projectDir: book, chapter: 2, callModel: fakeModel(LEDGER2) });
    expect(fresh.canCommit).toBe(false);
    expect(fresh.draftQualityIssues.map((issue) => issue.type)).toContain("too_short");
    // 作者点了「就这么短，照样定稿」：只放这一章，清单里说一句。
    const allowed = await buildCommitPreviewToolOutput({ projectDir: book, chapter: 2, callModel: fakeModel(LEDGER2), allowShort: true });
    expect(allowed.canCommit).toBe(true);
    expect(allowed.notes?.some((note) => note.includes("你点了照样定稿，只这一章"))).toBe(true);
    // 模型自己调（没有作者按钮的确认标记）照挡。
    const byModel = (await previewExecute({ chapter: 2 }, modelContext(2))) as { canCommit: boolean; shortOnly?: boolean };
    expect(byModel).toMatchObject({ canCommit: false, shortOnly: true });
  });

  it("重定稿记账员看错天数：天数那行照上次定稿、说清这次看成第几天，算一条要你看（作者长篇实跑 2026-10-27）", async () => {
    await writeDraft(1, CH1);
    const first = await buildCommitPreviewToolOutput({ projectDir: book, chapter: 1, callModel: fakeModel(LEDGER1) });
    await applyExecute({ chapter: 1, previewToken: first.previewToken }, buttonContext(1));
    await writeDraft(2, CH2);
    const ch2 = await buildCommitPreviewToolOutput({ projectDir: book, chapter: 2, callModel: fakeModel(LEDGER2) });
    await applyExecute({ chapter: 2, previewToken: ch2.previewToken }, buttonContext(2));

    await writeDraft(2, CH2.replace("没让外人进", "没让外人进门"));
    const wrongDay = { ...LEDGER2, time: { basis: "judged", daysSincePrevious: 0, timeOfDay: "上午", quote: "林远把钥匙锁进铜盒" } };
    const again = await buildCommitPreviewToolOutput({ projectDir: book, chapter: 2, callModel: fakeModel(wrongDay) });
    const day = again.ledgerChecklist?.[0];
    expect(day).toMatchObject({ id: "day", editableDay: 2, needsConfirm: true, detail: "第二天上午" });
    expect(day?.label).toBe("这一章记为故事第 2 天（上午，周三）（照上次定稿）");
    expect(day?.reason).toBe("记账员这次看成第 1 天，和上次定稿不一样；先照上次的记，不对就改天数");
    expect(again.summary).toContain("要你看");
  });

  it("票号没了 / 乱填：如实拒、不定稿", async () => {
    const base = (await readHead(book)).version;
    await writeDraft(1, CH1);
    const out = (await applyExecute({ chapter: 1, previewToken: "0123456789abcdef" }, buttonContext(1))) as ApplyOut;
    expect(out).toMatchObject({ ok: false, committed: false, refused: true, blockedReason: "no_preview" });
    expect(await readHead(book)).toMatchObject({ version: base });
    expect(await readChapterLedger(book, 1)).toBeUndefined();
  });

  it("和前文不会变的事实对不上：默认不记、作者勾上才记；撤销后重新预览能再定稿", async () => {
    const base = (await readHead(book)).version;
    await writeDraft(1, CH1);
    const first = await buildCommitPreviewToolOutput({ projectDir: book, chapter: 1, callModel: fakeModel(LEDGER1) });
    await applyExecute({ chapter: 1, previewToken: first.previewToken }, buttonContext(1));

    await writeDraft(2, CH2);
    const preview = await buildCommitPreviewToolOutput({ projectDir: book, chapter: 2, callModel: fakeModel(LEDGER2) });
    const conflict = preview.ledgerChecklist?.find((item) => item.id.startsWith(OPT_IN_PREFIX));
    expect(conflict).toMatchObject({ kind: "fact", defaultUnchecked: true, needsConfirm: true });
    expect(conflict?.label).toContain("四点整");
    expect(preview.ledgerChecklist?.find((item) => item.kind === "thread")?.needsConfirm).toBe(true);

    const skipped = (await applyExecute({ chapter: 2, previewToken: preview.previewToken }, buttonContext(2))) as ApplyOut;
    expect(skipped.report?.ledger.facts).toBe(1);
    expect(skipped.report?.ledger.threadsClosed).toBe(1);
    const ledger = await readChapterLedger(book, 2);
    expect(ledger?.entries.some((entry) => entry.kind === "fact" && entry.text === "钟停在四点整")).toBe(false);

    const restored = await restoreSnapshot(book, skipped.snapshotId ?? "");
    expect(restored).toBeTruthy();
    expect(await readHead(book)).toMatchObject({ version: base + 1 });
    expect(await exists(join(book, "chapters", "0002.md"))).toBe(false);

    const again = await buildCommitPreviewToolOutput({ projectDir: book, chapter: 2, callModel: fakeModel(LEDGER2) });
    const optIn = again.ledgerChecklist?.find((item) => item.id.startsWith(OPT_IN_PREFIX));
    const taken = (await applyExecute({ chapter: 2, previewToken: again.previewToken, excluded: [optIn?.id] }, buttonContext(2))) as ApplyOut;
    expect(taken).toMatchObject({ ok: true, committed: true });
    expect(taken.report?.ledger.facts).toBe(2);
    expect((await projectBook(book)).conflicts).toHaveLength(1);
  });

  it("老书（有定稿章、没账单、没设定卡）第一次预览：先存档、导入账单、搬老设定，老文件不动", async () => {
    // 重构 P9 以前的书：只有老格式文件（老设定、老账本），没有 ledger/。
    book = join(root, "old-book");
    await mkdir(join(book, "chapters"), { recursive: true });
    await mkdir(join(book, "story"), { recursive: true });
    await mkdir(join(book, "timeline"), { recursive: true });
    const at = "2026-10-01T00:00:00.000Z";
    await writeFile(join(book, "project.json"), JSON.stringify({ id: "old-book", title: "钟楼", createdAt: at, updatedAt: at }), "utf-8");
    await writeFile(join(book, "chapters", "0001.md"), CH1, "utf-8");
    await writeFile(join(book, "story", "character-bible.json"), JSON.stringify({
      version: "v0",
      characters: [{ id: "char-a", name: "林远", role: "主角", identity: "钟表匠" }],
    }), "utf-8");
    await writeFile(join(book, "story", "hooks.json"), JSON.stringify({ hooks: [] }), "utf-8");
    await writeFile(join(book, "timeline", "events.json"), "[]\n", "utf-8");
    const bibleBefore = await readFile(join(book, "story", "character-bible.json"), "utf-8");
    const mirrored = new Map<string, string>();
    for (const file of Object.values(MIRROR_FILES)) {
      const content = await readFile(join(book, file), "utf-8").catch(() => undefined);
      if (content !== undefined) mirrored.set(file, content);
    }
    expect(mirrored.size).toBeGreaterThan(0);
    await writeDraft(2, CH2);
    const out = await buildCommitPreviewToolOutput({ projectDir: book, chapter: 2, callModel: fakeModel({ ...LEDGER2, threads: [] }) });
    expect(out.canCommit).toBe(true);
    expect((await projectBook(book)).chapters[0]?.origin).toBe("import");
    expect((await listSnapshots(book)).length).toBeGreaterThan(0);
    // 老设定搬进了设定卡（主角认出来了）；老设定文件一字不动。
    expect((await readCards(book))?.cards).toEqual([expect.objectContaining({ name: "林远", protagonist: true })]);
    expect(await readFile(join(book, "story", "character-bible.json"), "utf-8")).toBe(bibleBefore);
    // 镜像要重生成的老文件，第一次生成前原样留了一份。
    for (const [file, content] of mirrored) {
      expect(await readFile(join(book, MIRROR_BACKUP_DIR, file), "utf-8")).toBe(content);
    }
  });
});

describe("openThreadsHintDue：开着的线索跨过一档才提「归并线索」", () => {
  it("到 20 提一次；停在 20 多不再念；到 25、30 再提；变少不提", () => {
    expect(openThreadsHintDue(19, 20)).toBe(true);
    expect(openThreadsHintDue(18, 22)).toBe(true);
    expect(openThreadsHintDue(20, 20)).toBe(false);
    expect(openThreadsHintDue(20, 21)).toBe(false);
    expect(openThreadsHintDue(24, 25)).toBe(true);
    expect(openThreadsHintDue(29, 31)).toBe(true);
    expect(openThreadsHintDue(26, 24)).toBe(false);
    expect(openThreadsHintDue(10, 15)).toBe(false);
  });
});
