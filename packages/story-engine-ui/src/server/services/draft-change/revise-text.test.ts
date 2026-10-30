// @vitest-environment node
//
// 改一段（reviseDraftText，draft.change revise 用它）：定位、精确替换、接缝去重、漂移 / no-op / 目标没动的诚实守卫。
// 只换模型输出；读稿写稿在测试里自己做（reviseDraftText 不碰盘）。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { createStoryProject } from "../../book/project-store.js";
import { makeHomeTempDir } from "../../lib/home-test-tmp.js";
import { defaultDraftPath } from "../../lib/project-io.js";
import { locateRevisionSpan as locateTargetSpan, reviseDraftText, type ReviseTextInput } from "./revise-text.js";

describe("locateTargetSpan B4 改写定位（空白归一兜底）", () => {
  const draft = "第一段在这里。\n\n他缓缓抬起头，看向窗外的雨。\n\n第三段收尾。";

  it("精确唯一命中 → 返回 span", () => {
    const r = locateTargetSpan(draft, "他缓缓抬起头，看向窗外的雨。");
    expect(r).toEqual({ start: draft.indexOf("他缓缓抬起头"), end: draft.indexOf("他缓缓抬起头") + "他缓缓抬起头，看向窗外的雨。".length });
  });

  it("出现多次 → ambiguous", () => {
    expect(locateTargetSpan("重复句。重复句。", "重复句。")).toBe("ambiguous");
  });

  it("引号风格不一致（磁盘 curly “”，目标用 ASCII \"\" 或 「」）→ 引号归一兜底仍定位回真实区间（afterfix·改稿可用性）", () => {
    const d = "前段。\n\n“灯是我亲手关的。”\n\n后段。";
    for (const t of ["\"灯是我亲手关的。\"", "「灯是我亲手关的。」", "灯是我亲手关的。"]) {
      const r = locateTargetSpan(d, t);
      expect(r).not.toBe("not_found");
      expect(r).not.toBe("ambiguous");
    }
  });

  it("B4：模型回吐片段空白不一致（全角空格/多空格）→ 空白归一兜底仍定位回真实原文", () => {
    // 目标里把句中插了半角空格、换行被压成空格，精确 indexOf 必然失败
    const r = locateTargetSpan(draft, "他缓缓抬起头， 看向窗外的雨。");
    expect(r).not.toBe("not_found");
    expect(r).not.toBe("ambiguous");
    const span = r as { start: number; end: number };
    expect(draft.slice(span.start, span.end)).toBe("他缓缓抬起头，看向窗外的雨。"); // 切回的是真实原文
  });

  it("真的不在草稿里 → not_found（诚实拒绝、不乱猜）", () => {
    expect(locateTargetSpan(draft, "这段根本不存在于草稿。")).toBe("not_found");
  });

  it("重构 P6：模型用「……」连起两截（可跨段）→ 取第一截开头到最后一截结尾", () => {
    const r = locateTargetSpan(draft, "在这里。……抬起头，看向");
    const span = r as { start: number; end: number };
    expect(draft.slice(span.start, span.end)).toBe("在这里。\n\n他缓缓抬起头，看向");
    // 截的顺序反了 / 某截不在稿里 → not_found；第一截出现多次 → ambiguous。
    expect(locateTargetSpan(draft, "看向窗外……第一段")).toBe("not_found");
    expect(locateTargetSpan("重复句。中间。重复句。尾巴。", "重复句。……尾巴")).toBe("ambiguous");
  });
});

async function makeProject(title: string): Promise<string> {
  const rootDir = await makeHomeTempDir("revise-text-");
  const { projectDir } = await createStoryProject({
    rootDir,
    title,
    genre: "都市",
    logline: "主角进入权力中心。",
    protagonistName: "林远",
  });
  return projectDir;
}

async function writeDraft(projectDir: string, chapter: number, content: string): Promise<void> {
  await mkdir(dirname(defaultDraftPath(projectDir, chapter)), { recursive: true });
  await writeFile(defaultDraftPath(projectDir, chapter), content, "utf-8");
}

/** 读盘上的稿、改、改成了写回去（测试里代替配方的读稿换稿）。 */
async function reviseOnDisk(input: Omit<ReviseTextInput, "draftContent">) {
  const path = defaultDraftPath(input.projectDir, input.chapter);
  const out = await reviseDraftText({ ...input, draftContent: await readFile(path, "utf-8") });
  if (out.ok) await writeFile(path, out.updatedContent, "utf-8");
  return { ...out, applied: out.ok };
}

describe("reviseDraftText 改一段：定位、精确替换、接缝、诚实守卫", () => {
  it("命中唯一原文 → 确定性替换", async () => {
    const projectDir = await makeProject("修订");
    await writeDraft(projectDir, 1, "# 第1章\n\n林远推开了那扇门，门后是空荡的走廊。\n");
    const out = await reviseOnDisk({
      projectDir,
      chapter: 1,
      targetText: "林远推开了那扇门",
      revisionGoal: "把动作写得更克制一些。",
      callModel: async () =>
        JSON.stringify({
          beforeText: "林远推开了那扇门",
          afterText: "林远轻轻带上了那扇门",
          changeSummary: "弱化动作幅度。",
        }),
    });
    expect(out.ok).toBe(true);
    expect(out.applied).toBe(true);
    const onDisk = await readFile(defaultDraftPath(projectDir, 1), "utf-8");
    expect(onDisk).toContain("林远轻轻带上了那扇门");
    expect(onDisk).not.toContain("林远推开了那扇门");
    expect(out.preview?.afterText).toContain("轻轻带上");
  });

  it("模型把目标段紧跟着的半句也抄进新文本 → 接缝处去重，不落成「边角发潮，边角发潮」（2026-10-23 按核账改考卷）", async () => {
    const projectDir = await makeProject("接缝去重");
    await writeDraft(projectDir, 1, "# 第1章\n\n那封信还在，夹在工装第二颗和第三颗扣子之间，边角发潮。\n\n她把胶鞋压回去。\n");
    const out = await reviseOnDisk({
      projectDir,
      chapter: 1,
      targetText: "那封信还在，夹在工装第二颗和第三颗扣子之间",
      revisionGoal: "和第 2 章「塞进旧工装底下」对上",
      callModel: async () => JSON.stringify({
        beforeText: "那封信还在，夹在工装第二颗和第三颗扣子之间",
        afterText: "那封信还在，折着，压在工装底下，边角发潮",
        changeSummary: "改藏法。",
      }),
    });
    expect(out.ok).toBe(true);
    const onDisk = await readFile(defaultDraftPath(projectDir, 1), "utf-8");
    expect(onDisk).toContain("那封信还在，折着，压在工装底下，边角发潮。");
    expect(onDisk).not.toContain("边角发潮，边角发潮");
    // 开头抄重同理：新文本以原文紧挨在前面的半句开头 → 去掉。
    await writeDraft(projectDir, 1, "# 第1章\n\n她回到更衣间，柜门推开，旧工装挂在里头。\n");
    const head = await reviseOnDisk({
      projectDir,
      chapter: 1,
      targetText: "旧工装挂在里头",
      revisionGoal: "和第 2 章「最底下压着一件旧工装」对上",
      callModel: async () => JSON.stringify({ beforeText: "旧工装挂在里头", afterText: "柜门推开，旧工装还叠在最底下", changeSummary: "改摆法。" }),
    });
    expect(head.ok).toBe(true);
    expect(await readFile(defaultDraftPath(projectDir, 1), "utf-8")).toContain("她回到更衣间，柜门推开，旧工装还叠在最底下。");
  });

  it("要改的那截不带句号、新文本自己收了句号 → 接缝不落成「。。」（换题材长篇实跑 2026-10-27）", async () => {
    const projectDir = await makeProject("接缝标点");
    await writeDraft(projectDir, 1, "# 第1章\n\n方总说，“杭州那个项目，两周内进场。你自己定。”\n");
    const out = await reviseOnDisk({
      projectDir,
      chapter: 1,
      targetText: "杭州那个项目，两周内进场",
      revisionGoal: "",
      replacementText: "杭州那个项目往后推了，两周后进场。",
      callModel: async () => {
        throw new Error("精确替换不调模型");
      },
    });
    expect(out.ok).toBe(true);
    expect(await readFile(defaultDraftPath(projectDir, 1), "utf-8")).toContain("“杭州那个项目往后推了，两周后进场。你自己定。”");
  });

  it("新文本多包的引号不叠在接缝上、不在话说一半时收引号；原本就是引语的照常（长篇连写 2026-10-24）", async () => {
    const projectDir = await makeProject("接缝引号");
    const revise = async (body: string, targetText: string, afterText: string): Promise<string> => {
      await writeDraft(projectDir, 1, `# 第1章\n\n${body}\n`);
      const out = await reviseOnDisk({
        projectDir,
        chapter: 1,
        targetText,
        revisionGoal: "和前文对上",
        callModel: async () => JSON.stringify({ beforeText: targetText, afterText, changeSummary: "改。" }),
      });
      expect(out.ok).toBe(true);
      return readFile(defaultDraftPath(projectDir, 1), "utf-8");
    };
    // 引号里面那截，新文本自己又包了一对 → 两头都去掉。
    expect(await revise("“家里旧物。”她说，“寄存人是谁，底单上有名字。”", "寄存人是谁，底单上有名字。", "“寄存人是谁，底单上写着。”"))
      .toContain("她说，“寄存人是谁，底单上写着。”\n");
    // 只在收尾那头叠了。
    expect(await revise("孟叔说：“这把是外头配的私齿。”", "这把是外头配的私齿。", "这把不是局里出的，是外头配的私齿。”"))
      .toContain("孟叔说：“这把不是局里出的，是外头配的私齿。”\n");
    // 半段话（开了引号没收），新文本把引号收了 → 后面原文还接着说，不多出收引号。
    expect(await revise("孟叔摩挲着包带，“说好三天内取。船没靠岸。”", "孟叔摩挲着包带，“说好三天内取。", "孟叔摩挲着包带，“说好就是那晚取，人没来。”"))
      .toContain("孟叔摩挲着包带，“说好就是那晚取，人没来。船没靠岸。”\n");
    // 模型回的是英文直引号 → 换成中文引号再落地；作者整篇用直引号的稿子跟着作者的写法不换。
    expect(await revise("“家里旧物。”她说。他摇头。", "他摇头。", "\"不对。\"他摇了摇头。"))
      .toContain("“家里旧物。”她说。“不对。”他摇了摇头。");
    expect(await revise("\"家里旧物。\"她说。他摇头。", "他摇头。", "\"不对。\"他摇了摇头。"))
      .toContain("\"家里旧物。\"她说。\"不对。\"他摇了摇头。");
    // 叙述改成引语（原本不在引号里）→ 照常。
    expect(await revise("他摇头。他说不去。灯灭了。", "他说不去。", "“我不去。”"))
      .toContain("他摇头。“我不去。”灯灭了。");
  });

  it("模型漂移到别的句子（改了别处、用户点名的目标句仍逐字留稿）→ 诚实 ok:false/applied:false，绝不谎称已改（afterfix·改稿谎报根治）", async () => {
    const projectDir = await makeProject("改稿漂移谎报");
    const draft = "# 第1章\n\n灯是我亲手关的。\n\n他点了点头，没有说话。\n";
    await writeDraft(projectDir, 1, draft);
    const out = await reviseOnDisk({
      projectDir,
      chapter: 1,
      targetText: "灯是我亲手关的。", // 用户点名要改/删这句
      revisionGoal: "删掉这句。",
      // 模型漂移：beforeText 指向草稿里【另一句】、改了别处，用户的目标句一个字没动
      callModel: async () =>
        JSON.stringify({ beforeText: "他点了点头，没有说话。", afterText: "他缓缓点了下头。", changeSummary: "润色" }),
    });
    expect(out.ok).toBe(false);
    expect(out.applied).toBe(false);
    const onDisk = await readFile(defaultDraftPath(projectDir, 1), "utf-8");
    expect(onDisk).toContain("灯是我亲手关的。"); // 目标句仍在=没被改 → 必须诚实拒、不落盘
    expect(out).toMatchObject({ code: "drift_rejected" });
  });

  it("给了精确替换文本 → 原样落地、跳过模型改写（afterfix·真机：模型拿到精确文本却自行改写成别的）", async () => {
    const projectDir = await makeProject("精确替换");
    await writeDraft(projectDir, 1, "# 第1章\n\n“灯是我亲手关的。”\n\n他没再说话。\n");
    let modelCalled = false;
    const out = await reviseOnDisk({
      projectDir,
      chapter: 1,
      targetText: "\"灯是我亲手关的。\"", // ASCII 引号（磁盘 curly），靠引号归一定位
      revisionGoal: "换成我指定的句子。",
      replacementText: "“灯灭前，有人承认自己碰过开关，但声音在关键处被海浪吞掉。”",
      callModel: async () => { modelCalled = true; return "{}"; },
    });
    expect(out.ok).toBe(true);
    expect(out.applied).toBe(true);
    expect(modelCalled).toBe(false); // 确定性：没调模型
    const onDisk = await readFile(defaultDraftPath(projectDir, 1), "utf-8");
    expect(onDisk).toContain("灯灭前，有人承认自己碰过开关，但声音在关键处被海浪吞掉"); // 精确文本原样落地
    expect(onDisk).not.toContain("灯是我亲手关的");
  });

  it("精确替换文本与原句一致 → no-op 诚实拒，不谎称已改", async () => {
    const projectDir = await makeProject("精确替换no-op");
    await writeDraft(projectDir, 1, "# 第1章\n\n原样这句。\n");
    const out = await reviseOnDisk({
      projectDir,
      chapter: 1,
      targetText: "原样这句。",
      revisionGoal: "换。",
      replacementText: "原样这句。",
      callModel: async () => "{}",
    });
    expect(out.ok).toBe(false);
    expect(out.applied).toBe(false);
  });

  it("对白引号风格不一致也能真改稿：磁盘 curly “”、目标/模型用 ASCII \"\" → 真替换、写回、ok:true（afterfix·改稿可用性）", async () => {
    const projectDir = await makeProject("引号改稿");
    await writeDraft(projectDir, 1, "# 第1章\n\n“灯是我亲手关的。”\n\n他没再说话。\n");
    const out = await reviseOnDisk({
      projectDir,
      chapter: 1,
      targetText: "\"灯是我亲手关的。\"", // ASCII 引号（磁盘是 curly “”）
      revisionGoal: "改写这句对白。",
      callModel: async () =>
        JSON.stringify({
          beforeText: "\"灯是我亲手关的。\"", // 模型也用 ASCII 引号
          afterText: "“灯灭前，有人碰过开关。”",
          changeSummary: "改写对白",
        }),
    });
    expect(out.ok).toBe(true);
    expect(out.applied).toBe(true);
    const onDisk = await readFile(defaultDraftPath(projectDir, 1), "utf-8");
    expect(onDisk).toContain("灯灭前，有人碰过开关");
    expect(onDisk).not.toContain("灯是我亲手关的");
  });

  it("模型把片段原样 echo 回（afterText===beforeText）→ no-op：诚实 applied:false，不谎称已完成修订", async () => {
    const projectDir = await makeProject("echo空操作");
    const draft = "# 第1章\n\n林远推开了那扇门，门后是空荡的走廊。\n";
    await writeDraft(projectDir, 1, draft);
    const out = await reviseOnDisk({
      projectDir,
      chapter: 1,
      targetText: "林远推开了那扇门",
      revisionGoal: "把动作写得更克制一些。",
      callModel: async () =>
        JSON.stringify({
          beforeText: "林远推开了那扇门",
          afterText: "林远推开了那扇门", // 原样 echo 回 → 等于没改
          changeSummary: "（实际没有改动）",
        }),
    });
    expect(out.ok).toBe(false);
    expect(out.applied).toBe(false);
    expect(out).toMatchObject({ code: "noop" });
  });

  it("B3：style=deai → 去 AI 味手法注入修订目标、喂进 prompt（agent 能驱动去 AI 味，不退化成普通润色）", async () => {
    const projectDir = await makeProject("去AI味");
    await writeDraft(projectDir, 1, "# 第1章\n\n那一刻，他心中五味杂陈，仿佛整个世界都安静了。\n");
    let capturedPrompt = "";
    const out = await reviseOnDisk({
      projectDir,
      chapter: 1,
      targetText: "那一刻，他心中五味杂陈，仿佛整个世界都安静了。",
      revisionGoal: "", // 去 AI 味不必额外目标，靠 style 注入手法
      style: "deai",
      callModel: async (prompt) => {
        capturedPrompt = prompt;
        return JSON.stringify({
          beforeText: "那一刻，他心中五味杂陈，仿佛整个世界都安静了。",
          afterText: "他捏紧了杯子，没说话。窗外的车流一辆接一辆。",
          changeSummary: "去掉抒情套路，改成具体动作。",
        });
      },
    });
    expect(out.ok).toBe(true);
    expect(capturedPrompt).toContain("AI 腔");      // 去 AI 味手法确实进了 prompt
    expect(capturedPrompt).toContain("具体的动作");
  });

  it("原文片段在草稿中出现多次 → 诚实拒绝，不改", async () => {
    const projectDir = await makeProject("多处");
    await writeDraft(projectDir, 1, "# 第1章\n\n林远走进来。后来林远走进来。\n");
    const out = await reviseOnDisk({
      projectDir,
      chapter: 1,
      targetText: "林远走进来",
      revisionGoal: "改写。",
      callModel: async () =>
        JSON.stringify({ beforeText: "林远走进来", afterText: "林远快步进来", changeSummary: "改" }),
    });
    expect(out.ok).toBe(false);
    expect(out.applied).toBe(false);
    expect(out).toMatchObject({ code: "target_ambiguous" });
    const onDisk = await readFile(defaultDraftPath(projectDir, 1), "utf-8");
    expect(onDisk).toContain("后来林远走进来");
  });

  it("原文片段不在草稿中 → 诚实拒绝，不写回", async () => {
    const projectDir = await makeProject("缺片段");
    await writeDraft(projectDir, 1, "# 第1章\n\n林远站在窗前。\n");
    const out = await reviseOnDisk({
      projectDir,
      chapter: 1,
      targetText: "完全不存在的一段话",
      revisionGoal: "改写。",
      callModel: async () => JSON.stringify({ afterText: "随便" }),
    });
    expect(out.ok).toBe(false);
    expect(out.applied).toBe(false);
    expect(out).toMatchObject({ code: "target_not_found" });
  });
});
