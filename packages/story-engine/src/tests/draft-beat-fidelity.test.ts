import { describe, expect, it } from "vitest";
import { checkDraftBeatFidelity } from "../draft-beat-fidelity.js";

// 出稿首稿保真度（Codex 复测额外发现：首稿把「第三块砖」写成「第三层杂志架」、「债权池A-17」写成数字串、漏 beat）。
// 确定性、题材中立、只软警告不阻塞：检查用户/agent 指定的「必须命中要点」里的【具体锚点】（标识符码 / 数字+量词+名物）
// 是否落进草稿；缺了就报 missing。纯结果/可改写的 beat（无具体锚点）跳过不检（避免误杀正常改写）。
describe("checkDraftBeatFidelity · 出稿后保真软警告", () => {
  it("空 beat 列表 → passed、无 issue", () => {
    const r = checkDraftBeatFidelity({ draftContent: "随便一段正文。", mustHitBeats: [] });
    expect(r.passed).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.missingBeats).toEqual([]);
  });

  it("标识符锚点命中（草稿原样含 A-17）→ 不算缺", () => {
    const r = checkDraftBeatFidelity({
      draftContent: "她在收据背面看见一行小字：债权池A-17。",
      mustHitBeats: ["债权池A-17"],
    });
    expect(r.missingBeats).toEqual([]);
    expect(r.checkedBeats).toContain("债权池A-17");
    expect(r.passed).toBe(true);
  });

  it("标识符被写歪（A-17 写成数字串）→ 报缺", () => {
    const r = checkDraftBeatFidelity({
      draftContent: "她看见一行字：债权池17号。",
      mustHitBeats: ["债权池A-17"],
    });
    expect(r.missingBeats).toContain("债权池A-17");
    expect(r.passed).toBe(false);
    expect(r.issues[0]).toMatchObject({ severity: "warning", type: "missing_required_beat", beat: "债权池A-17" });
  });

  it("纯结果/可改写 beat（无具体锚点，如「周衡会先倒霉」）→ 跳过不检、不误报", () => {
    const r = checkDraftBeatFidelity({
      draftContent: "许鸣警告她，再查下去，周衡的铺子会被强制清算。",
      mustHitBeats: ["周衡会先倒霉"],
    });
    expect(r.missingBeats).toEqual([]);
    expect(r.checkedBeats).not.toContain("周衡会先倒霉"); // 无锚点=不可检=跳过
    expect(r.passed).toBe(true);
  });

  it("多 beat 混合：可检的命中/漏 各自判定，不可检的跳过", () => {
    const r = checkDraftBeatFidelity({
      draftContent: "她撬开第三块砖，取出收据，上面写着债权池17号。许鸣来了。",
      mustHitBeats: ["第三块砖", "债权池A-17", "许鸣登场威胁"],
    });
    // A-17 漏；「第三块砖」「许鸣登场威胁」没有编号也没有引号台词，不做字面核对（重构 P7 删了量词名物猜测）
    expect(r.missingBeats).toEqual(["债权池A-17"]);
    expect(r.checkedBeats).toEqual(["债权池A-17"]);
  });
});

// 对抗性审查（13 agent）确认的 4 类弱点：标识符整章拼接串吞误（超串/跨token）、量词表不全、全角数字、名物泛匹配。
describe("checkDraftBeatFidelity · 对抗性审查暴露弱点的修复", () => {
  it("标识符超串：A-17 漏写但草稿含 A-170 → 仍报缺（不被超串吞掉）", () => {
    const r = checkDraftBeatFidelity({
      draftContent: "法院只冻结了A-170账户，别的没动。",
      mustHitBeats: ["债权池A-17"],
    });
    expect(r.missingBeats).toContain("债权池A-17");
  });

  it("标识符跨token：草稿有‘A区’和‘第17号’但无 A-17 → 仍报缺（不被拼接成 a17）", () => {
    const r = checkDraftBeatFidelity({
      draftContent: "他走进A区，翻到第17号卷宗，却没找到要的东西。",
      mustHitBeats: ["债权池A-17"],
    });
    expect(r.missingBeats).toContain("债权池A-17");
  });

  it("标识符精确命中仍判通过（不回归）", () => {
    const r = checkDraftBeatFidelity({
      draftContent: "她翻到收据，背面写着债权池A-17。",
      mustHitBeats: ["债权池A-17"],
    });
    expect(r.missingBeats).toEqual([]);
  });

  it("全角标识符：草稿把 A-17 写成全角Ａ－１７ → 不误报（视为已命中）", () => {
    const r = checkDraftBeatFidelity({
      draftContent: "她翻到收据，背面写着债权池Ａ－１７。",
      mustHitBeats: ["债权池A-17"],
    });
    expect(r.missingBeats).toEqual([]);
  });

});

// Codex retest4：beat「乔蔓语气冷淡，"别碰药柜左边那排。"」无标识符/量词名物锚点 → 被现有逻辑直接跳过，
// 从未被检查；草稿里这句台词逐字命中，但说话人被写成了秦屿（不是乔蔓），agent 仍口头称「全部命中」——
// 看起来通过、其实没真核对说话人。新增「说话人归属」锚点：beat 含「具名角色+归属动词/语气词+引号台词」时，
// 核对草稿里这句台词的出现处，说话人是否真是指定的那个角色。V1 只认「说话人在引号之前」语序（与仓库已有
// isDialogueAttributionSentence 同方言对齐）；反序「『……』X说。」是已知局限，留给下一轮真机撞到再扩。
// 要点里引号括起来的台词只核「正文里原样出现了没有」；谁说的不再按分句主语猜（重构 P7「不猜」）。
describe("checkDraftBeatFidelity · 要点里的引号台词原样核对", () => {
  it("台词逐字命中、说话人也对 → 通过（不误报）", () => {
    const r = checkDraftBeatFidelity({
      draftContent: "乔蔓语气冷淡，“别碰药柜左边那排。”",
      mustHitBeats: ["乔蔓语气冷淡，“别碰药柜左边那排。”"],
    });
    expect(r.missingBeats).toEqual([]);
    expect(r.checkedBeats).toContain("乔蔓语气冷淡，“别碰药柜左边那排。”");
    expect(r.passed).toBe(true);
  });

  it("台词压根没写进草稿 → 按现有缺失语义报 missing_required_beat（不是 speaker_misattribution）", () => {
    const r = checkDraftBeatFidelity({
      draftContent: "陆峥站在药柜前，什么也没说。",
      mustHitBeats: ["乔蔓语气冷淡，“别碰药柜左边那排。”"],
    });
    expect(r.missingBeats).toContain("乔蔓语气冷淡，“别碰药柜左边那排。”");
    expect(r.issues[0]).toMatchObject({ type: "missing_required_beat" });
  });

  it("台词命中但归属结构模糊（转述/回忆，抽不出清晰说话人）→ 跳过不报（favor 低误报）", () => {
    const r = checkDraftBeatFidelity({
      draftContent: "陆峥想起乔蔓那句“别碰药柜左边那排。”，心头一紧。",
      mustHitBeats: ["乔蔓语气冷淡，“别碰药柜左边那排。”"],
    });
    expect(r.missingBeats).toEqual([]);
    expect(r.passed).toBe(true);
  });

  it("说话人代词（他/她/对方…）不当作真实归属、不误判 mismatch", () => {
    const r = checkDraftBeatFidelity({
      draftContent: "她语气冷淡，“别碰药柜左边那排。”",
      mustHitBeats: ["乔蔓语气冷淡，“别碰药柜左边那排。”"],
    });
    // 抽不出清晰具名说话人（代词被排除）→ 模糊跳过，不误报 mismatch
    expect(r.missingBeats).toEqual([]);
  });

  it("同一台词出现多次，至少一处说话人对 → 通过", () => {
    const r = checkDraftBeatFidelity({
      draftContent: "秦屿冷笑，“别碰药柜左边那排。”陆峥没理他。乔蔓语气冷淡，“别碰药柜左边那排。”",
      mustHitBeats: ["乔蔓语气冷淡，“别碰药柜左边那排。”"],
    });
    expect(r.missingBeats).toEqual([]);
  });

});
