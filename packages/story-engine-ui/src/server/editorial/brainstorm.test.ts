// @vitest-environment node
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import {
  brainstormChapter,
  brainstormCheckTask,
  brainstormTask,
  parseBrainstorm,
  splitBrainstormProblems,
  type BrainstormThread,
} from "./brainstorm.js";
import type { BrainCallModel, BrainMessage } from "./reader-window.js";

const CH1 = "许棠把那封信锁进抽屉，说明天一早去邮局。";
const CH2 = "第二天许棠去了邮局，把信寄给了林溪。林溪下午回电说收到了。";

async function makeBook(): Promise<string> {
  const dir = await makeHomeTempDir("brainstorm-");
  await mkdir(join(dir, "chapters"), { recursive: true });
  await writeFile(join(dir, "chapters", "0001.md"), `# 第1章\n\n${CH1}\n`, "utf-8");
  await writeFile(join(dir, "chapters", "0002.md"), `# 第2章\n\n${CH2}\n`, "utf-8");
  return dir;
}

const THREADS: readonly BrainstormThread[] = [
  { id: "t-letter", title: "信里写了什么", idle: 0, stale: false, weight: "major" },
  { id: "t-key", title: "抽屉钥匙在谁手上", idle: 6, stale: true, weight: "normal" },
];

const OPTIONS_JSON = JSON.stringify({
  options: [
    { title: "林溪来信", steps: ["邮差送来回信", "许棠拆信", "信里约周末见"], threads: ["t-letter", "t-ghost"], recommended: true },
    { title: "抽屉被撬", steps: ["许棠回家发现抽屉开着", "信不见了", "邻居说看见有人来过"], threads: ["t-key"], recommended: true },
    { title: "", steps: ["没名字的不要"] },
    { title: "去邮局追问", steps: ["许棠又去了邮局"], threads: [] },
    { title: "第四种", steps: ["多出来的不要"] },
  ],
});

describe("头脑风暴：解析章纲员的走法", () => {
  it("线索编号换成名字（不认识的丢）；推荐只留第一个；没名字的丢；最多三种", () => {
    const options = parseBrainstorm(OPTIONS_JSON, THREADS);
    expect(options.map((option) => option.title)).toEqual(["林溪来信", "抽屉被撬", "去邮局追问"]);
    expect(options[0]).toMatchObject({ recommended: true, threads: [{ title: "信里写了什么", idle: 0, stale: false }] });
    expect(options[1]).not.toHaveProperty("recommended");
    expect(options[1]!.threads).toEqual([{ title: "抽屉钥匙在谁手上", idle: 6, stale: true }]);
    expect(JSON.stringify(options)).not.toContain("t-");
  });

  it("推进的线索最多留 3 条；重复的编号只算一次", () => {
    const many = ["a", "b", "c", "d"].map((id) => ({ id, title: `线索${id}`, idle: 0, stale: false, weight: "normal" as const }));
    const options = parseBrainstorm(JSON.stringify({ options: [
      { title: "甲", steps: ["一"], threads: ["a", "a", "b", "c", "d"] },
      { title: "乙", steps: ["二"] },
    ] }), many);
    expect(options[0]!.threads.map((thread) => thread.title)).toEqual(["线索a", "线索b", "线索c"]);
  });

  it("「recommended」只认 true（\"是\" 之类不算，不猜）；能用的不到两种算没拟成", () => {
    const options = parseBrainstorm(JSON.stringify({ options: [
      { title: "甲", steps: ["一"], recommended: "是" },
      { title: "乙", steps: ["二"], recommended: "TRUE" },
    ] }), []);
    expect(options[0]).not.toHaveProperty("recommended");
    expect(options[1]).toMatchObject({ recommended: true });
    expect(() => parseBrainstorm(JSON.stringify({ options: [{ title: "甲", steps: ["一"] }] }), [])).toThrow(/只有 1 种/u);
    expect(() => parseBrainstorm("不是 JSON", [])).toThrow(/JSON/u);
  });

  it("任务里列带编号的开着线索、作者想法、已给过的走法", () => {
    const task = brainstormTask({ chapter: 3, materialBlocks: ["【故事前提】一封信"], threads: THREADS, idea: "让林溪出场", avoid: ["林溪来信"] });
    expect(task).toContain("t-key｜抽屉钥匙在谁手上｜停了 6 章");
    expect(task).toContain("t-letter｜信里写了什么｜刚动过｜大伏笔");
    expect(task).toContain("作者给了想法");
    expect(task).toContain("【这几种已经给过作者了，别再出一样的】林溪来信");
    expect(task).toContain("【故事前提】一封信");
  });
});

describe("头脑风暴：核账员核走法", () => {
  const options = parseBrainstorm(OPTIONS_JSON, THREADS);

  it("每一步按全局编号列出；问题按编号分回各走法的第几步；前文原句抄不出来的丢掉", () => {
    const task = brainstormCheckTask(3, options);
    expect(task).toContain("【走法2：抽屉被撬】\n4. 许棠回家发现抽屉开着");
    expect(task).toContain("7. 许棠又去了邮局");
    const checked = splitBrainstormProblems(JSON.stringify({ problems: [
      { point: 5, conflict: true, earlierQuote: "把信寄给了林溪", earlierChapter: 2, reason: "信已经寄走了，抽屉里没有信" },
      { point: 2, conflict: true, earlierQuote: "前文根本没有这句", earlierChapter: 1, reason: "编的" },
      { point: 1, conflict: false, reason: "对得上" },
    ] }), options, { chapters: [{ chapter: 2, sentences: [CH2] }, { chapter: 1, sentences: [CH1] }] });
    expect(checked[0]!.problems).toEqual([]);
    expect(checked[1]!.problems).toEqual([{ step: 2, earlierChapter: 2, earlierQuote: "把信寄给了林溪", reason: "信已经寄走了，抽屉里没有信" }]);
    expect(checked[2]!.problems).toEqual([]);
  });
});

/** 假专员：json:false 写笔记；json:true 按角色回固定内容（可以抛错）。 */
function fakeReader(reply: string | Error) {
  const calls: { readonly messages: readonly BrainMessage[]; readonly json: boolean }[] = [];
  const callModel: BrainCallModel = async (messages, options) => {
    calls.push({ messages: [...messages], json: options.json });
    if (!options.json) return `第${/第 (\d+) 章/u.exec(messages.at(-1)!.content)?.[1]}章笔记`;
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { callModel, calls };
}

describe("头脑风暴：整条（章纲员出 → 核账员核）", () => {
  it("章纲员读完前文出走法、核账员一次核完；只读（不落章纲）", async () => {
    const dir = await makeBook();
    const planner = fakeReader(OPTIONS_JSON);
    const checker = fakeReader(JSON.stringify({ problems: [{ point: 5, conflict: true, earlierQuote: "把信寄给了林溪", earlierChapter: 2, reason: "信已经寄走了" }] }));
    const result = await brainstormChapter({
      projectDir: dir,
      chapter: 3,
      idea: "让林溪出场",
      callPlanner: planner.callModel,
      callChecker: checker.callModel,
      readThreads: async () => THREADS,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result).toMatchObject({ chapter: 3, idea: "让林溪出场", checked: true });
    expect(result.options.map((option) => option.problems.length)).toEqual([0, 1, 0]);
    const plannerTask = planner.calls.find((call) => call.json)!.messages.at(-1)!.content;
    expect(plannerTask).toContain("【作者这章的方向】让林溪出场");
    expect(plannerTask).toContain("t-key｜抽屉钥匙在谁手上");
    // 窗口里有它读过的原文（不是只拿一包检索材料）。
    expect(planner.calls.find((call) => call.json)!.messages.some((message) => message.content.includes(CH2))).toBe(true);
    expect(checker.calls.filter((call) => call.json)).toHaveLength(1);
  });

  it("章纲员两次都没给出能用的走法 → ok:false 如实说；核账员挂了 → 照给走法，checked:false 说没核成", async () => {
    const dir = await makeBook();
    const bad = await brainstormChapter({
      projectDir: dir,
      chapter: 3,
      callPlanner: fakeReader("不是 JSON").callModel,
      callChecker: fakeReader("{}").callModel,
      readThreads: async () => [],
    });
    expect(bad).toMatchObject({ ok: false });
    if (!bad.ok) expect(bad.reason).toContain("已自动重试一次");

    const unchecked = await brainstormChapter({
      projectDir: dir,
      chapter: 3,
      callPlanner: fakeReader(OPTIONS_JSON).callModel,
      callChecker: fakeReader(new Error("服务商超时")).callModel,
      readThreads: async () => [],
    });
    expect(unchecked).toMatchObject({ ok: true, checked: false });
    if (unchecked.ok) {
      expect(unchecked.checkNote).toContain("服务商超时");
      expect(unchecked.options).toHaveLength(3);
    }
  });
});
