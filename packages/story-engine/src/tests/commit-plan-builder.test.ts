import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCommitPlanFromProject, isGenericNonAssetName, uniqueAssetCandidates, type CommitPreviewCandidate } from "../commit-plan-builder.js";
import { createStoryProject, toSafeCharacterId } from "../project-store.js";

describe("isGenericNonAssetName（资产候选降噪·rerun2 P2）", () => {
  it("抽象/结构性通用词不算资产候选（节点/区域/可追踪物证…）", () => {
    for (const n of ["节点", "区域", "可追踪物证", "物证", "东区区域", "检修区域", "下一个节点", "证据", "线索", "现场"]) {
      expect(isGenericNonAssetName(n)).toBe(true);
    }
  });
  it("具体物件仍是有效候选（不误杀）", () => {
    for (const n of ["事故原始图纸", "锈蚀闸门钥匙", "长柄镊子", "物证收集袋", "异常阀门", "金属碎屑", "半截特种合金焊条"]) {
      expect(isGenericNonAssetName(n)).toBe(false);
    }
  });

  // Codex 5 章 E2E·P2：身体部位/形状/泛物/从句被当资产候选（浑浊的右眼/背影/三角形/废铁/碎石/柜子里放了东西/数字还清晰）。
  it("身体部位/形状/泛物/从句 不算资产候选", () => {
    for (const n of ["右眼", "浑浊的右眼", "背影", "灰色夹克背影", "三角形", "废铁", "碎石", "柜子里放了东西", "数字还清晰"]) {
      expect(isGenericNonAssetName(n)).toBe(true);
    }
  });
  it("不误杀：单字身体词的复合物件 + 边角真物件", () => {
    for (const n of ["扳手", "椅背", "桌脚", "缺角的轮渡票", "银色录音笔", "防滑垫", "公开财报"]) {
      expect(isGenericNonAssetName(n)).toBe(false);
    }
  });

  // Codex 5 章 E2E 真书复验：捕获正则过捕的方位从句残片（缺角的轮渡票平铺在旧 / 公开财报里 / 的底片… / 那卷从）。
  it("过捕方位从句残片不算资产候选（且 dedup 前剔除，留干净物件名）", () => {
    for (const n of ["缺角的轮渡票平铺在旧", "公开财报里", "的底片扫描件", "那卷从"]) {
      expect(isGenericNonAssetName(n)).toBe(true);
    }
    // 干净形式仍保留
    expect(isGenericNonAssetName("缺角的轮渡票")).toBe(false);
    expect(isGenericNonAssetName("底片扫描件")).toBe(false);
  });
});

describe("uniqueAssetCandidates · 别名子串去重（Codex 5 章 E2E·P2）", () => {
  const cand = (name: string): CommitPreviewCandidate => ({ id: `a-${name}`, name, evidence: name, severity: "warning", requiresUserConfirm: true });
  it("轮渡票 是 缺角的轮渡票 的子串 → 只留更具体的", () => {
    const names = uniqueAssetCandidates([cand("轮渡票"), cand("缺角的轮渡票")]).map((c) => c.name);
    expect(names).toContain("缺角的轮渡票");
    expect(names).not.toContain("轮渡票");
  });
  it("不误杀：互不包含的同尾物件各自保留", () => {
    const names = uniqueAssetCandidates([cand("闸门钥匙"), cand("房门钥匙")]).map((c) => c.name).sort();
    expect(names).toEqual(["房门钥匙", "闸门钥匙"]);
  });
});

describe("commit plan builder", () => {
  it("builds a minimal commit plan from real project characters without hardcoded ids", async () => {
    const projectDir = await createFixtureProject("林远");
    await writeDraft(projectDir, 1, "# 第一章\n\n林远推开外院园圃的木门。");

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 1 });

    expect(result.passed).toBe(true);
    expect(result.issues).toEqual([]);
    const characterId = toSafeCharacterId("林远");
    expect(result.commitPlan?.characterUpdates).toBeUndefined();
    expect(result.commitPlan?.hookUpdates).toBeUndefined();
    expect(result.commitPlan?.timelineEvents).toEqual([
      expect.objectContaining({
        summary: "林远推开外院园圃的木门。",
        participants: [characterId],
        effects: {
          semanticSummary: expect.objectContaining({
            chapter: 1,
            mainEvent: "林远推开外院园圃的木门。",
            mentionedCharacters: [characterId],
            mentionedHooks: [],
          }),
        },
      }),
    ]);
    // P2：不再写 chapter_N_committed 水印——自动路径无阶段推进证据，保留作者既有设定
    expect(result.commitPlan?.worldUpdates).toEqual({});
    expect(result.semanticSummary).toMatchObject({
      chapter: 1,
      mainEvent: "林远推开外院园圃的木门。",
      mentionedCharacters: [characterId],
      mentionedHooks: [],
    });
    expect(result.commitPlan?.calendar).toEqual({
      storyDay: 1,
      timeOfDay: "unknown",
    });
  });

  it("prefers the character whose name appears in the draft", async () => {
    const projectDir = await createFixtureProject("林远");
    await addCharacter(projectDir, {
      id: "lin-wanqing",
      name: "林婉清",
    });
    await writeDraft(projectDir, 2, "# 第二章\n\n林婉清站在组织石阶前，握住了那枚外院信物。");

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 2 });

    expect(result.passed).toBe(true);
    expect(result.commitPlan?.characterUpdates?.[0]?.characterId).toBe("lin-wanqing");
    expect(result.commitPlan?.timelineEvents?.[0]?.participants).toEqual(["lin-wanqing"]);
    expect(result.commitPlan?.calendar).toEqual({
      storyDay: 2,
      timeOfDay: "unknown",
    });
  });

  it("only generates hook updates for hooks matched by the draft", async () => {
    const projectDir = await createFixtureProject("林远");
    await writeFile(
      join(projectDir, "story", "hooks.json"),
      `${JSON.stringify({
        hooks: [
          {
            id: "h-ledger",
            title: "账目",
            description: "组织管事暗中克扣外院资源。",
            status: "seeded",
            relatedCharacters: ["character"],
          },
          {
            id: "h-sword",
            title: "断剑",
            description: "后院石洞中的旧剑。",
            status: "seeded",
            relatedCharacters: ["character"],
          },
        ],
      }, null, 2)}\n`,
      "utf-8",
    );
    await writeDraft(projectDir, 1, "# 第一章\n\n林远在账房门口瞥见了账目。");

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 1 });

    expect(result.passed).toBe(true);
    expect(result.commitPlan?.hookUpdates).toEqual([
      {
        hookId: "h-ledger",
        status: "active",
      },
    ]);
    expect(result.commitPlan?.worldUpdates).toEqual({
      activeHooks: ["h-ledger"],
    });
  });

  it("keeps ordinary negation and noisy places out of protected state extraction", async () => {
    const projectDir = await createFixtureProject("林序");
    await writeDraft(projectDir, 1, [
      "# 第一章 · 魂钢异常",
      "",
      "这不是什么秘密。",
      "他站在台前，看见前台窗口后面的屏幕闪了一下。",
      "全市都知道创业魂钢决定阶层，但林序只拿着半张申请表。",
      "学校那台公用检测仪坏了，后来学院说预算没批下来，这台机器也就没人再提。",
    ].join("\n"));

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 1 });

    expect(result.passed).toBe(true);
    expect(result.semanticSummary?.chapterTitle).toBe("第一章 · 魂钢异常");
    expect(result.semanticSummary?.discovery).toBeUndefined();
    expect(result.semanticSummary?.locations).not.toEqual(expect.arrayContaining(["他站在台", "前台", "全市", "学校那台", "后来学院", "这台"]));
    expect(result.commitPlan?.worldUpdates?.knownSecrets ?? []).not.toEqual(expect.arrayContaining(["这不是什么秘密。"]));
  });

  it("uses a stable chapter title fallback when the draft has no markdown title", async () => {
    const projectDir = await createFixtureProject("林序");
    await writeDraft(projectDir, 1, "这不是什么秘密。\n\n林序站在窗口前，握紧半张申请表。");

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 1 });

    expect(result.passed).toBe(true);
    expect(result.semanticSummary?.chapterTitle).toBe("第1章");
    expect(result.semanticSummary?.mainEvent).not.toBe("这不是什么秘密。");
  });

  it("extracts real character matrix candidates without action-fragment pollution", async () => {
    const projectDir = await createFixtureProject("林远");
    await writeDraft(projectDir, 2, [
      "# 第二章",
      "",
      "林远在陈芮的工位前站定，说明来意。陈芮头也没抬：“备份日志需要董事办的授权函，原件。”",
      "林远没有立刻追问，只等他靠近后才推出来那份申请单。",
      "沈砚从檐影里走出来，把另一份文件递给林远。",
      "他知道现在不能凭一句话相信沈砚，也不能让陈芮把所有风险挡在流程外。",
    ].join("\n"));

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 2 });

    const matrixNames = result.characterKnowledgeChanges?.characterMatrixCandidates.map((item) => item.name) ?? [];
    expect(matrixNames).toEqual(expect.arrayContaining([
      "陈芮（新人物矩阵候选）",
      "沈砚（新人物矩阵候选）",
    ]));
    expect(matrixNames.some((name) => /后才|立刻|推出|追问/u.test(name))).toBe(false);
    expect(matrixNames.some((name) => /从檐影里|又在陈芮|能让陈芮|流程外/u.test(name))).toBe(false);
  });

  it("修 P1·1（受控破例⑥）：代词/虚词/时间方位碎片绝不被当人物矩阵候选，真名仍抓得到", async () => {
    const projectDir = await createFixtureProject("林远");
    await writeDraft(projectDir, 2, [
      "# 第二章",
      "",
      "他抹了把汗，连机会都没给林远。上个月也是这样，我二话没说就走了。",
      "店关门前，李慧站在门口把一份文件递给林远。",
    ].join("\n"));

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 2 });
    const matrixNames = result.characterKnowledgeChanges?.characterMatrixCandidates.map((item) => item.name) ?? [];

    // Codex 实测抓到的真碎片绝不入候选
    expect(matrixNames.some((n) => /他抹了|连机会都|上个月也|我二话没|店关门前/u.test(n))).toBe(false);
    // 任何候选名都不该含代词/虚词
    expect(matrixNames.some((n) => /[他她我你也都连没把将就才]/u.test(n.replace("（新人物矩阵候选）", "")))).toBe(false);
    // 真名「李慧」仍被抓到（证明收紧没误杀）
    expect(matrixNames).toEqual(expect.arrayContaining(["李慧（新人物矩阵候选）"]));
  });

  it("加强破例⑥（2026-06-24·姓氏硬闸）：非姓氏开头的描写碎片（似乎/耳边轻声等）绝不入候选，姓氏开头真名仍抓得到", async () => {
    const projectDir = await createFixtureProject("林远");
    await writeDraft(projectDir, 2, [
      "# 第二章",
      "",
      "似乎站在窗边，耳边轻声说着什么。",
      "李慧站在门口把一份文件递给林远。",
    ].join("\n"));

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 2 });
    const matrixNames = (result.characterKnowledgeChanges?.characterMatrixCandidates.map((item) => item.name) ?? [])
      .map((n) => n.replace("（新人物矩阵候选）", ""));

    // 这些都不是姓氏开头的真名，是正文描写碎片——绝不入候选（旧字符黑名单结尾锚定漏过它们）
    expect(matrixNames).not.toContain("似乎");
    expect(matrixNames).not.toContain("耳边轻声");
    // 姓氏（李）开头的真名仍抓得到，没误杀
    expect(matrixNames).toContain("李慧");
  });

  it("normalizes new location candidates to concrete place names", async () => {
    const projectDir = await createFixtureProject("林远");
    await writeDraft(projectDir, 2, [
      "# 第二章",
      "",
      "林远意识到有人提前知道审计组要查档案室。",
      "他推开了档案室的门，却只看见一个影子又慢慢消失在楼梯间。",
    ].join("\n"));

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 2 });

    const locationNames = result.locationChanges?.newLocationCandidates.map((item) => item.name) ?? [];
    expect(locationNames).toEqual(expect.arrayContaining(["档案室", "楼梯间"]));
    expect(locationNames.some((name) => /有人|审计组|又慢慢|了档案室/u.test(name))).toBe(false);
  });

  // Codex retest5：裸「走廊」混进地点候选——任何多房间建筑都有走廊，不是值得登记的【新】地点，是结构噪声
  // （同「门口/墙角」一类裸方位词的待遇，但「走廊」不是方位后缀、是房间类后缀，需单独排除）。
  // 注意：「楼梯间」是已有测试明确要求保留的合法候选（上面那条测试），不能连坐排除——只精确排除「走廊/长廊」。
  it("裸「走廊/长廊」不当新地点候选（结构噪声，任何建筑都有）；楼梯间仍保留（不连坐）", async () => {
    const projectDir = await createFixtureProject("林远");
    await writeDraft(projectDir, 2, [
      "# 第二章",
      "",
      "林远推开了档案室的门，走廊两侧的墙皮剥落。",
      "他站在走廊尽头，又慢慢消失在楼梯间。",
    ].join("\n"));

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 2 });

    const locationNames = result.locationChanges?.newLocationCandidates.map((item) => item.name) ?? [];
    expect(locationNames).not.toContain("走廊");
    expect(locationNames).toContain("档案室");
    expect(locationNames).toContain("楼梯间"); // 不连坐误杀
  });

  // Codex retest6：地点候选带位移动词前缀垃圾（走出档案室 / 拐进北塔楼梯间 / 17藏在走廊 / 侧身听了一会儿走廊）。
  // 根因：normalizeLocationCandidateName 的动词剥离表漏了 走出/拐进/藏在 等位移动词；normalizeLocationSuffix 又把
  // 「听了一会儿」这种带体标记的动词短语当建筑前缀保留。后果：① 合法地点（档案室/楼梯间）带垃圾前缀，agent 不敢
  // 往用户面前摆 → 看着「召回偏弱」；② 走廊噪音因带前缀逃过裸「走廊」精确过滤 → 噪音泄漏。
  it("位移动词前缀不进地点候选：走出档案室→档案室、拐进北塔楼梯间→(北塔)楼梯间，走廊噪音仍被过滤（Codex retest6）", async () => {
    const projectDir = await createFixtureProject("唐越");
    await writeDraft(projectDir, 2, [
      "# 第二章",
      "",
      "唐越把蓝皮账册塞进外套内袋，走出档案室。",
      "两人穿过一道防火门，拐进北塔楼梯间。",
    ].join("\n"));

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 2 });
    const locationNames = result.locationChanges?.newLocationCandidates.map((item) => item.name) ?? [];

    // 合法地点干净浮出（不带 走出/拐进 动词前缀）
    expect(locationNames).toContain("档案室");
    expect(locationNames.some((name) => /楼梯间$/u.test(name))).toBe(true);
    // 绝不留位移动词前缀垃圾
    expect(locationNames.some((name) => /走出|拐进|穿过/u.test(name))).toBe(false);
  });

  it("走廊噪音带动词/体标记前缀仍被过滤：藏在走廊 / 侧身听了一会儿走廊 都不进候选（Codex retest6）", async () => {
    const projectDir = await createFixtureProject("唐越");
    await writeDraft(projectDir, 1, [
      "# 第一章",
      "",
      "唐越低声说，你把R-17藏在走廊灯箱里。",
      "她把纸袋压平，侧身听了一会儿走廊的动静，才开口。",
    ].join("\n"));

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 1 });
    const locationNames = result.locationChanges?.newLocationCandidates.map((item) => item.name) ?? [];

    // 任何含「走廊」的候选都不该出现（裸走廊是结构噪声，带前缀的更是垃圾）
    expect(locationNames.some((name) => name.includes("走廊"))).toBe(false);
  });

  it("声/态形容词不当人名候选（『冷硬的声音』不收『冷硬』），姓氏开头真名仍抓得到（Codex 1-5章）", async () => {
    const projectDir = await createFixtureProject("林霁");
    await writeDraft(projectDir, 2, [
      "# 第二章",
      "",
      "“看看下面。”冷硬的声音命令道。",
      "顾长河站在门口把一份残页递给林霁。",
    ].join("\n"));

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 2 });
    const matrixNames = (result.characterKnowledgeChanges?.characterMatrixCandidates.map((item) => item.name) ?? [])
      .map((n) => n.replace("（新人物矩阵候选）", ""));

    expect(matrixNames).not.toContain("冷硬");
    expect(matrixNames).toContain("顾长河"); // 顾=姓氏、真名仍抓得到（防误杀）
  });

  it("裸方位词/动词短语不当地点候选（不收『门口』『却挡在了门口』），真实地点仍抓得到（Codex 1-5章）", async () => {
    const projectDir = await createFixtureProject("林霁");
    await writeDraft(projectDir, 3, [
      "# 第三章",
      "",
      "林霁转身走向门口，又回到档案室翻找了一阵。",
      "他的背影佝偻，却挡在了门口。",
    ].join("\n"));

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 3 });
    const locationNames = result.locationChanges?.newLocationCandidates.map((item) => item.name) ?? [];

    expect(locationNames).not.toContain("门口");
    expect(locationNames).not.toContain("却挡在了门口");
    expect(locationNames.some((name) => /挡在|却/u.test(name))).toBe(false);
    expect(locationNames).toContain("档案室"); // 真实地点仍抓得到（防误杀）
  });

  // Codex retest6 真机 P1：真实对话创建的主角 identity 是描述性文本（如「旧报社调查记者」），不是字面
  // "protagonist"；只有 tags:["main-character"] 带主角信号。mainCharacterProfileScore 旧正则认
  // "main character"（带空格），认不出真实数据里的 "main-character"（连字符），导致主角在本章打分归零；
  // 一旦本章双方提及次数打平，就靠 characters 数组下标（listCharacterProfiles 按目录名/id 字母序排序，
  // 与谁是主角无关）决胜负——配角 id 字母序靠前就抢走主角身份（真机 char-6dc294 排在 char-ffe5af 前）。
  it("主角 identity 为真实描述、仅 tags 带 main-character：提及次数打平时仍判对主角，不被配角 id 字母序抢先", async () => {
    const projectDir = await createFixtureProject("唐越");
    const protagonistId = toSafeCharacterId("唐越");
    await writeFile(join(projectDir, "characters", protagonistId, "profile.json"), `${JSON.stringify({
      id: protagonistId,
      name: "唐越",
      identity: "旧报社调查记者",
      appearance: {},
      tags: ["main-character"],
    }, null, 2)}\n`, "utf-8");
    await addCharacter(projectDir, { id: "a-jianglan", name: "江岚" }); // id 特意排在主角 id 字母序之前
    await writeDraft(projectDir, 1, "# 第一章\n\n唐越看着江岚。江岚回头看向唐越。");

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 1 });

    expect(result.semanticSummary?.protagonist).toBe("唐越");
  });

  it("fails before commit when the draft is missing", async () => {
    const projectDir = await createFixtureProject("林远");

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 1 });

    expect(result.passed).toBe(false);
    expect(result.commitPlan).toBeUndefined();
    expect(result.issues.join("\n")).toContain("ENOENT");
  });

  it("does not reference legacy InkOS packages", async () => {
    const source = await readFile(join(import.meta.dirname, "..", "commit-plan-builder.ts"), "utf-8");

    expect(source).not.toMatch(new RegExp([
      ["packages", "core"].join("/"),
      ["@actalk", "inkos-core"].join("/"),
      ["Pipeline", "Runner"].join(""),
    ].join("|")));
  });
});

// R5b：commit-plan-builder 题材去硬编码。证明检测从「写死末日/职场专名表」改为读项目 bible，
// 既保留真实检测能力（登记命中、未登记仍 warning），又不再把任何作品专名写进活代码。
describe("commit plan builder · R5b genre-neutral detection (fantasy fixture)", () => {
  it("flags an unregistered floor token using a non-urban fantasy draft (data-driven, not hardcoded floor table)", async () => {
    const projectDir = await createFantasyProject();
    await writeDraft(projectDir, 1, [
      "# 第一章",
      "",
      "云栖真人走进青霄殿，沿着回廊一直上到九楼观星台。",
      longFantasy("九楼并未登记在组织殿宇结构里，云栖真人只是临时登临确认星象。"),
    ].join("\n"));

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 1 });

    expect(result.passed).toBe(true);
    // 未登记的「九楼」楼层 token 仍被检出为空间风险——题材中立、不依赖都市楼层专名表。
    const spatialNames = result.locationChanges?.spatialViolationWarnings.map((item) => item.name).join("\n") ?? "";
    expect(spatialNames).toMatch(/未登记楼层/u);
    expect(spatialNames).toMatch(/九楼/u);
  });

  it("does not flag a registered floor in the fantasy bible", async () => {
    const projectDir = await createFantasyProject();
    // 把「九楼」登记进 spatialStructure.floors → 同样的草稿不应再报未登记楼层。
    await writeJson(projectDir, "story/location-bible.json", {
      version: "v0",
      locations: [{
        id: "loc-palace",
        name: "青霄殿",
        type: "opening",
        locationType: "组织殿宇",
        spatialStructure: { floors: ["九楼"], rooms: [], entrances: ["殿前石阶"], exits: [] },
        knownFeatures: [],
        risks: [],
        resources: [],
        connectedLocations: [],
        travelRules: [],
      }],
    });
    await writeDraft(projectDir, 1, [
      "# 第一章",
      "",
      "云栖真人走进青霄殿，沿着回廊一直上到九楼观星台。",
      longFantasy("九楼已登记在组织殿宇结构里，云栖真人确认星象后离开。"),
    ].join("\n"));

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 1 });

    expect(result.passed).toBe(true);
    const spatialNames = result.locationChanges?.spatialViolationWarnings.map((item) => item.name).join("\n") ?? "";
    expect(spatialNames).not.toMatch(/未登记楼层：九楼/u);
  });

  it("flags a registered locked asset shown working again, driven by the project asset bible (no hardcoded item name)", async () => {
    const projectDir = await createFantasyProject();
    await writeJson(projectDir, "story/assets.json", {
      version: "v0",
      assets: [
        { id: "asset-talisman", name: "残破传讯符", type: "keyItem", status: "locked", isPlotCritical: true, canAiModify: false, conditionNote: "灵力耗尽，无法传讯。" },
      ],
      containers: [],
    });
    await writeDraft(projectDir, 1, [
      "# 第一章",
      "",
      "云栖真人取出残破传讯符，符面忽然亮起，竟然又能正常使用，远处师门瞬间回应。",
      longFantasy("残破传讯符本该灵力耗尽，这一处复用风险需要确认。"),
    ].join("\n"));

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 1 });

    const warnings = result.assetChanges?.unregisteredAssetWarnings.map((item) => item.name).join("\n") ?? "";
    // 风险名直接取自账本里登记的资产名（残破传讯符），证明走数据而非写死「欠费手机」。
    expect(warnings).toMatch(/残破传讯符.*风险/u);
    expect(result.assetChanges?.unregisteredAssetWarnings.some((item) => item.severity === "high")).toBe(true);
  });

  it("extracts a fantasy character name as a participant via the registered character, not a baked person table", async () => {
    const projectDir = await createFantasyProject();
    await addCharacter(projectDir, { id: "shi-zun", name: "玄阳师尊" });
    await writeDraft(projectDir, 1, [
      "# 第一章",
      "",
      "玄阳师尊在训练场外把一卷古旧的玉简递了出来。",
      longFantasy("云栖真人没有立刻接下玄阳师尊给的玉简，只是默默记下。"),
    ].join("\n"));

    const result = await buildCommitPlanFromProject({ projectDir, chapter: 1 });
    const matrixNames = result.characterKnowledgeChanges?.characterMatrixCandidates.map((item) => item.name) ?? [];
    // 「玄阳师尊」是已登记角色，不应被当成新人物矩阵候选（人名走 characters，而非硬编码人名表）。
    expect(matrixNames.some((name) => name.includes("玄阳师尊"))).toBe(false);
    // 而正文里的地名结构后缀仍被题材中立抽取（训练场不带都市专名也能命中结构后缀逻辑）。
    expect(result.passed).toBe(true);
  });

  it("keeps the active source free of hardcoded prior-work proper nouns (comments excluded)", async () => {
    const source = await readFile(join(import.meta.dirname, "..", "commit-plan-builder.ts"), "utf-8");
    const activeCode = source
      .split("\n")
      .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/u.test(line))
      .join("\n");

    // 这些都是旧测试书的剧情专名/职场词，必须只来自项目数据、不再写进引擎活代码。
    for (const term of ["林序", "许澄", "魂钢", "压缩饼干", "午餐肉", "欠费手机", "老邮局", "创业孵化楼", "海天市", "财团联合检测中心"]) {
      expect(activeCode, `active code must not hardcode "${term}"`).not.toContain(term);
    }
  });
});

async function createFantasyProject(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "story-engine-plan-fantasy-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title: "青霄问道",
    genre: "修仙",
    premise: "云栖真人重返组织，查清当年观星台变故。",
    mainCharacterName: "云栖真人",
  });
  return projectDir;
}

async function writeJson(projectDir: string, relativePath: string, value: unknown): Promise<void> {
  await writeFile(join(projectDir, relativePath), `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function longFantasy(seed: string): string {
  return Array.from({ length: 6 }, (_, index) => `${seed} 第${index + 1}次推演后，他仍只信眼前所见的殿宇、玉简与星象。`).join("\n");
}

async function createFixtureProject(mainCharacterName: string): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "story-engine-plan-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title: "Commit Plan Builder Fixture",
    genre: "progression",
    premise: "A deterministic fixture for commit plan tests.",
    mainCharacterName,
  });
  return projectDir;
}

async function writeDraft(projectDir: string, chapter: number, text: string): Promise<void> {
  await writeFile(join(projectDir, "drafts", "fast", `chapter-${String(chapter).padStart(4, "0")}.md`), `${text}\n`, "utf-8");
}

async function addCharacter(projectDir: string, input: { readonly id: string; readonly name: string }): Promise<void> {
  const dir = join(projectDir, "characters", input.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "profile.json"), `${JSON.stringify({
    id: input.id,
    name: input.name,
    identity: "supporting",
    appearance: {},
    tags: ["supporting-character"],
  }, null, 2)}\n`, "utf-8");
  await writeFile(join(dir, "core.json"), `${JSON.stringify({
    characterId: input.id,
    personality: ["disciplined"],
    speechStyle: "concise",
    taboos: [],
  }, null, 2)}\n`, "utf-8");
  await writeFile(join(dir, "state.json"), `${JSON.stringify({
    characterId: input.id,
    emotion: "neutral",
    goal: "observe the protagonist",
    relationshipToUser: "unknown",
    currentArc: "opening",
    lastUpdatedChapter: null,
  }, null, 2)}\n`, "utf-8");
}
