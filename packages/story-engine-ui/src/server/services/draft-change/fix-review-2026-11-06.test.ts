// @vitest-environment node
/**
 * 外部审查（2026-11-06，0.4.1 + 0.4.2 两轮）报的 8 条：改掉、改完再核、本章前后、核账记忆、记东西。
 * 每条先复现原来的错，再按修好的样子断言（探针出自审查者，这里改成回归用例）。
 */
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { draftSave, readDraft, readDraftState, runCommand } from "@actalk/story-core";
import { createStoryProject } from "../../book/project-store.js";
import { makeHomeTempDir } from "../../lib/home-test-tmp.js";
import { appendFixLog, readFixLog } from "../../lib/fix-log.js";
import { __resetExecutionsForTests } from "../../lib/operations/context.js";
import { __resetLiveForTests } from "../../lib/operations/live.js";
import { __resetOperationStoreForTests } from "../../lib/operations/store.js";
import { __drainOperationsForTests, __resetRecipesForTests } from "../operations/executor.js";
import { fakeDraftDeps, runDraftChange, runDraftEdit, writerOf } from "../operations/recipes/draft-change-kit.js";
import { undoInOperation } from "../operations/test-helpers.js";
import { checkChapterBody, readCheckInputs } from "../../editorial/continuity/check-service.js";
import { hashBody, readCheckMemory, writeCheckMemory } from "../../editorial/continuity/check-memory.js";
import { parseInnerPairs } from "../../editorial/checker.js";
import { fixByUnits } from "../unit-fix.js";
import { parseKeeperOutput } from "../../editorial/keeper-parse.js";
import type { BrainCallModel } from "../../editorial/reader-window.js";

let root: string;
let book: string;
beforeEach(async () => {
  __resetOperationStoreForTests();
  __resetExecutionsForTests();
  __resetLiveForTests();
  __resetRecipesForTests();
  root = await makeHomeTempDir("fix-review-");
  vi.stubEnv("SE_DATA_DIR", join(root, "data"));
  ({ projectDir: book } = await createStoryProject({ rootDir: root, title: "审查回归书", genre: "都市", protagonistName: "林远" }));
});
afterEach(async () => {
  await __drainOperationsForTests();
  __resetRecipesForTests();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function save(body: string): Promise<void> {
  const baseVersion = (await readDraftState(book, 1)).version;
  expect(await runCommand(book, draftSave, { chapter: 1, body, baseVersion, title: "" }, { caller: "author" })).toMatchObject({ ok: true });
}
const emptyReply = JSON.stringify({ checks: [], contradictions: [], pairs: [] });
const reviews = (last: string, verdict = "sure"): string => JSON.stringify({ verdicts: [...last.matchAll(/【(K\d+)】/gu)].map((m) => ({ id: m[1], verdict })) });
const fixes = (id: number, to: string, target?: number): string => JSON.stringify({ edits: [{ id, to, ...(target ? { for: target } : {}) }] });
const INNER = "只找这一章自己前后打架";
const REVIEW = "你刚才核完报了";

describe("外部审查 2026-11-06：改掉 / 改完再核", () => {
  it("再核有一步没跑成：不说「没有对不上的了」，不推荐当干净的定稿", async () => {
    const original = "钟停在三点。窗外仍是下午。";
    await save(original);
    const reader: BrainCallModel = async (messages, options) => {
      if (!options.json) return "笔记。";
      const last = messages.at(-1)!.content;
      if (last.includes(REVIEW)) return reviews(last, "maybe");
      if (last.includes(INNER)) throw new Error("服务商 502");
      if (last.includes("这一遍只盯时间和信息")) return JSON.stringify({ checks: [], contradictions: [{ quote: "钟停在四点。", earlierQuote: "窗外仍是下午。", earlierChapter: 1, confidence: "maybe", reason: "拿不准时刻" }] });
      return emptyReply;
    };
    const result = await runDraftEdit(book, "fix", { chapter: 1, fixes: [{ targetText: "钟停在三点。", revisionGoal: "把时刻改成四点" }] }, fakeDraftDeps({ fixCallModel: async () => fixes(1, "钟停在四点。"), readerCallModel: reader }));
    expect(result.record.state).toBe("succeeded");
    expect(result.body?.verify).toMatchObject({ checks: 1, again: 0 });
    expect(result.body?.verify?.partial).toBeTruthy();
    expect(result.summary).toContain("有一步没核成");
    expect(result.summary).not.toContain("没有对不上的了");
  });

  it("两轮改的字一样、位置不同：各记各的，两轮都落盘", async () => {
    const original = "钟停在三点。老周看了一眼。钟停在四点。老周转过身。后面那只钟始终停在三点。";
    await save(original);
    let calls = 0;
    const repair = async (): Promise<string> => (++calls === 1 ? fixes(1, "钟停在四点。") : fixes(3, "钟停在三点。"));
    const reader: BrainCallModel = async (messages, options) => {
      if (!options.json) return "笔记。";
      const last = messages.at(-1)!.content;
      if (last.includes(REVIEW)) return reviews(last);
      if (last.includes(INNER)) return emptyReply;
      const body = last.split("【新稿：第 1 章】\n")[1]?.split("\n\n")[0] ?? "";
      if (body.startsWith("钟停在四点。老周看了一眼。钟停在四点。")) {
        return JSON.stringify({ checks: [], contradictions: [{ quote: "钟停在四点。", earlierQuote: "后面那只钟始终停在三点。", earlierChapter: 1, confidence: "sure", reason: "第二只钟应停在三点" }] });
      }
      return emptyReply;
    };
    const result = await runDraftEdit(book, "fix", { chapter: 1, fixes: [{ targetText: "钟停在三点。", revisionGoal: "第一只钟应停在四点" }] }, fakeDraftDeps({ fixCallModel: repair, readerCallModel: reader }));
    expect(calls).toBe(2);
    expect(result.record.state).toBe("succeeded");
    expect((await readDraft(book, 1))?.body).toBe("钟停在四点。老周看了一眼。钟停在三点。老周转过身。后面那只钟始终停在三点。");
  });

  it("点名时给的是句里一段：改在别处的旧问题照样交核账员复核", async () => {
    const original = "广播宣布现在是四点。老周说两个钟都是准的。墙上的钟指向三点。";
    const oldIssue = { quote: "老周说两个钟都是准的。", earlierQuote: "广播宣布现在是四点。", earlierChapter: 1, kind: "event" as const, confidence: "sure" as const, reason: "钟表和广播报时对不上" };
    await save(original);
    const { earlierHash } = await readCheckInputs(book, 1);
    await writeCheckMemory(book, { chapter: 1, body: original, bodyHash: hashBody(original), earlierHash: earlierHash!, issues: [oldIssue] });
    let reviewCalls = 0;
    const reader: BrainCallModel = async (messages, options) => {
      if (!options.json) return "笔记。";
      const last = messages.at(-1)!.content;
      if (last.includes(REVIEW)) { reviewCalls += 1; return reviews(last, "no"); }
      return emptyReply;
    };
    const result = await runDraftEdit(book, "fix", { chapter: 1, fixes: [{ targetText: "两个钟都是准的", revisionGoal: "广播是四点，修正墙上的钟" }] }, fakeDraftDeps({ fixCallModel: async () => fixes(3, "墙上的钟指向四点。"), readerCallModel: reader }));
    expect((await readDraft(book, 1))?.body).toBe(original.replace("三点", "四点"));
    expect(reviewCalls).toBeGreaterThan(0);
    expect(result.body?.verify?.left?.sure ?? []).toEqual([]);
  });

  it("一处都没改成：标不出为哪处改的别的句子也不换", async () => {
    const text = "钟停在三点。墙上写着四点。老周正好路过。";
    const result = await fixByUnits({ chapter: 1, text, fixes: [{ quote: "钟停在三点。", goal: "时间统一为四点" }, { quote: "墙上写着四点。", goal: "核对墙上的时间" }], callModel: async () => fixes(3, "老周已经离开。", 999) });
    expect(result.applied).toEqual([]);
    expect(result.failed).toHaveLength(2);
    expect(result.text).toBe(text);
    expect(result.changes).toEqual([]);
  });

  it("出稿按核账改一处没改成：正文不换，核账记忆就是落盘那版", async () => {
    const text = "钟停在三点。老周今年十八岁。老周正好路过。通知写明钟应是四点。名册写着老周十九岁。\n\n"
      + Array(8).fill("林远沿着河岸走了很久，手里的账册越攥越紧。他还记得早上的约定，却不知道对方为什么迟迟没有露面。巷子尽头有人推开门，朝他招了招手。").join("\n\n");
    const reader: BrainCallModel = async (messages, options) => {
      if (!options.json) return "笔记。";
      const last = messages.at(-1)!.content;
      if (last.includes(REVIEW)) return reviews(last);
      if (last.includes("这一遍只盯东西")) {
        return JSON.stringify({ checks: [], contradictions: [
          { quote: "钟停在三点。", earlierQuote: "通知写明钟应是四点。", earlierChapter: 1, confidence: "sure", reason: "钟的时刻不对" },
          { quote: "老周今年十八岁。", earlierQuote: "名册写着老周十九岁。", earlierChapter: 1, confidence: "sure", reason: "年龄不对" },
        ] });
      }
      return emptyReply;
    };
    const result = await runDraftChange(book, "write", { chapter: 1, length: 300, autoDeAi: false }, fakeDraftDeps({ writerClient: writerOf(text), readerCallModel: reader, fixCallModel: async () => fixes(3, "老周已经离开。", 999) }));
    expect(result.record.state).toBe("succeeded");
    const stored = (await readDraft(book, 1))?.body ?? "";
    expect(stored).not.toContain("老周已经离开。");
    const memory = await readCheckMemory(book, 1);
    expect(memory?.bodyHash).toBe(hashBody(stored));
  });

  it("以前改过又被报回来的：第二轮不替作者改回去，留在卡上", async () => {
    const original = "钟停在四点。老周指着钟说现在是五点。";
    await save(original);
    await appendFixLog(book, 1, [{ from: "钟停在三点。", to: "钟停在四点。" }]);
    const prompts: string[] = [];
    const reader: BrainCallModel = async (messages, options) => {
      if (!options.json) return "笔记。";
      const last = messages.at(-1)!.content;
      if (last.includes(REVIEW)) return reviews(last);
      if (!last.includes(INNER)) return JSON.stringify({ checks: [], contradictions: [{ quote: "钟停在四点。", earlierQuote: "老周指着钟说现在是三点。", earlierChapter: 1, confidence: "sure", reason: "时刻不一致" }] });
      return emptyReply;
    };
    const result = await runDraftEdit(book, "fix", { chapter: 1, fixes: [{ targetText: "老周指着钟说现在是五点。", revisionGoal: "老周应当说三点" }] }, fakeDraftDeps({
      readerCallModel: reader,
      fixCallModel: async (prompt) => {
        prompts.push(prompt);
        return prompts.length === 1 ? fixes(2, "老周指着钟说现在是三点。") : fixes(1, "钟停在三点。");
      },
    }));
    expect(result.record.state).toBe("succeeded");
    expect(prompts).toHaveLength(1);
    expect((await readDraft(book, 1))?.body).toBe("钟停在四点。老周指着钟说现在是三点。");
    expect(result.body?.verify?.left?.maybe[0]?.revisited).toBeTruthy();
  });

  it("有重句时同一处两轮改回原样：算没改，不报「改好了」、不记改句", async () => {
    const original = "钟停在三点。老周看了一眼。钟停在四点。老周转过身。后面那只钟始终停在三点。";
    await save(original);
    let calls = 0;
    const reader: BrainCallModel = async (messages, options) => {
      if (!options.json) return "笔记。";
      const last = messages.at(-1)!.content;
      if (last.includes(REVIEW)) return reviews(last);
      if (last.includes(INNER)) return emptyReply;
      if (calls === 1) return JSON.stringify({ checks: [], contradictions: [{ quote: "钟停在四点。", earlierQuote: "后面那只钟始终停在三点。", earlierChapter: 1, confidence: "sure", reason: "第一只钟应当是三点" }] });
      return emptyReply;
    };
    const result = await runDraftEdit(book, "fix", { chapter: 1, fixes: [{ targetText: "钟停在三点。", revisionGoal: "第一只钟应停在四点" }] }, fakeDraftDeps({
      readerCallModel: reader,
      fixCallModel: async () => (++calls === 1 ? fixes(1, "钟停在四点。") : fixes(1, "钟停在三点。")),
    }));
    expect(calls).toBe(2);
    expect(result.record).toMatchObject({ state: "failed", failure: { code: "not_changed" } });
    expect((await readDraft(book, 1))?.body).toBe(original);
    expect(await readFixLog(book, 1)).toHaveLength(0);
  });

  it("改了几处、其中一处第二轮又改回原样：只报改好的那几处，改回去的算没改成；第二轮叫它别改回去", async () => {
    // 真机 2026-11-06：「今天上午清仓」第一轮改成「后天」，再核还报，第二轮又改回「今天」，卡上仍说「改好了 5 处」。
    const original = "钟停在三点。老周今年十八岁。通知写明钟应是四点。名册写着老周十九岁。";
    await save(original);
    const prompts: string[] = [];
    const reader: BrainCallModel = async (messages, options) => {
      if (!options.json) return "笔记。";
      const last = messages.at(-1)!.content;
      if (last.includes(REVIEW)) return reviews(last);
      if (last.includes(INNER)) return emptyReply;
      const body = last.split("【新稿：第 1 章】\n")[1]?.split("\n\n")[0] ?? "";
      const clock = body.startsWith("钟停在五点。") ? "钟停在五点。" : body.startsWith("钟停在三点。") ? "钟停在三点。" : "";
      return clock
        ? JSON.stringify({ checks: [], contradictions: [{ quote: clock, earlierQuote: "通知写明钟应是四点。", earlierChapter: 1, confidence: "sure", reason: "钟的时刻和通知对不上" }] })
        : emptyReply;
    };
    const result = await runDraftEdit(book, "fix", { chapter: 1, fixes: [
      { targetText: "钟停在三点。", revisionGoal: "照通知改成四点" },
      { targetText: "老周今年十八岁。", revisionGoal: "照名册改成十九岁" },
    ] }, fakeDraftDeps({
      readerCallModel: reader,
      fixCallModel: async (prompt) => {
        prompts.push(prompt);
        return prompts.length === 1
          ? JSON.stringify({ edits: [{ id: 1, to: "钟停在五点。" }, { id: 2, to: "老周今年十九岁。" }] })
          : fixes(1, "钟停在三点。");
      },
    }));
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("别改回原来的「钟停在三点。」");
    expect(result.record.state).toBe("succeeded");
    expect((await readDraft(book, 1))?.body).toBe("钟停在三点。老周今年十九岁。通知写明钟应是四点。名册写着老周十九岁。");
    expect(result.body?.changes).toEqual([{ from: "老周今年十八岁。", to: "老周今年十九岁。" }]);
    expect(result.summary).toContain("改好了 1 处");
    expect(result.summary).toContain("1 处没改成：改了两轮又回到了原样");
    expect(result.summary).not.toContain("改好了 2 处");
  });

  it("第一遍再核有一步没成、第二遍整章核全了：不再说没核成", async () => {
    const original = "钟停在三点。老周看了一眼，说是三点。天黑了。";
    await save(original);
    let rounds = 0;
    const reader: BrainCallModel = async (messages, options) => {
      if (!options.json) return "笔记。";
      const last = messages.at(-1)!.content;
      if (last.includes(REVIEW)) return reviews(last);
      if (last.includes(INNER)) {
        if (rounds === 1) throw new Error("服务商 502");
        return emptyReply;
      }
      if (rounds === 1) return JSON.stringify({ checks: [], contradictions: [{ quote: "老周看了一眼，说是三点。", earlierQuote: "钟停在四点。", earlierChapter: 1, confidence: "sure", reason: "时刻不一致" }] });
      return emptyReply;
    };
    const result = await runDraftEdit(book, "fix", { chapter: 1, fixes: [{ targetText: "钟停在三点。", revisionGoal: "钟应当停在四点" }] }, fakeDraftDeps({
      readerCallModel: reader,
      fixCallModel: async () => (++rounds === 1 ? fixes(1, "钟停在四点。") : fixes(2, "老周看了一眼，说是四点。")),
    }));
    expect(result.record.state).toBe("succeeded");
    expect((await readDraft(book, 1))?.body).toBe(original.replaceAll("三点", "四点"));
    expect(result.body?.verify).toMatchObject({ checks: 2 });
    expect(result.body?.verify?.partial).toBeUndefined();
    expect(result.summary).toContain("没有对不上的了");
  });

  it("正常两轮修改仍可整次撤销，恢复作者原稿", async () => {
    const original = "钟停在三点。老周看了一眼，说是三点。天黑了。";
    await save(original);
    let repairCalls = 0;
    const reader: BrainCallModel = async (messages, options) => {
      if (!options.json) return "笔记。";
      const last = messages.at(-1)!.content;
      if (last.includes(REVIEW)) return reviews(last);
      if (!last.includes(INNER) && last.includes("钟停在四点。")) return JSON.stringify({ checks: [], contradictions: [{ quote: "老周看了一眼，说是三点。", earlierQuote: "钟停在四点。", earlierChapter: 1, confidence: "sure", reason: "时刻不一致" }] });
      return emptyReply;
    };
    const result = await runDraftEdit(book, "fix", { chapter: 1, fixes: [{ targetText: "钟停在三点。", revisionGoal: "钟应当停在四点" }] }, fakeDraftDeps({ fixCallModel: async () => (++repairCalls === 1 ? fixes(1, "钟停在四点。") : fixes(2, "老周看了一眼，说是四点。")), readerCallModel: reader }));
    expect(result.record.state).toBe("succeeded");
    expect(repairCalls).toBe(2);
    expect((await readDraft(book, 1))?.body).toBe(original.replaceAll("三点", "四点"));
    await undoInOperation(book, result.record.opId);
    expect((await readDraft(book, 1))?.body).toBe(original);
  });
});

describe("外部审查 2026-11-06：本章前后 / 核账记忆 / 记东西", () => {
  it("本章前后：单条放在 pairs 下的照收，没交 pairs 如实算没跑成、不存核账记忆", async () => {
    const draft = "屋里只有一把钥匙。屋里始终有两把钥匙。";
    const single = JSON.stringify({ pairs: { later: 2, earlier: 1, reason: "钥匙数对不上", sure: true } });
    expect(parseInnerPairs(single, 1, draft)).toHaveLength(1);
    expect(parseInnerPairs(JSON.stringify({ pairs: null }), 1, draft)).toEqual([]);
    expect(() => parseInnerPairs("{}", 1, draft)).toThrow();
    const reader: BrainCallModel = async (messages, options) => (!options.json ? "笔记。" : messages.at(-1)!.content.includes(INNER) ? "{}" : emptyReply);
    const result = await checkChapterBody(book, 1, draft, { readerCallModel: reader });
    expect(result.failures.length).toBeGreaterThan(0);
    expect(await readCheckMemory(book, 1)).toBeUndefined();
  });

  it("上一版核账记忆（v6，没跑过本章前后）不再原样复用", async () => {
    const draft = "屋里只有一把钥匙。屋里始终有两把钥匙。";
    const { earlierHash } = await readCheckInputs(book, 1);
    await writeCheckMemory(book, { chapter: 1, body: draft, bodyHash: hashBody(draft), earlierHash: earlierHash!, issues: [] });
    const file = join(book, ".story-engine-ui", "continuity-checks", "0001.json");
    const stored = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    await writeFile(file, JSON.stringify({ ...stored, version: 6 }), "utf8");
    let inner = 0;
    const reader: BrainCallModel = async (messages, options) => {
      if (!options.json) return "笔记。";
      const last = messages.at(-1)!.content;
      if (last.includes(REVIEW)) return reviews(last);
      if (last.includes(INNER)) { inner += 1; return JSON.stringify({ pairs: [{ later: 2, earlier: 1, sure: true, reason: "钥匙数目不一致" }] }); }
      return emptyReply;
    };
    const result = await checkChapterBody(book, 1, draft, { readerCallModel: reader });
    expect(result.reused).toBeFalsy();
    expect(inner).toBe(4);
    expect(result.sure).toHaveLength(1);
  });

  it("记东西：多塞一个空 inside 不遮掉 kind / item", () => {
    const handles = { threadHandles: new Map(), factHandles: new Map(), itemHandles: new Map([["I1", "i1-1"], ["I2", "i1-2"]]) };
    const record = { seq: 1, item: "I1", op: "move", by: "narration", quote: "她把钥匙放进铁盒。" };
    const parsed = parseKeeperOutput(JSON.stringify({ items: [{ ...record, to: { kind: "inside", item: "I2", inside: null } }] }), handles);
    expect(parsed?.entries).toHaveLength(1);
    expect(parsed?.drops ?? []).toHaveLength(0);
  });
});
