// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cardWrite, runCommand, type CardOp } from "@actalk/story-core";
import { checkDraftBeforeCommit } from "./commit-quality-check.js";
import { createStoryProject } from "../book/project-store.js";

describe("commit quality check", () => {

  it("rejects empty draft content", async () => {
    const projectDir = await createFixtureProject();

    const report = await checkDraftBeforeCommit({ projectDir, chapter: 1, draftContent: "   " });

    expect(report.passed).toBe(false);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "error", type: "empty_draft" }),
    ]));
  });

  it("rejects JSON and tool-call artifacts", async () => {
    const projectDir = await createFixtureProject();

    const jsonReport = await checkDraftBeforeCommit({
      projectDir,
      chapter: 1,
      draftContent: JSON.stringify({ name: "tool", arguments: {} }),
    });
    const toolReport = await checkDraftBeforeCommit({
      projectDir,
      chapter: 1,
      draftContent: "tool_call: write_chapter({})",
    });

    expect(jsonReport.passed).toBe(false);
    expect(toolReport.passed).toBe(false);
    expect(jsonReport.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "error", type: "tool_or_json_artifact" }),
    ]));
    expect(toolReport.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "error", type: "tool_or_json_artifact" }),
    ]));
  });

  it("warns (does not block) when the draft mentions no known character name — author may write an unregistered character", async () => {
    const projectDir = await createFixtureProject();

    const report = await checkDraftBeforeCommit({
      projectDir,
      chapter: 1,
      draftContent: longDraft({ characterName: "少年", withTitle: true, withDialogue: true }),
    });

    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "warning", type: "missing_character_name" }),
    ]));
    expect(report.issues.filter((issue) => issue.type === "missing_character_name" && issue.severity === "error")).toEqual([]);
  });

  it("还没有人物卡（新书没填主角）：名字门不挡也不提醒", async () => {
    const projectDir = await createFixtureProject(null);

    const report = await checkDraftBeforeCommit({
      projectDir,
      chapter: 1,
      draftContent: longDraft({ characterName: "苏晚", withTitle: true, withDialogue: true }),
    });

    expect(report.issues.some((issue) => issue.type === "missing_character_name")).toBe(false);
    expect(report.passed).toBe(true);
  });

  it("名字门认人物卡的名字和别名", async () => {
    const projectDir = await createFixtureProject();
    await writeCards(projectDir, [{ op: "card.aliases", card: "林远", add: ["远哥"] }]);

    const report = await checkDraftBeforeCommit({
      projectDir,
      chapter: 1,
      draftContent: longDraft({ characterName: "远哥", withTitle: true, withDialogue: true }),
    });

    expect(report.issues.some((issue) => issue.type === "missing_character_name")).toBe(false);
  });

  it("名字门只认人物卡：正文只写到地点 / 物品卡的名字照样提醒", async () => {
    const projectDir = await createFixtureProject();
    await writeCards(projectDir, [
      { op: "card.create", kind: "place", name: "外院园圃" },
      { op: "card.create", kind: "item", name: "青石令牌" },
    ]);

    const report = await checkDraftBeforeCommit({
      projectDir,
      chapter: 1,
      draftContent: longDraft({ characterName: "少年", withTitle: true, withDialogue: true }).replace("青石路", "青石令牌旁的路"),
    });

    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "warning", type: "missing_character_name" }),
    ]));
  });

  it("设定卡读坏了：定稿检查如实失败，不当成「没有规则」放行", async () => {
    const projectDir = await createFixtureProject();
    await writeFile(join(projectDir, "ledger", "cards.json"), "{not-json", "utf-8");

    await expect(checkDraftBeforeCommit({
      projectDir,
      chapter: 1,
      draftContent: longDraft({ characterName: "林远", withTitle: true, withDialogue: true }),
    })).rejects.toThrow(/cards\.json/u);
  });

  it("rejects drafts shorter than 300 Chinese characters", async () => {
    const projectDir = await createFixtureProject();

    const report = await checkDraftBeforeCommit({
      projectDir,
      chapter: 1,
      draftContent: "# 第一章\n\n林远说：“我要留下。”\n",
    });

    expect(report.passed).toBe(false);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "error", type: "too_short" }),
    ]));
  });

  it("uses writing-rule target words to lower the hard short-draft gate", async () => {
    const projectDir = await createFixtureProject();
    await writeWritingRules(projectDir, { targetWords: 200 });

    const report = await checkDraftBeforeCommit({
      projectDir,
      chapter: 1,
      draftContent: [
        "# 第一章 外院账册",
        "",
        "林远站在外院园圃的石阶前，把刚领到的账册压在袖中。他没有立刻争辩，只把管事涂改过的粮米数额记下来，准备等夜里核对库房旧账。风从药畦间吹过，他听见同门压低声音提醒：“别在这里翻脸。”林远点头，知道真正的反击要从证据开始。他还记下库房门口两名杂役的换班时间，确认今晚能避开管事的眼线。等钟声落下，他会先查园圃旧锁，再找到账册缺页的去向，把这场羞辱变成可追责的线索。",
      ].join("\n"),
    });

    expect(report.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "too_short" }),
    ]));
  });

  // 长跑 2026-10-04 #5b/#4 语义定案：目标字数是「约」（软推导保 300 封顶，全额 0.75 执法会把下限抬到 2700，
  // 误伤自愿短章）；硬约束本体 = 写作规则里的「每章至少字数」（minWords），定稿侧不封顶全额执法。
  it("只有 targetWords（无显式 min）：软推导保 300 封顶，target 3600 不拦 2600 字短稿（软带执法留给出稿侧 ⚠）", async () => {
    const projectDir = await createFixtureProject();
    await writeWritingRules(projectDir, { targetWords: 3600 });

    const report = await checkDraftBeforeCommit({
      projectDir,
      chapter: 1,
      draftContent: draftOfExactlyChineseChars(2600),
    });

    expect(report.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "too_short" }),
    ]));
  });

  it("targetWords + 显式 min：min 不封顶全额执法（target 3600 + min 2700 → 拦 2600 字短稿）", async () => {
    const projectDir = await createFixtureProject();
    await writeWritingRules(projectDir, { targetWords: 3600, minWords: 2700 });

    const report = await checkDraftBeforeCommit({
      projectDir,
      chapter: 1,
      draftContent: draftOfExactlyChineseChars(2600),
    });

    expect(report.passed).toBe(false);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "error", type: "too_short", message: expect.stringContaining("2700") }),
    ]));
  });

  // 长跑 2026-10-04 #4：「至少 3000 字」的硬下限本体（写作规则 minWords）——
  // 第 2 章 2989 纯汉字「过线」定稿的场景（目标 3000/推导下限 2550）必须被显式 min 拦下。
  it("explicit minWords is the hard floor: 3000-word floor rejects a 2989-char draft", async () => {
    const projectDir = await createFixtureProject();
    await writeWritingRules(projectDir, { targetWords: 3000, minWords: 3000 });

    const report = await checkDraftBeforeCommit({
      projectDir,
      chapter: 1,
      draftContent: draftOfExactlyChineseChars(2989),
    });

    expect(report.passed).toBe(false);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: "error",
        type: "too_short",
        message: expect.stringMatching(/shorter than 3000 Chinese characters \(current: 2989\)/u),
      }),
    ]));
  });

  it("explicit minWords: 3010 字（≥3000）放行", async () => {
    const projectDir = await createFixtureProject();
    await writeWritingRules(projectDir, { targetWords: 3000, minWords: 3000 });

    const report = await checkDraftBeforeCommit({
      projectDir,
      chapter: 1,
      draftContent: draftOfExactlyChineseChars(3010),
    });

    expect(report.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "too_short" }),
    ]));
  });

  // 长跑 #5：定稿执法计数与出稿/UI 同口径 countDraftChineseCharacters（[\u3400-\u9fff]，去标题）——
  // 标点/空白/西文/标题行不计入，含大量标点的 2499 汉字稿在 2500 下限下必须被拦（旧 \p{Script=Han} 同样不计标点，
  // 此用例主要钉「去标题行」与字符集不回退）。
  it("length count excludes punctuation/whitespace/title (unified countDraftChineseCharacters)", async () => {
    const projectDir = await createFixtureProject();
    await writeWritingRules(projectDir, { minWords: 2500 });

    const draft = `# 第一章 标题行的汉字不该计入\n\n${"林远数着台阶往上报数，一步一句，句句押着鼓点！".repeat(50)}\n`;
    const report = await checkDraftBeforeCommit({ projectDir, chapter: 1, draftContent: draft });
    // 正文每句 20 汉字（，！不计）×50 = 1000 < 2500 → 拦；消息里的 current 是纯汉字数（1000），
    // 不是含标点的全字符数（1150）——口径统一钉死。
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "too_short", message: expect.stringContaining("(current: 1000)") }),
    ]));
  });

  it("rejects title-only drafts", async () => {
    const projectDir = await createFixtureProject();

    const report = await checkDraftBeforeCommit({
      projectDir,
      chapter: 1,
      draftContent: "# 第一章\n",
    });

    expect(report.passed).toBe(false);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "error", type: "title_only" }),
    ]));
  });

  it("warns when a draft has no obvious chapter title", async () => {
    const projectDir = await createFixtureProject();

    const report = await checkDraftBeforeCommit({
      projectDir,
      chapter: 1,
      draftContent: longDraft({ characterName: "林远", withTitle: false, withDialogue: true }),
    });

    expect(report.passed).toBe(true);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "warning", type: "missing_chapter_title" }),
    ]));
  });

  it("adds info when a draft has no obvious dialogue", async () => {
    const projectDir = await createFixtureProject();

    const report = await checkDraftBeforeCommit({
      projectDir,
      chapter: 1,
      draftContent: longDraft({ characterName: "林远", withTitle: true, withDialogue: false }),
    });

    expect(report.passed).toBe(true);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "info", type: "no_dialogue" }),
    ]));
  });

  it("does not reference legacy InkOS packages", async () => {
    const sourcePath = join(import.meta.dirname, "commit-quality-check.ts");
    const source = await import("node:fs/promises").then((fs) => fs.readFile(sourcePath, "utf-8"));

    expect(source).not.toMatch(new RegExp([
      ["packages", "core"].join("/"),
      ["@actalk", "inkos-core"].join("/"),
      ["Pipeline", "Runner"].join(""),
    ].join("|")));
  });

  // R5b 题材中立化护栏：源码不得写死任何题材特定专名（末日/财团/魂钢/申请表/孵化楼…）。
  // 用拆词拼接绕开「pin 测试匹配到测试自身字符串」的问题，逐个断言。
  it("keeps the commit-quality source free of genre-specific proper nouns", async () => {
    const sourcePath = join(import.meta.dirname, "commit-quality-check.ts");
    const source = await import("node:fs/promises").then((fs) => fs.readFile(sourcePath, "utf-8"));
    const bannedTerms = [
      ["豪", "车"].join(""),
      ["别", "墅"].join(""),
      ["黑", "卡"].join(""),
      ["魂", "钢"].join(""),
      ["储物", "戒"].join(""),
      ["百万", "现金"].join(""),
      ["孵化", "楼"].join(""),
      ["行政", "楼"].join(""),
      ["政务", "大厅"].join(""),
      ["中心", "广场"].join(""),
      ["欠费", "手机"].join(""),
      ["申请", "表"].join(""),
      ["公交", "卡"].join(""),
      ["神", "器"].join(""),
    ];
    for (const term of bannedTerms) {
      expect(source, `must not hardcode genre term: ${term}`).not.toContain(term);
    }
  });
});

async function createFixtureProject(protagonistName: string | null = "林远"): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "story-engine-quality-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title: "质量检查测试",
    genre: "修仙爽文",
    logline: "用户自己当主角，从外院废柴逆袭到掌控组织。",
    ...(protagonistName ? { protagonistName } : {}),
  });
  return projectDir;
}

async function writeCards(projectDir: string, ops: readonly CardOp[]): Promise<void> {
  const outcome = await runCommand(projectDir, cardWrite, { ops }, { caller: "author", idempotencyKey: `t-${randomUUID()}` });
  if (!outcome.ok) throw new Error(outcome.message);
}

function longDraft(input: {
  readonly characterName: string;
  readonly withTitle: boolean;
  readonly withDialogue: boolean;
}): string {
  const title = input.withTitle ? "# 第一章 外院园圃\n\n" : "";
  const dialogue = input.withDialogue ? `${input.characterName}说：“我不会再让他们随意夺走我的月钱。”\n\n` : "";
  const paragraph = [
    `${input.characterName}站在外院园圃的青石路上，袖口沾着晨露和药泥，心里却比任何时候都清醒。`,
    "管事刚刚把最差的灵田分给他，又当着众人的面扣下半袋粮米，仿佛这只是成员理所当然要吞下的苦头。",
    "他没有立刻争辩，而是把账册上每一个被涂改的数字都记在心里，知道真正的机会不会来自怒火，只会来自证据、耐心和一次准确的反击。",
  ].join("");
  return `${title}${dialogue}${Array.from({ length: 5 }, () => paragraph).join("\n\n")}\n`;
}

/** 在设定卡的写作规则里定每章目标字数 / 至少字数。 */
async function writeWritingRules(projectDir: string, chapterLength: { readonly targetWords?: number; readonly minWords?: number }): Promise<void> {
  await writeCards(projectDir, [
    ...(chapterLength.targetWords !== undefined ? [{ op: "rules.set" as const, field: "targetWords" as const, value: chapterLength.targetWords }] : []),
    ...(chapterLength.minWords !== undefined ? [{ op: "rules.set" as const, field: "minWords" as const, value: chapterLength.minWords }] : []),
  ]);
}

/**
 * 构造【正文纯汉字数恰为 N】的草稿（含标题、主角名与对话，满足除长度外的其余质检门）。
 * 与 countDraftChineseCharacters 同字符集逐字累加，标点/空白不计——钉「精确到字」的下限边界。
 */
function draftOfExactlyChineseChars(target: number): string {
  const cjk = /[\u3400-\u9fff]/u;
  let body = "";
  let count = 0;
  const append = (text: string): void => {
    for (const ch of text) {
      if (count >= target) return;
      body += ch;
      if (cjk.test(ch)) count += 1;
    }
  };
  append("林远说：“先记下来，回头对账。”");
  const filler = "檐角的铜铃被风吹得轻响，他把袖口的灰拍净，沿着廊下慢慢往前走，心里把下一步又推了一遍。";
  while (count < target) append(filler);
  return `# 第一章 长度边界\n\n${body}\n`;
}
