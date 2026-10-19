// @vitest-environment node
// 写这一章的上下文（重构 P9）：本章任务 + 设定包（设定卡 + 账里现状）+ 接着写要扛住的线 + 本章硬约束 + 读坏的如实留痕。
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { cardWrite, runCommand, type CardOp } from "@actalk/story-core";
import { buildWriterContext } from "./context-gateway.js";
import { createStoryProject } from "../book/project-store.js";
import { renderFastDraftPromptText } from "./prompt-cache-diagnostics.js";
import { buildWritingContextPack } from "./writing-context-pack.js";
import { EMPTY_BIBLE } from "./setting-pack.js";

describe("Writing Context Pack（设定卡版）", () => {
  it("主角恒带进设定包；本章相关人物整张带上，其余人物只列名字", async () => {
    const projectDir = await createSoulSteelFixture();

    const pack = await buildWritingContextPack({
      projectDir,
      chapter: 1,
      userDirection: "毕业失败当天，主角第一次接触魂钢异常反应",
      currentChapterGoal: "第一章写毕业失败当天，林序第一次接触魂钢异常反应",
      selectedCharacters: ["沈知夏"],
    });

    expect(pack.chapterTask).toEqual({
      chapterNumber: 1,
      userDirection: "毕业失败当天，主角第一次接触魂钢异常反应",
      currentChapterGoal: "第一章写毕业失败当天，林序第一次接触魂钢异常反应",
    });
    expect(pack.setting.protagonist).toMatchObject({
      name: "林序",
      card: expect.arrayContaining(["年龄：22岁", "弱点：普通人起步，不开挂，信息有限，前期资源不足"]),
    });
    expect(pack.setting.cast.map((brief) => brief.name)).toEqual(["沈知夏"]);
    expect(pack.setting.cast[0]?.relations).toEqual(["和林序：大学同学，暗中受财团指派接近林序"]);
    expect(pack.setting.otherNames.characters).toEqual(["赵叔"]);
    expect(pack.setting.story).toEqual(expect.arrayContaining(["题材：都市英灵 / 创业魂钢"]));
    expect(pack.setting.rules).toMatchObject({ targetWords: 1800, bans: ["不要提前揭开魂钢真实来源"] });
    expect(pack.readFailures).toEqual([]);
  });

  it("不给本章人物：只带主角，别的人物一个不展开", async () => {
    const projectDir = await createSoulSteelFixture();
    const pack = await buildWritingContextPack({ projectDir, chapter: 1, userDirection: "第一章" });
    expect(pack.setting.protagonist?.name).toBe("林序");
    expect(pack.setting.cast).toEqual([]);
    expect(pack.setting.otherNames.characters).toEqual(["沈知夏", "赵叔"]);
  });

  it("地点 / 物品按本章方向和上一章正文挑：点到名字的整张带上，其余只列名字", async () => {
    const projectDir = await createSoulSteelFixture();
    await writeCardsAsAuthor(projectDir, [
      ...["旧城区公交站", "市中心", "财团大厦", "城南夜市", "学校宿舍", "江边堤岸"].map((name): CardOp => ({ op: "card.create", kind: "place", name })),
      ...["旧笔记本电脑", "公交卡", "毕业证书", "旧钥匙", "雨伞"].map((name): CardOp => ({ op: "card.create", kind: "item", name })),
    ]);

    const pack = await buildWritingContextPack({
      projectDir,
      chapter: 2,
      userDirection: "林序拿着半张魂钢申请表去市中心",
      continuityText: "上一章结尾，他在海天市旧城区创业孵化楼门口攥紧了公交卡。",
    });

    expect(pack.setting.places.map((brief) => brief.name)).toEqual(["海天市旧城区创业孵化楼", "市中心"]);
    expect(pack.setting.otherNames.places).toEqual(expect.arrayContaining(["旧城区公交站", "财团大厦"]));
    expect(pack.setting.items.map((brief) => brief.name)).toEqual(expect.arrayContaining(["半张魂钢申请表", "公交卡"]));
    expect(pack.setting.items.map((brief) => brief.name)).not.toContain("雨伞");
    expect(pack.setting.otherNames.items).toContain("雨伞");
  });

  describe("本章硬约束", () => {
    it("作者 / AI 指定的必写节拍原样进硬约束首位；没给就没有这条", async () => {
      const projectDir = await createSoulSteelFixture();
      const pack = await buildWritingContextPack({
        projectDir,
        chapter: 1,
        userDirection: "第一章",
        mustHitBeats: ["第三块砖", "债权池A-17", " ", "买胶带"],
      });
      expect(pack.hardConstraints[0]).toBe("必须在本章逐条落实这些要点，照写其中的具体名物 / 数字 / 编号，不得替换、合并或遗漏：第三块砖；债权池A-17；买胶带。");

      const without = await buildWritingContextPack({ projectDir, chapter: 1, userDirection: "第一章" });
      expect(without.hardConstraints.join("\n")).not.toContain("必须在本章逐条落实");
    });

    it("本章地点：方向里点到的地点卡算本章地点；第 2 章起要写出移动过程", async () => {
      const projectDir = await createSoulSteelFixture();
      const opening = await buildWritingContextPack({ projectDir, chapter: 1, userDirection: "林序在海天市旧城区创业孵化楼被告知申请失败" });
      expect(opening.hardConstraints).toContain("本章地点：海天市旧城区创业孵化楼。");

      const later = await buildWritingContextPack({ projectDir, chapter: 3, userDirection: "林序回到海天市旧城区创业孵化楼" });
      expect(later.hardConstraints).toContain("本章地点：海天市旧城区创业孵化楼；从上一章结尾所在处过去要写出移动过程。");
    });

    it("章纲定的地点也算本章地点（认别名），并整张带上", async () => {
      const projectDir = await createSoulSteelFixture();
      const pack = await buildWritingContextPack({ projectDir, chapter: 2, userDirection: "继续", plannedLocation: "孵化楼" });
      expect(pack.hardConstraints).toContain("本章地点：海天市旧城区创业孵化楼；从上一章结尾所在处过去要写出移动过程。");
      expect(pack.setting.places[0]?.name).toBe("海天市旧城区创业孵化楼");
    });

    it("方向里同时点到「南门」和「南门菜场」：取名字最长的那张，不让短名抢走", async () => {
      const projectDir = await createSoulSteelFixture();
      await writeCardsAsAuthor(projectDir, [
        { op: "card.create", kind: "place", name: "南门" },
        { op: "card.create", kind: "place", name: "南门菜场" },
      ]);
      const pack = await buildWritingContextPack({ projectDir, chapter: 1, userDirection: "林序去南门菜场买菜" });
      expect(pack.hardConstraints).toContain("本章地点：南门菜场。");
    });

    it("没点到地点：开篇按设定来，之后从上一章结尾接着写；都不许编出和地点卡冲突的地点", async () => {
      const projectDir = await createSoulSteelFixture();
      const opening = await buildWritingContextPack({ projectDir, chapter: 1, userDirection: "第一章" });
      expect(opening.hardConstraints).toContain("开场地点按故事设定和地点卡来，不要编造与设定冲突的地点。");
      const later = await buildWritingContextPack({ projectDir, chapter: 4, userDirection: "继续" });
      expect(later.hardConstraints).toContain("本章从上一章结尾所在的地方接着写；换场要写出移动过程，不要编造与地点卡冲突的地点。");
    });

    it("写作规则「一定不要写」进硬约束；不揭开没揭开的、不凭空造要紧设定恒在", async () => {
      const projectDir = await createSoulSteelFixture();
      await writeCardsAsAuthor(projectDir, [{ op: "rules.add", list: "bans", text: "不写血腥场面" }]);
      const pack = await buildWritingContextPack({ projectDir, chapter: 1, userDirection: "第一章" });
      const joined = pack.hardConstraints.join("\n");
      expect(joined).toContain("一定不要写：不要提前揭开魂钢真实来源；不写血腥场面。");
      expect(joined).toContain("设定里写着还没揭开、不能说破的，本章不要揭开，也不要让不该知道的人知道。");
      expect(joined).toContain("设定本里没有的人、地点、物件、组织，不要凭空写成要紧的；需要时模糊处理。");
    });

    it("没有「一定不要写」就不出这条（不写空清单）", async () => {
      const projectDir = await createBareProject();
      const pack = await buildWritingContextPack({ projectDir, chapter: 1, userDirection: "第一章" });
      expect(pack.hardConstraints.join("\n")).not.toContain("一定不要写");
      expect(pack.hardConstraints.join("\n")).toContain("不要凭空写成要紧的");
    });

    it("已确立事实（事实账本）进 continuityFocus 和硬约束：不得改写", async () => {
      const projectDir = await createSoulSteelFixture();
      await writeJson(projectDir, "story/fact-ledger.json", {
        version: "v0",
        facts: [{ id: "fact-1-0", chapter: 1, text: "魂钢申请表只有左半张，未补全", source: "auto" }],
      });
      const pack = await buildWritingContextPack({ projectDir, chapter: 2, userDirection: "第二章继续" });
      expect(pack.continuityFocus.establishedFacts).toEqual(expect.arrayContaining(["第1章：魂钢申请表只有左半张，未补全"]));
      expect(pack.hardConstraints.join("\n")).toContain("不得改写或否认以下已确立事实：第1章：魂钢申请表只有左半张，未补全。");
    });
  });

  it("硬约束、作者写作规矩、文风样本、设定卡渲染进 FastDraft 正文 prompt，不嵌状态总览 JSON、不带编号", async () => {
    const projectDir = await createSoulSteelFixture();
    await writeCardsAsAuthor(projectDir, [
      { op: "rules.set", field: "notes", value: "## 我的节奏\n- 前戏铺垫别超过200字\n- 高潮段落用短句" },
      { op: "exemplar.add", text: "雨先是落在檐角，再落到他的肩上。他没有躲，只是觉得这座城忽然安静得过分。", note: "我满意的开头节奏" },
    ]);
    const context = await buildWriterContext({
      projectDir,
      chapter: 1,
      chapterGoal: "第一章写毕业失败当天，林序在海天市旧城区创业孵化楼第一次接触魂钢异常反应",
    });
    const prompt = renderFastDraftPromptText(context);

    expect(context.trace.sectionNames).toContain("writing_context_pack");
    expect(prompt).toContain("## 本章硬约束");
    expect(prompt).toContain("- 本章地点：海天市旧城区创业孵化楼。");
    expect(prompt).toContain("## 作者自定写作规矩（务必遵守）");
    expect(prompt).toContain("前戏铺垫别超过200字");
    expect(prompt).toContain("## 作者文风样本（模仿风格·不得照抄内容）");
    expect(prompt).toContain("雨先是落在檐角");
    expect(prompt).toContain("我满意的开头节奏");
    expect(prompt).toContain("【林序】");
    expect(prompt).toContain("弱点：普通人起步，不开挂");
    expect(prompt).toContain("【海天市旧城区创业孵化楼】（也叫：孵化楼）");
    expect(prompt).not.toContain("\"storyStatus\"");
    expect(prompt).not.toContain("\"uiHints\"");
    expect(prompt).not.toMatch(/\b(?:k|r|e)-\d+\b/u);
  });

  it("没有文风样本：prompt 里不出样本段", async () => {
    const projectDir = await createSoulSteelFixture();
    const context = await buildWriterContext({ projectDir, chapter: 1, chapterGoal: "第一章" });
    expect(renderFastDraftPromptText(context)).not.toContain("作者文风样本");
  });

  it("调用方给了设定视图就用它，不再读盘", async () => {
    const projectDir = await createSoulSteelFixture();
    const pack = await buildWritingContextPack({
      projectDir,
      chapter: 1,
      userDirection: "第一章",
      bible: { bible: EMPTY_BIBLE },
    });
    expect(pack.setting.protagonist).toBeUndefined();
    expect(pack.setting.story).toEqual([]);
  });

  it("never hardcodes 题材专名 in the writing-context-pack source", async () => {
    const source = await readFile(new URL("./writing-context-pack.ts", import.meta.url), "utf-8");
    for (const banned of ["欠费手机", "联网", "末日", "财团", "魂钢"]) {
      expect(source).not.toContain(banned);
    }
  });

  describe("接着写要扛住的线", () => {
    it("早期未收口线索（第 2 章）在第 50 章仍进 mustCarryThreads，不被近章线索淘汰", async () => {
      const projectDir = await createSoulSteelFixture();
      await writeJson(projectDir, "story/threads.json", {
        version: "v0",
        threads: [
          { id: "thread-early", type: "lead", title: "借条秘密：赵叔欠下的神秘债务", status: "open", firstSeenChapter: 2, lastTouchedChapter: 2, evidence: ["第2章赵叔提过一张未还的借条"] },
          ...[47, 48, 49].map((chapter) => ({ id: `thread-${chapter}`, type: "lead", title: `近章线索（第${chapter}章）`, status: "open", firstSeenChapter: chapter, lastTouchedChapter: chapter, evidence: [`第${chapter}章新发现`] })),
        ],
      });
      const pack = await buildWritingContextPack({ projectDir, chapter: 50, userDirection: "第50章继续推进" });
      expect(pack.continuityFocus.mustCarryThreads.some((thread) => thread.includes("借条秘密"))).toBe(true);
    });

    it("已收口线索（status:done）不进 mustCarryThreads，无论章号多近", async () => {
      const projectDir = await createSoulSteelFixture();
      await writeJson(projectDir, "story/threads.json", {
        version: "v0",
        threads: [
          { id: "thread-done", type: "lead", title: "已收口线索（已结案）", status: "done", firstSeenChapter: 45, lastTouchedChapter: 49, evidence: ["第49章已收口"] },
          { id: "thread-open", type: "lead", title: "开放线索", status: "open", firstSeenChapter: 48, lastTouchedChapter: 48, evidence: ["第48章"] },
        ],
      });
      const pack = await buildWritingContextPack({ projectDir, chapter: 50, userDirection: "第50章" });
      expect(pack.continuityFocus.mustCarryThreads.join("\n")).not.toContain("已收口线索");
      expect(pack.continuityFocus.mustCarryThreads.join("\n")).toContain("开放线索");
    });

    it("早期未达成主线目标（第 3 章）在第 50 章仍进 arcGoalFocus", async () => {
      const projectDir = await createSoulSteelFixture();
      await writeJson(projectDir, "story/arc-goals.json", {
        version: "v0",
        goals: [
          { id: "goal-early", title: "查清魂钢申请异常的真相（第3章起）", status: "active", scope: "main_arc", firstSeenChapter: 3, lastTouchedChapter: 3, evidence: ["第3章设定"] },
          ...[47, 48, 49].map((chapter) => ({ id: `goal-${chapter}`, title: `近章目标（第${chapter}章）`, status: "active", scope: "mini_arc", firstSeenChapter: chapter, lastTouchedChapter: chapter, evidence: [`第${chapter}章`] })),
        ],
      });
      const pack = await buildWritingContextPack({ projectDir, chapter: 50, userDirection: "第50章继续推进" });
      expect(pack.continuityFocus.arcGoalFocus.some((goal) => goal.includes("查清魂钢申请异常"))).toBe(true);
    });

    // P1-7：重提中间章时该章事件落在文件尾，「最近 N 条」必须按章号选。
    it("recentTimelineEvents 按章号选最近 3 条，不受落盘顺序影响", async () => {
      const projectDir = await createSoulSteelFixture();
      const ev = (chapter: number, summary = `CH${chapter}-EVENT`) => ({ id: `ch${String(chapter).padStart(4, "0")}-001`, chapter, summary, participants: [] });
      await writeJson(projectDir, "timeline/events.json", [...[1, 2, 4, 5, 6, 7].map((chapter) => ev(chapter)), ev(3, "CH3-REWRITE-EVENT")]);
      const pack = await buildWritingContextPack({ projectDir, chapter: 8, userDirection: "续写" });
      expect(pack.continuityFocus.recentTimelineEvents).toEqual(["第5章：CH5-EVENT", "第6章：CH6-EVENT", "第7章：CH7-EVENT"]);
    });

    it("包内摘要恒 ≤3 条（maxTimelineEvents=10 不生效），完整时间线走可裁的 timeline_events 段", async () => {
      const projectDir = await createSoulSteelFixture();
      await writeJson(projectDir, "timeline/events.json", [1, 2, 3, 4, 5, 6, 7].map((chapter) => ({ id: `ch${chapter}`, chapter, summary: `CH${chapter}`, participants: [] })));
      const pack = await buildWritingContextPack({ projectDir, chapter: 8, userDirection: "续写", maxTimelineEvents: 10 });
      expect(pack.continuityFocus.recentTimelineEvents).toHaveLength(3);
      const envelope = await buildWriterContext({ projectDir, chapter: 8, chapterGoal: "续写", maxTimelineEvents: 10 });
      expect(envelope.sections.find((item) => item.name === "timeline_events")?.content as readonly unknown[]).toHaveLength(7);
    });
  });

  describe("读坏文件：降级照做、如实进 readFailures、不崩", () => {
    it("设定卡坏了 → 按空设定写，readFailures 如实记录（无绝对路径），并进上下文的 read_failures 段", async () => {
      const projectDir = await createSoulSteelFixture();
      await writeFile(join(projectDir, "ledger", "cards.json"), "{not-json", "utf-8");

      const pack = await buildWritingContextPack({ projectDir, chapter: 1, userDirection: "第一章" });
      expect(pack.setting.protagonist).toBeUndefined();
      expect(pack.setting.rules.bans).toEqual([]);
      expect(pack.readFailures).toHaveLength(1);
      expect(pack.readFailures[0]).toContain("设定本读取失败");
      expect(pack.readFailures.join(" ")).not.toMatch(/\/Users|\/var|\/private|\/tmp|\/home/u);

      const envelope = await buildWriterContext({ projectDir, chapter: 1, chapterGoal: "第一章" });
      const failures = envelope.sections.find((item) => item.name === "read_failures")?.content as { failures: readonly string[] } | undefined;
      expect(failures?.failures.join(" ")).toContain("设定本读取失败");
    });

    it("时间线、事实账本坏了 → 各自按空降级，readFailures 带相对文件名", async () => {
      const projectDir = await createSoulSteelFixture();
      await mkdir(join(projectDir, "timeline"), { recursive: true });
      await mkdir(join(projectDir, "story"), { recursive: true });
      await writeFile(join(projectDir, "timeline", "events.json"), "{not-json", "utf-8");
      await writeFile(join(projectDir, "story", "fact-ledger.json"), "{not-json", "utf-8");

      const pack = await buildWritingContextPack({ projectDir, chapter: 2, userDirection: "第二章" });
      expect(pack.continuityFocus.recentTimelineEvents).toEqual([]);
      expect(pack.continuityFocus.establishedFacts).toEqual([]);
      const joined = pack.readFailures.join(" ");
      expect(joined).toContain("时间线事件读取失败（timeline/events.json");
      expect(joined).toContain("事实账本读取失败（story/fact-ledger.json");
      expect(joined).not.toMatch(/\/Users|\/var|\/private|\/tmp|\/home/u);
      // 设定本本身好好的，照常带上
      expect(pack.setting.protagonist?.name).toBe("林序");
    });
  });
});

async function writeCardsAsAuthor(projectDir: string, ops: readonly CardOp[]): Promise<void> {
  const outcome = await runCommand(projectDir, cardWrite, { ops }, { caller: "author", idempotencyKey: `t-${randomUUID()}` });
  if (!outcome.ok) throw new Error(outcome.message);
}

async function createBareProject(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "story-engine-writing-context-bare-"));
  const { projectDir } = await createStoryProject({ rootDir, title: "空书", protagonistName: "林序" });
  return projectDir;
}

async function createSoulSteelFixture(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "story-engine-writing-context-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title: "海天魂钢",
    genre: "都市英灵 / 创业魂钢",
    logline: "普通毕业生林序在毕业失败当天第一次接触魂钢异常反应。",
    protagonistName: "林序",
  });
  await writeCardsAsAuthor(projectDir, [
    { op: "story.set", label: "世界规矩", value: "创业魂钢决定城市阶层、资源分配和英灵能力" },
    { op: "story.set", label: "还没揭开", value: "魂钢真实来源；财团幕后操盘者" },
    { op: "field.set", card: "林序", label: "年龄", value: "22岁" },
    { op: "field.set", card: "林序", label: "身份", value: "普通毕业生" },
    { op: "field.set", card: "林序", label: "弱点", value: "普通人起步，不开挂，信息有限，前期资源不足" },
    { op: "field.set", card: "林序", label: "说话", value: "克制，先观察再反问。" },
    { op: "card.create", kind: "character", name: "沈知夏", fields: [{ label: "身份", value: "大学同学" }] },
    { op: "card.create", kind: "character", name: "赵叔" },
    { op: "relation.set", a: "沈知夏", b: "林序", label: "大学同学，暗中受财团指派接近林序" },
    {
      op: "card.create",
      kind: "place",
      name: "海天市旧城区创业孵化楼",
      aliases: ["孵化楼"],
      fields: [{ label: "格局", value: "三层：1楼大厅、2楼申请窗口、3楼办公区" }, { label: "移动", value: "到市中心打车 25 分钟，现金不足时不能随便打车" }],
    },
    { op: "card.create", kind: "item", name: "半张魂钢申请表", fields: [{ label: "规矩", value: "不能凭空变成完整申请表" }] },
    { op: "card.create", kind: "item", name: "欠费手机", fields: [{ label: "现状", value: "欠费三天，不能正常联网" }] },
    { op: "rules.set", field: "targetWords", value: 1800 },
    { op: "rules.add", list: "style", text: "克制" },
    { op: "rules.add", list: "bans", text: "不要提前揭开魂钢真实来源" },
  ]);
  return projectDir;
}

async function writeJson(projectDir: string, relativePath: string, value: unknown): Promise<void> {
  const path = join(projectDir, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}
