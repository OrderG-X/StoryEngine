// @vitest-environment node
// R7.3 用十章复现书（scripts/eval/books/ten-run-qingshi 的临时副本、id 改掉，不动原书）过一遍产品路（checkChapterBody）：
// 1. 报告 3.3 的「后天 vs 明天」误报：第 1 章（第 1 天）「后天上午」对第 2 章（第 2 天）「明天上午」是同一天 → 不报；
// 2. 人物卡写「三年前过世」、第 3 章写「五年」→ 核第 6 章（写的三年，和人物卡一致）时报「第 3 章和人物卡不一致」，按钮指向第 3 章。
import { existsSync } from "node:fs";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { BrainCallModel, BrainMessage } from "../index.js";
import { makeHomeTempDir } from "../../lib/home-test-tmp.js";
import { checkChapterBody } from "./check-service.js";

const REPRO_BOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "scripts", "eval", "books", "ten-run-qingshi");
// 复现书在 scripts/ 下（不进 git）：新克隆、另开的工作区、CI 上都没有，这两组就标跳过（输出里看得见），不报假红。
const describeWithBook = describe.skipIf(!existsSync(REPRO_BOOK));

/** 复现书副本：先复制再改 id，绝不碰原书目录。 */
async function copyReproBook(tag: string): Promise<string> {
  const dir = await makeHomeTempDir(`r73-${tag}-`);
  await cp(REPRO_BOOK, dir, { recursive: true });
  const projectFile = join(dir, "project.json");
  const project = JSON.parse(await readFile(projectFile, "utf-8")) as { id: string };
  await writeFile(projectFile, JSON.stringify({ ...project, id: `story-r73-${tag}` }, null, 2), "utf-8");
  return dir;
}

const chapterBody = async (dir: string, chapter: number): Promise<string> =>
  (await readFile(join(dir, "chapters", `${String(chapter).padStart(4, "0")}.md`), "utf-8")).replace(/^#[^\n]*\n/u, "").trim();

/** 核账员假模型：记笔记回一句；三遍里「盯时间」那遍报 contradictions 表里的条目；自复核按 sure 回。 */
function readerModel(contradictions: readonly Record<string, unknown>[]) {
  const callModel: BrainCallModel = async (messages, options) => {
    if (!options.json) return "这一章的笔记。";
    const last = messages.at(-1)!.content;
    if (last.includes("你刚才核完报了")) {
      const ids = [...last.matchAll(/【(K\d+)】/gu)].map((match) => match[1]);
      return JSON.stringify({ verdicts: ids.map((id) => ({ id, verdict: "sure" })) });
    }
    if (last.includes("这一遍只盯时间和信息")) return JSON.stringify({ checks: [], contradictions });
    return JSON.stringify({ checks: [], contradictions: [] });
  };
  return { callModel };
}

describeWithBook("R7.3 复现书：相对时间按故事日换算（报告 3.3）", () => {
  it("第 1 章「后天上午陆川会来」对第 2 章「明天上午陆川来」是同一天（第 3 天）→ 不报；同遍报的真矛盾照报", async () => {
    const dir = await copyReproBook("relative");
    const body = await chapterBody(dir, 2);
    const reader = readerModel([
      // 报告 3.3 的误报原样喂回去（把握 sure、自复核也 sure）：时间线第 1 章＝第 1 天、第 2 章＝第 2 天，两边都指第 3 天。
      { quote: "“明天上午陆川来。”老周说", earlierQuote: "后天上午，陆川会来。", earlierChapter: 1, reason: "一个说后天一个说明天，日子对不上", confidence: "sure" },
      // 对照：同一遍里另一个和日子无关的真矛盾不受影响。
      { quote: "沈青禾推开茶馆的门。", earlierQuote: "茶馆门板上了栓，屋里没有灯。", earlierChapter: 1, reason: "门上了栓又推开，没交代开栓", confidence: "sure" },
    ]);
    // 第二条的原句第 1 章里没有：parseFullReadIssues 自己会丢掉，不用管（这条只防第一条被「顺带」保留）。
    const result = await checkChapterBody(dir, 2, body, { readerCallModel: reader.callModel });
    expect(result.ok).toBe(true);
    const all = [...result.sure, ...result.maybe];
    expect(all.some((item) => item.quote.includes("明天上午陆川来"))).toBe(false);
    expect(all.some((item) => item.earlierQuote.includes("后天上午"))).toBe(false);
    expect(result.summary).not.toContain("明天上午");
  });

  it("删掉时间线和章纲（手写老书：两章都没有可靠故事日）→ 同一处误报最多进「可能」，不进「确定」", async () => {
    const dir = await copyReproBook("no-timeline");
    await rm(join(dir, "story", "timeline.json"));
    await rm(join(dir, "drafts", "plans"), { recursive: true });
    // 没有章纲可用时 deriveTimelineFromLegacy 全按 fallback 推（第 2 章不是第 1 章，不算可靠）。
    const body = await chapterBody(dir, 2);
    const reader = readerModel([
      { quote: "“明天上午陆川来。”老周说", earlierQuote: "后天上午，陆川会来。", earlierChapter: 1, reason: "一个说后天一个说明天，日子对不上", confidence: "sure" },
    ]);
    const result = await checkChapterBody(dir, 2, body, { readerCallModel: reader.callModel });
    expect(result.sure).toEqual([]);
    expect(result.maybe.map((item) => item.quote)).toEqual([`“明天上午陆川来。”老周说，“你跟他把楼门的事说清楚。`]);
    // 作者把日子定准了（第 1、2 章都可靠）→ 正文没改、复用上次结果，也要按新时间线把这条收掉，不再端出来。
    await writeFile(join(dir, "story", "timeline.json"), JSON.stringify({
      schemaVersion: 1,
      entries: [
        { chapter: 1, day: 1, source: "declared" },
        { chapter: 2, day: 2, source: "declared" },
      ],
    }), "utf-8");
    const again = await checkChapterBody(dir, 2, body, { readerCallModel: reader.callModel });
    expect(again.reused).toBe(true);
    expect([...again.sure, ...again.maybe]).toEqual([]);
  });
});

describeWithBook("R7.3 复现书：设定本进核账（报告 3.3）", () => {
  it("人物卡写「三年前过世」、第 3 章被改成「五年」→ 核第 6 章（三年，和人物卡一致）报第 3 章和人物卡不一致，按钮指向第 3 章", async () => {
    const dir = await copyReproBook("setting");
    // 把报告里作者后来改掉的那处埋错放回去：第 3 章「三年」→「五年」。
    const ch3File = join(dir, "chapters", "0003.md");
    const ch3 = await readFile(ch3File, "utf-8");
    expect(ch3).toContain("沈师傅走了也有三年了");
    await writeFile(ch3File, ch3.replace("沈师傅走了也有三年了", "沈师傅走了也有五年了"), "utf-8");
    const body = await chapterBody(dir, 6);
    let sawSettingInDraft = false;
    const inner = readerModel([
      { quote: "“四十来年吧。”陆川想了想，“沈师傅走了也有五年了。", quoteChapter: 3, settingQuote: "爷爷沈敬山：三年前过世", reason: "人物卡写爷爷三年前过世，第 3 章说走了五年", confidence: "sure" },
    ]);
    const callModel: BrainCallModel = async (messages, options) => {
      if (options.json && messages.at(-1)!.content.includes("【设定本") && messages.at(-1)!.content.includes("三年前过世")) sawSettingInDraft = true;
      return inner.callModel(messages, options);
    };
    const result = await checkChapterBody(dir, 6, body, { readerCallModel: callModel });
    expect(sawSettingInDraft).toBe(true); // 设定本真的进了核账窗口（含人物卡原句）
    expect(result.sure).toHaveLength(1);
    expect(result.sure[0]).toMatchObject({
      quote: "“四十来年吧。”陆川想了想，“沈师傅走了也有五年了。",
      earlierQuote: "爷爷沈敬山：三年前过世",
      earlierChapter: 3,
      fixChapter: 3,
      againstSetting: { label: "人物卡" },
    });
    expect(result.summary).toContain("第 3 章那句");
    expect(result.summary).toContain("设定（人物卡）");
    expect(result.maybe).toEqual([]);
  });

  it("设定原文抄不出（人物卡里没有的话）→ 不收，不装核过设定", async () => {
    const dir = await copyReproBook("setting-fake");
    const body = await chapterBody(dir, 6);
    const reader = readerModel([
      { quote: "“你爷爷走了三年，”陆川说", settingQuote: "人物卡里根本没有的一句话", reason: "对不上", confidence: "sure" },
    ]);
    const result = await checkChapterBody(dir, 6, body, { readerCallModel: reader.callModel });
    expect([...result.sure, ...result.maybe]).toEqual([]);
  });
});
