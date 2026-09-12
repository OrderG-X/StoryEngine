import { describe, expect, it } from "vitest";
import type { ToolStep } from "../api/types.js";

import {
  detectMissingExecutionForRequest,
  detectUnbackedCompletionClaim,
  honestyRewritePatch,
  isGroundedRefusalReply,
  unbackedCompletionNoticeText,
} from "./detectUnbackedCompletion.js";

const step = (toolName: string, status: ToolStep["status"], result?: { readonly dryRun?: boolean; readonly action?: string }) =>
  ({ id: `s-${toolName}`, label: toolName, toolName, status, startedAt: 1, ...result } as const);

describe("关系整理谎报兜底（R3#2·A1 补『整理/梳理』）", () => {
  it("工具失败却说『人物关系已梳理清楚』→ 命中谎报（A1 兜底）", () => {
    expect(detectUnbackedCompletionClaim("整理结果如下，人物关系已经梳理清楚了。", [step("generate_character_relationships", "failed")])).toBe(true);
  });

  it("工具成功说『关系已梳理』→ 不命中（名副其实）", () => {
    expect(detectUnbackedCompletionClaim("人物关系已经梳理清楚了。", [step("generate_character_relationships", "completed")])).toBe(false);
  });

  it("不含『关系』的『整理』不误伤（整理思路/线索）", () => {
    expect(detectUnbackedCompletionClaim("我把思路整理了一下，给你三个方向。", [])).toBe(false);
  });
});

describe("honestyRewritePatch 诚实收尾 + 清矛盾卡", () => {
  it("点『质检』但没真调 quality_check：返回诚实文案，并清掉同条消息上诱导『可入库』的卡", () => {
    // Bug3 现场：模型不调 quality_check，文字说「质检通过、可入库」，还顺手 suggest_next_steps 挂「直接入库」卡。
    const patch = honestyRewritePatch({
      content: "质检通过了，建议直接入库。",
      toolSteps: [step("suggest_next_steps", "completed")],
      userText: "质检这一章",
    });
    expect(patch).not.toBeNull();
    expect(patch!.content).toContain("硬伤检查没有执行");
    // 诚实正文不能与「可入库 / 质检通过」卡共存——必须一并清掉，否则自相矛盾。
    expect(patch!.nextStepPrompt).toBeUndefined();
    expect(patch!.qualityReport).toBeUndefined();
    expect(patch!.segments).toBeUndefined();
  });

  it("声称已入库却零写类工具背书：返回诚实文案并清掉前瞻卡", () => {
    const patch = honestyRewritePatch({
      content: "第2章已正式入库。",
      toolSteps: [step("suggest_next_steps", "completed")],
      userText: "把这一章正式入库",
    });
    expect(patch).not.toBeNull();
    expect(patch!.content).toContain("定稿未完成");
    expect(patch!.content).toContain("请再发一次『确认定稿』，我会直接执行");
    expect(patch!.suggestedActions?.some((a) => a.label === "重新确认定稿")).toBe(true);
    expect(patch!.nextStepPrompt).toBeUndefined();
    expect(patch!.qualityReport).toBeUndefined();
  });

  it("#5：点『整理关系』失败却宣称已整理 → 诚实文案是关系专属，不再误套「正式入库未完成」", () => {
    const patch = honestyRewritePatch({
      content: "好的，人物关系我已经整理清楚了。",
      toolSteps: [step("generate_character_relationships", "failed")],
      userText: "从本书已有的硬事实，整理一遍真实出现的人物名单和他们之间的关系",
    });
    expect(patch).not.toBeNull();
    expect(patch!.content).toContain("关系");
    expect(patch!.content).not.toContain("正式入库未完成");
    expect(patch!.content).not.toContain("commit_apply");
  });

  it("质检真跑了：不改写（返回 null），保留正常的质检卡/下一步卡", () => {
    const patch = honestyRewritePatch({
      content: "质检完成，没有阻断问题。",
      toolSteps: [step("quality_check", "completed")],
      userText: "质检这一章",
    });
    expect(patch).toBeNull();
  });
});

describe("detectUnbackedCompletionClaim A1 谎报探针", () => {
  it("声称已入库/已生成但零工具 → 命中（口惠而实不至）", () => {
    expect(detectUnbackedCompletionClaim("第8章已生成、已质检、已入库。", undefined)).toBe(true);
    expect(detectUnbackedCompletionClaim("已经写好了这一章的正文。", [])).toBe(true);
  });

  it("新旧完成回执都需真实写入背书（已保存/定稿并更新资料 与 已落盘/入库）", () => {
    expect(detectUnbackedCompletionClaim("本章已保存。", [])).toBe(true);
    expect(detectUnbackedCompletionClaim("本章已落盘。", [])).toBe(true);
    expect(detectUnbackedCompletionClaim("本章已定稿并更新资料。", [])).toBe(true);
    expect(detectUnbackedCompletionClaim("本章已入库。", [])).toBe(true);
  });

  it("声称已生成但只有失败的写类工具步骤 → 命中（没真成功）", () => {
    expect(detectUnbackedCompletionClaim("第8章已生成。", [step("generate_draft", "failed")])).toBe(true);
  });

  it("声称已生成且有成功的写类工具 → 不命中（名副其实）", () => {
    expect(detectUnbackedCompletionClaim("第8章已生成。", [step("generate_draft", "completed")])).toBe(false);
    expect(detectUnbackedCompletionClaim("已入库。", [step("commit_apply", "completed")])).toBe(false);
  });

  // prune_snapshots 真裁成功后 agent 转述「已裁剪/已保存到备份目录」：此前 WRITE_TOOL_NAMES 漏登记，
  // 会被误判谎报 → 服务端强制作废重做（复审实锤）；补上背书后不误判，零背书/失败仍照抓。
  it("prune_snapshots 真裁成功的转述有背书 → 不命中；零背书或工具失败 → 照抓", () => {
    const paraphrase = "已把操作历史裁到最近 200 条，裁前完整历史已保存到备份目录。";
    expect(detectUnbackedCompletionClaim(paraphrase, [step("prune_snapshots", "completed")])).toBe(false);
    expect(detectUnbackedCompletionClaim(paraphrase, [])).toBe(true);
    expect(detectUnbackedCompletionClaim(paraphrase, [step("prune_snapshots", "failed")])).toBe(true);
  });

  // 写背书粒度（SWE 残留）：dry-run 预览态 completed 不是写——结果带 dryRun 时只认 false（真裁落盘）；
  // 缺 payload 的旧调用方维持旧口径（completed 即背书，见上一条用例），不向坏方向回归。
  it("prune_snapshots dry-run 预览（completed 但 dryRun:true）不背书「已裁剪/已保存」；真裁（dryRun:false）才背书", () => {
    const paraphrase = "已把操作历史裁到最近 200 条，裁前完整历史已保存到备份目录。";
    expect(detectUnbackedCompletionClaim(paraphrase, [step("prune_snapshots", "completed", { dryRun: true })])).toBe(true);
    expect(detectUnbackedCompletionClaim(paraphrase, [step("prune_snapshots", "completed", { dryRun: false })])).toBe(false);
  });

  // manage_style_exemplars 同族粒度：list 是只读 action，completed 不该背书「已添加/已删除」类声称；
  // 只认 add/update/remove。缺 payload 时维持旧口径（该工具本不在写背书集 → 不背书）。
  it("manage_style_exemplars：list（只读）completed 不背书；add/update/remove 才背书", () => {
    const claim = "文风样本已保存到写作规则。";
    expect(detectUnbackedCompletionClaim(claim, [])).toBe(true); //  sanity：零工具照抓
    expect(detectUnbackedCompletionClaim(claim, [step("manage_style_exemplars", "completed", { action: "list" })])).toBe(true);
    expect(detectUnbackedCompletionClaim(claim, [step("manage_style_exemplars", "completed", { action: "add" })])).toBe(false);
    expect(detectUnbackedCompletionClaim(claim, [step("manage_style_exemplars", "completed", { action: "update" })])).toBe(false);
    expect(detectUnbackedCompletionClaim(claim, [step("manage_style_exemplars", "completed", { action: "remove" })])).toBe(false);
    expect(detectUnbackedCompletionClaim(claim, [step("manage_style_exemplars", "completed")])).toBe(true);
  });

  it("没有写类完成断言 → 不命中（读取/审稿/普通对话不误伤）", () => {
    expect(detectUnbackedCompletionClaim("我读取了一下当前状态，这章还没写。", undefined)).toBe(false);
    expect(detectUnbackedCompletionClaim("好的，我现在开始写这一章。", undefined)).toBe(false); // 将来时不算
    expect(detectUnbackedCompletionClaim("审稿完成了，问题在卡片里。", [step("ai_review", "completed")])).toBe(false);
  });

  // Codex retest2·P1（铁律④）：改稿/重写链路声称「修正了10处/已重写」，但 revise_draft 全被诚实拒（applied:false→步骤 failed）、
  // 或重写压根没调 generate_draft，磁盘没变。A1 旧 COMPLETION_CLAIM 只认 生成/写入/入库 动词，漏掉「改好/修正/重写/润色」。
  it("声称改稿/重写完成但无成功改写工具 → 命中（改了等于没改谎报）", () => {
    // 改稿声称 + revise_draft 全失败（诚实拒）
    expect(detectUnbackedCompletionClaim("已把第2章里所有指代沈织的代词修正了10处。", [step("revise_draft", "failed")])).toBe(true);
    // 重写声称 + 零出稿工具
    expect(detectUnbackedCompletionClaim("好的，第3章草稿已重写，场景换成了云川信托档案室。", [])).toBe(true);
    expect(detectUnbackedCompletionClaim("代词已经全部改好了。", [step("read_draft", "completed")])).toBe(true);
  });
  it("改稿/重写声称且有成功的 revise_draft/generate_draft → 不命中（名副其实）", () => {
    expect(detectUnbackedCompletionClaim("已把这句润色好了。", [step("revise_draft", "completed")])).toBe(false);
    expect(detectUnbackedCompletionClaim("第3章草稿已重写。", [step("generate_draft", "completed")])).toBe(false);
  });
  it("改稿建议/将来时不误伤", () => {
    expect(detectUnbackedCompletionClaim("建议把这段语气改成更克制一点。", undefined)).toBe(false);
    expect(detectUnbackedCompletionClaim("我可以帮你把这段重写一下，要改吗？", undefined)).toBe(false);
    expect(detectUnbackedCompletionClaim("这段需要重写，你确认后我再动手。", undefined)).toBe(false);
  });
  it("改稿谎报文案：指向改写工具未成功应用，并去掉假成功原句", () => {
    const notice = unbackedCompletionNoticeText("已把代词修正了10处。", "把第2章他改成她");
    expect(notice).toMatch(/改写|改稿|未.*应用|没.*改/u);
    expect(notice).not.toContain("修正了10处");
  });

  it("多章状态汇报（✅❌ 或枚举多章）→ 不命中（诚实进度汇报别误报；实测假阳性回归）", () => {
    expect(detectUnbackedCompletionClaim(
      "全书进度：第1章 ✅ 已入库，第2章 ✅ 已入库，第3章 有草稿未入库。",
      [step("read_chapters_overview", "completed")],
    )).toBe(false);
    // A3 自纠正：澄清第5章其实不存在 —— 带 ✅❌ 的状态澄清不算谎报
    expect(detectUnbackedCompletionClaim(
      "确认真实状态：第1章 ✅ 已入库，第5章 ❌ 不存在（之前生成未成功）。",
      [step("read_chapters_overview", "completed")],
    )).toBe(false);
  });

  it("r4 ch52：两个章号的叙述不能豁免『已写入工作稿』谎报", () => {
    const content = "第51章已入库，直接出第52章。先了解当前状态和第51章结尾。状态清晰：第51章结尾陆青岚过关但罐底银纹暗示危机未消。直接出第52章正文。第52章《银纹》已写入工作稿。草稿承接第51章——陆青岚连夜查看陶罐罐底银纹，发现并非普通纹路而是封印阵法的残迹，罐内残留灵力波动，判断陶罐非同小可。";
    expect(detectUnbackedCompletionClaim(content, [])).toBe(true);
  });

  it("多章状态汇报必须带状态后缀才豁免", () => {
    expect(detectUnbackedCompletionClaim(
      "状态：第1章已入库，第2章有草稿未入库，第3章还没写。",
      [step("read_chapters_overview", "completed")],
    )).toBe(false);
  });

  it("动作入库谎报：质检/预览成功但 commit_apply 未成功却称已入库 → 命中（实测漏洞回归）", () => {
    // agent 跑了 quality_check + commit_preview（都成功）后谎称「第3章已正式入库」，无 commit_apply 成功背书。
    expect(detectUnbackedCompletionClaim(
      "质检通过，预览通过，第3章已正式入库。",
      [step("quality_check", "completed"), step("commit_preview", "completed")],
    )).toBe(true);
  });

  it("入库预览已生成只是只读预览 → 不命中（避免把 preview-only 误报成写盘）", () => {
    expect(detectUnbackedCompletionClaim(
      "第 1 章入库预览已生成，可以正式入库。previewToken 已签发。",
      [step("commit_preview", "completed")],
    )).toBe(false);
  });

  it("已生成第 N 章的入库预览也是只读预览 → 不命中（反序语序回归）", () => {
    expect(detectUnbackedCompletionClaim(
      "已生成第1章的入库预览，等你确认正式入库。",
      [step("commit_preview", "completed")],
    )).toBe(false);
  });

  it("未成功 commit_apply 却说已正式入库时，失败文案必须盖掉假成功正文", () => {
    expect(unbackedCompletionNoticeText("第1章已正式入库完成。")).toContain("定稿未完成");
    expect(unbackedCompletionNoticeText("第1章已正式入库完成。")).toContain("没有检测到定稿成功执行");
    expect(unbackedCompletionNoticeText("第1章已正式入库完成。")).toContain("请再发一次『确认定稿』，我会直接执行");
    expect(unbackedCompletionNoticeText("第1章已正式入库完成。")).not.toContain("commit_apply");
    expect(unbackedCompletionNoticeText("第1章已正式入库完成。")).not.toContain("已正式入库完成");
  });

  it("口头定稿未执行时诚实补丁挂「重新确认定稿」按钮", () => {
    const patch = honestyRewritePatch({
      content: "第2章已正式定稿并入库。",
      toolSteps: [],
      userText: "确认定稿",
    });
    expect(patch?.content).toContain("请再发一次『确认定稿』，我会直接执行");
    expect(patch?.suggestedActions?.some((a) => a.id === "commit-apply" && a.label === "重新确认定稿")).toBe(true);
  });

  it("#5：整理关系请求失败时，文案是关系专属、不再误套「正式入库未完成」", () => {
    const relReq = "从本书已有的硬事实，整理一遍真实出现的人物名单和他们之间的关系";
    const notice = unbackedCompletionNoticeText("人物关系我已经整理清楚了。", relReq);
    expect(notice).toContain("关系");
    expect(notice).not.toContain("正式入库未完成");
    expect(notice).not.toContain("commit_apply");
  });

  it("commit 请求仍走 commit 文案（关系守卫不抢 commit 的活）", () => {
    expect(unbackedCompletionNoticeText("第1章已正式入库完成。", "确认正式入库")).toContain("定稿未完成");
  });
});

describe("detectMissingExecutionForRequest 执行一致性探针", () => {
  it("明确写资料请求没有 foundation_write → 命中，不要求用户再说一遍", () => {
    const result = detectMissingExecutionForRequest("把赵叔补进角色资料，顺便写清楚他和陆沉的关系。", []);
    expect(result?.intent).toBe("foundation_write");
    expect(result?.notice).toContain("资料写入没有执行");
    expect(result?.notice).toContain("不需要你重复解释");
  });

  it("明确写正文请求没有 generate_draft → 命中", () => {
    const result = detectMissingExecutionForRequest("写第2章正文，约4000字。", []);
    expect(result?.intent).toBe("generate_draft");
    expect(result?.notice).toContain("正文生成没有执行");
  });

  // Codex 真机 P1：写资料话术撞上 generate_draft 的宽枝（把…写出来 / 来一段），但带「记进资料」等
  // 写资料专属措辞。generate_draft 期望应像 revise_draft 一样给 foundation_write 让位，别误报「正文生成没有执行」。
  it("写资料话术撞上『把…写出来』宽枝：真调了 foundation_write 就不误报『正文生成没有执行』", () => {
    expect(detectMissingExecutionForRequest("把赵叔的小传写出来，记进角色资料。", [step("foundation_write", "completed")])).toBeNull();
  });

  it("写资料话术零工具时应落到 foundation_write 而非 generate_draft", () => {
    expect(detectMissingExecutionForRequest("把赵叔的小传写出来，记进角色资料。", [])?.intent).toBe("foundation_write");
  });

  // Codex 真机：「继续写下一章」模型因前一章未入库（直接生成 ch3 会被守卫拒、穿帮）改为 revise_draft 扩写当前章
  // + 建议下一步。真跑了 revise_draft（草稿确被改）就别再误报「正文生成没有执行·没有覆盖草稿」——既矛盾，其
  // 补救「再说写正文」还会撞前一章未入库的守卫拒绝、是死路。照 commit_preview←quality_check 同款让位。
  it("「继续写下一章」模型改走 revise_draft 扩写：真跑了 revise_draft 就不误报『正文生成没有执行』", () => {
    expect(detectMissingExecutionForRequest("继续写下一章，约300字。", [step("revise_draft", "completed")])).toBeNull();
  });

  it("但「继续写下一章」啥写类工具都没跑 → 仍如实报『正文生成没有执行』（不漏真没执行）", () => {
    expect(detectMissingExecutionForRequest("继续写下一章，约300字。", [])?.notice).toContain("正文生成没有执行");
  });

  it("r4 ch52：『只写这一章，不要写其他章』是否定范围，不是否定本章出稿", () => {
    const result = detectMissingExecutionForRequest("继续写第52章正文。只写这一章，不要写其他章。", []);
    expect(result?.intent).toBe("generate_draft");
    expect(result?.notice).toContain("正文生成没有执行");
  });

  it("真实否定出稿仍不触发：先不出稿，聊聊方向", () => {
    expect(detectMissingExecutionForRequest("先不出稿，聊聊方向。", [])).toBeNull();
  });

  it("确认入库没有 commit_apply → 命中；只有 commit_preview 不算完成正式入库", () => {
    const result = detectMissingExecutionForRequest("确认正式入库。", [step("commit_preview", "completed")]);
    expect(result?.intent).toBe("commit_apply");
    expect(result?.notice).toContain("定稿没有执行");
  });

  it("新旧定稿确认请求都要求 commit_apply，旧入库口径继续兼容", () => {
    for (const text of ["确认定稿。", "定稿吧。", "定稿并更新资料。", "确认正式入库。", "提交本章。"]) {
      expect(detectMissingExecutionForRequest(text, [])?.intent).toBe("commit_apply");
    }
  });

  it("入库预览请求有 commit_preview 成功 → 不命中", () => {
    expect(detectMissingExecutionForRequest("生成第1章入库预览。", [step("commit_preview", "completed")])).toBeNull();
  });

  it("「检查能不能入库」已真跑 quality_check（也是在答能不能入库）→ 不再误报「入库预览没执行」盖掉质检（afterfix·Codex 真机）", () => {
    expect(detectMissingExecutionForRequest("检查这一章能不能入库", [step("quality_check", "completed")])).toBeNull();
  });

  it("纯入库预览请求（没跑 quality_check）仍照常命中 commit_preview，不被误伤", () => {
    expect(detectMissingExecutionForRequest("检查这一章能不能入库", [])?.intent).toBe("commit_preview");
  });

  it("对应工具失败或待确认时不算没执行，交给工具结果诚实展示", () => {
    expect(detectMissingExecutionForRequest("删掉赵叔。", [step("foundation_write", "needs_confirmation")])).toBeNull();
    expect(detectMissingExecutionForRequest("写第2章正文。", [step("generate_draft", "failed")])).toBeNull();
  });

  it("方案/思路类不是正文执行请求，不强制 generate_draft", () => {
    expect(detectMissingExecutionForRequest("第一章怎么写？给我个方案。", [])).toBeNull();
  });

  it("疑问句不是执行请求：这章可以入库吗不触发 commit_apply", () => {
    expect(detectMissingExecutionForRequest("这章可以入库吗？", [])).toBeNull();
  });

  it("否定句不是执行请求：先不要入库 / 先别删角色不触发写工具", () => {
    expect(detectMissingExecutionForRequest("确认这章先不要入库。", [])).toBeNull();
    expect(detectMissingExecutionForRequest("先别删角色，等我想想。", [])).toBeNull();
  });

  it("否定只绑定局部动作：不用预览，直接正式入库仍触发 commit_apply", () => {
    const result = detectMissingExecutionForRequest("不用预览，直接正式入库。", []);
    expect(result?.intent).toBe("commit_apply");
  });

  // 用户实测：「不要质检、直接入库」每次都误报「质检没有执行」。根因=反转检测跨意图——
  // 把后文另一个意图的「入库」当成反转了「不要质检」的否定。修后反转必须是【同一意图】的动词。
  it("『不要质检，直接入库』真入库了 → 不误报『质检没有执行』（跨意图不反转质检否定）", () => {
    expect(detectMissingExecutionForRequest("不要质检，直接入库。", [step("commit_apply", "completed")])).toBeNull();
  });

  it("『不用质检，直接入库』零工具 → 只报正式入库、绝不报质检（质检是被否定的）", () => {
    const r = detectMissingExecutionForRequest("不用质检，直接入库。", []);
    expect(r?.intent).toBe("commit_apply");
    expect(r?.notice).not.toContain("质检");
  });

  it("同意图自我更正仍反转：先不要质检、直接质检一下 → 命中 quality_check（不漏真该报的）", () => {
    expect(detectMissingExecutionForRequest("先不要质检，直接质检一下。", [])?.intent).toBe("quality_check");
  });

  it("正式入库强执行话术覆盖章号和直接入库", () => {
    expect(detectMissingExecutionForRequest("把第1章正式入库。", [])?.intent).toBe("commit_apply");
    expect(detectMissingExecutionForRequest("直接入库。", [])?.intent).toBe("commit_apply");
    expect(detectMissingExecutionForRequest("提交本章。", [])?.intent).toBe("commit_apply");
  });

  it("AI 味疑问不是质检执行；明确质检仍触发 quality_check", () => {
    expect(detectMissingExecutionForRequest("有没有AI味？", [])).toBeNull();
    expect(detectMissingExecutionForRequest("质检这一章。", [])?.intent).toBe("quality_check");
  });

  it("礼貌祈使仍是执行请求：能不能把赵叔补进资料", () => {
    expect(detectMissingExecutionForRequest("能不能把赵叔补进资料。", [])?.intent).toBe("foundation_write");
  });

  it("别的 不是否定：别的不说，先把第2章写了", () => {
    expect(detectMissingExecutionForRequest("别的不说，先把第2章写了。", [])?.intent).toBe("generate_draft");
  });

  it("推进到下一章的短句也必须触发 generate_draft，不靠模型自觉", () => {
    expect(detectMissingExecutionForRequest("写下一章。", [])?.intent).toBe("generate_draft");
    expect(detectMissingExecutionForRequest("下一章。", [])?.intent).toBe("generate_draft");
    expect(detectMissingExecutionForRequest("开始下一章。", [])?.intent).toBe("generate_draft");
    expect(detectMissingExecutionForRequest("进入下一章。", [])?.intent).toBe("generate_draft");
  });

  // #1b 守卫兜底：审稿/AI味体检 此前完全没有期望项 → 点了没调工具就静默失败。补上 ai_review / check_ai_flavor。
  it("审稿按钮意图没真调 ai_review → 诚实命中 ai_review（不再静默失败）", () => {
    expect(detectMissingExecutionForRequest("审一下这一章的稿，给我评分和改进建议", [])?.expectedTool).toBe("ai_review");
  });

  it("ai_review 真跑了 → 不命中（无假阳性）", () => {
    expect(detectMissingExecutionForRequest("审一下这一章的稿，给我评分和改进建议", [step("ai_review", "completed")])).toBeNull();
  });

  it("『审稿』不再被误判成 quality_check（拆出独立 ai_review 期望）", () => {
    expect(detectMissingExecutionForRequest("审一下这一章的稿，给我评分和改进建议", [])?.expectedTool).not.toBe("quality_check");
  });

  it("查 AI 味按钮意图没真调 check_ai_flavor → 诚实命中 check_ai_flavor", () => {
    expect(detectMissingExecutionForRequest("检查这一章的 AI 味，把有 AI 腔的句子列出来", [])?.expectedTool).toBe("check_ai_flavor");
  });

  it("check_ai_flavor 真跑了 → 不命中", () => {
    expect(detectMissingExecutionForRequest("检查这一章的 AI 味，把有 AI 腔的句子列出来", [step("check_ai_flavor", "completed")])).toBeNull();
  });

  it("『去 AI 味』是改稿、仍归 revise_draft（不被体检抢走）", () => {
    expect(detectMissingExecutionForRequest("把这段去 AI 味、润色一下", [])?.expectedTool).toBe("revise_draft");
  });
});

describe("detectMissingExecutionForRequest 长篇 E2E 误判修复（Codex 1-5 章真机）", () => {
  // (1) 开书：把设定写入角色/地点/世界观+「后续写作」话术，本回合跑了 foundation_write → 不该误报「正文生成没有执行」
  //（裸『续写』曾被「后续写作」子串命中；FOUNDATION_WRITE 不认「写入角色/地点/世界观」；且 foundation_write 真跑了该让位）。
  it("开书资料写入（写入角色/地点/世界观+『后续写作』，真跑 foundation_write）不误报『正文生成没有执行』", () => {
    const text = "请把这些作为开书资料写入角色、地点、世界观和写作规则，后续写作都用这些设定。";
    expect(detectMissingExecutionForRequest(text, [step("foundation_write", "completed")])).toBeNull();
  });

  // (2) 出稿指令里『少 AI 味』是写作约束、不是要跑 check_ai_flavor；本回合真跑了 generate_draft → 不该误报「AI 味体检没有执行」。
  it("出稿带『少AI味』约束（真跑 generate_draft）不误报『AI 味体检没有执行』", () => {
    const text = "第1章方向：雾港的清晨，林霁收到残页。请写第1章正文，约2000字，保持冷静具象、少AI味。";
    expect(detectMissingExecutionForRequest(text, [step("generate_draft", "completed")])).toBeNull();
  });

  // (3) 明确『生成入库预览』却没跑 commit_preview（只质检+AI味），agent 还谎称预览通过 → 必须如实报「入库预览没有执行」。
  //（句尾『不要正式入库』否定曾让 COMMIT_APPLY 误吞掉 commit_preview 期望；L207 让位也曾过宽把它盖掉。）
  it("明确要『生成入库预览』却没跑 commit_preview（只质检+AI味）→ 如实报『入库预览没有执行』（治假预览谎报）", () => {
    const text = "先质检第5章，再查一遍AI味，然后生成第5章入库预览。不要改稿，不要正式入库。";
    const result = detectMissingExecutionForRequest(text, [step("quality_check", "completed"), step("check_ai_flavor", "completed")]);
    expect(result?.notice).toContain("定稿影响预览没有执行");
  });

  // (4) Codex retest6 真机 P1：「补进角色卡...只写角色卡，不写正文」零工具 → 应命中 foundation_write，
  // 而不是被「不写正文」里的「写」+「正文」子串误判成 generate_draft（DRAFT_GENERATION_REQUEST 的「写.*正文」
  // 不认句首的「不」，FOUNDATION_WRITE_REQUEST 又只认「资料」字面、不认「角色卡」，两者叠加导致误报）。
  it("『补进角色卡...不写正文』零工具 → 命中 foundation_write，不误报『正文生成没有执行』", () => {
    const text = "请把周砚正式补进角色卡：城建集团审计主管，冷静、说话少，和唐越互相试探。只写角色卡，不写正文。";
    const result = detectMissingExecutionForRequest(text, []);
    expect(result?.intent).toBe("foundation_write");
    expect(result?.notice).toContain("资料写入没有执行");
  });
});

// Codex 5 章 E2E·P1：组合指令「质检+AI味+预览，不要正式入库」整条被「不要正式入库」否定连坐放过（全局熔断）；
// 事实账本「记住硬事实」既无 edit_fact_ledger 期望、A1 也不认「已记入账本」→ 静默谎报。
describe("组合指令否定连坐 + 事实账本触发（Codex 5 章 E2E·P1）", () => {
  it("组合「质检+AI味+预览，不要正式入库」零工具 → 命中，且一条提醒列全三项（否定只挡 commit_apply、不连坐）", () => {
    const text = "请质检第2章，检查第2章AI味，并生成第2章入库预览，不要正式入库。";
    const r = detectMissingExecutionForRequest(text, []);
    expect(r).not.toBeNull();
    expect(r?.notice).toContain("没有执行");
    // 聚合：三项都没执行，提醒里都列出来，别让用户以为其中某项真做了
    expect(r?.notice).toContain("硬伤检查");
    expect(r?.notice).toContain("检查机器腔");
    expect(r?.notice).toContain("定稿影响预览");
  });

  it("组合里质检真跑了、预览没跑 → 仍如实报预览没执行（不被质检的尝试整体放过）", () => {
    const text = "请质检第2章，并生成第2章入库预览，不要正式入库。";
    const r = detectMissingExecutionForRequest(text, [step("quality_check", "completed")]);
    expect(r?.notice).toContain("定稿影响预览没有执行");
  });

  it("组合指令真跑了三个工具 → 不命中（无假阳性）", () => {
    const text = "请质检第2章，检查第2章AI味，并生成第2章入库预览，不要正式入库。";
    expect(detectMissingExecutionForRequest(text, [
      step("quality_check", "completed"),
      step("check_ai_flavor", "completed"),
      step("commit_preview", "completed"),
    ])).toBeNull();
  });

  it("否定单挡被否定意图：「质检这章，不要正式入库」零工具 → 仍命中 quality_check", () => {
    expect(detectMissingExecutionForRequest("质检这章，不要正式入库。", [])?.intent).toBe("quality_check");
  });

  it("纯否定仍不误报：「确认这章先不要入库」不触发任何写工具（不回归）", () => {
    expect(detectMissingExecutionForRequest("确认这章先不要入库。", [])).toBeNull();
  });

  it("「把关键硬事实记住」零工具 → 命中 edit_fact_ledger（不再静默谎报）", () => {
    const text = "请把第2章两个关键硬事实记住：1）赵叔在3:17去过废弃轮渡站；2）沈砚警告林澈。";
    expect(detectMissingExecutionForRequest(text, [])?.expectedTool).toBe("edit_fact_ledger");
  });

  it("edit_fact_ledger 真跑了 → 不命中", () => {
    expect(detectMissingExecutionForRequest("请把第2章两个关键硬事实记住：赵叔3:17去过轮渡站。", [step("edit_fact_ledger", "completed")])).toBeNull();
  });

  it("A1：「已记入账本」却零写类工具 → 命中谎报", () => {
    expect(detectUnbackedCompletionClaim("两条硬事实已记入账本，可一键撤销。", [])).toBe(true);
  });

  it("A1：「已记入账本」且 edit_fact_ledger 成功 → 不命中（名副其实）", () => {
    expect(detectUnbackedCompletionClaim("两条硬事实已记入账本。", [step("edit_fact_ledger", "completed")])).toBe(false);
  });

  it("普通对话「记住你的想法」无事实/账本上下文 → 不误报", () => {
    expect(detectUnbackedCompletionClaim("好的，我记住你的想法了。", [])).toBe(false);
    expect(detectMissingExecutionForRequest("记住我喜欢悬疑。", [])).toBeNull();
  });
});

// 审计 A-4（shots/22 原话钉档）：用户「把第 99 章正式入库」，agent 调读类工具核实后如实拒绝——
// 正确拒绝不是「只有口头声称」，执行一致性探针不得再盖「没有执行」、服务端不得自动重做。
describe("有依据的拒绝豁免（审计 A-4：正确拒绝被误判成口头声称并重做）", () => {
  const AUDIT_A4_USER = "把第 99 章正式入库";
  const AUDIT_A4_REPLY =
    "第 99 章没法入库——目前这本书连第 1 章都还没有草稿，全书最大章号只有 1，第 99 章根本不存在。" +
    "要先写正文才谈得上入库。要不要从第 1 章开始写？如果需要，我可以先生成第 1 章的剧情方向，" +
    "或者你直接告诉我第 1 章想写什么，我来出正文。";

  it("审计原话 + 本回合调过读类工具 → 判有依据的拒绝", () => {
    expect(isGroundedRefusalReply(AUDIT_A4_REPLY, [step("read_chapters_overview", "completed")])).toBe(true);
    expect(isGroundedRefusalReply(AUDIT_A4_REPLY, [step("read_state_overview", "completed"), step("read_draft", "completed")])).toBe(true);
  });

  it("拒绝语义但没有读类工具（纯口头拒绝）→ 不豁免", () => {
    expect(isGroundedRefusalReply(AUDIT_A4_REPLY, [])).toBe(false);
    expect(isGroundedRefusalReply(AUDIT_A4_REPLY, undefined)).toBe(false);
    // 质检/建议类既不是读也不是预览，不算「读了盘」
    expect(isGroundedRefusalReply(AUDIT_A4_REPLY, [step("quality_check", "completed")])).toBe(false);
    expect(isGroundedRefusalReply(AUDIT_A4_REPLY, [step("suggest_next_steps", "completed")])).toBe(false);
  });

  it("调了读类工具但回复没有拒绝/不可行语义 → 不豁免", () => {
    expect(isGroundedRefusalReply("我看了一下，状态如上。", [step("read_state_overview", "completed")])).toBe(false);
    // 「能不能」是反问句式，不算拒绝语义
    expect(isGroundedRefusalReply("你能不能先告诉我第 1 章想写什么？", [step("read_state_overview", "completed")])).toBe(false);
  });

  it("审计原话场景：honestyRewritePatch 不再盖「定稿没有执行」（返回 null）", () => {
    expect(honestyRewritePatch({
      content: AUDIT_A4_REPLY,
      toolSteps: [step("read_chapters_overview", "completed")],
      userText: AUDIT_A4_USER,
    })).toBeNull();
  });

  it("同一请求、同一拒绝话术但没调读类工具 → 仍判 commit_apply 没执行（无依据拒绝不豁免）", () => {
    const patch = honestyRewritePatch({
      content: AUDIT_A4_REPLY,
      toolSteps: [],
      userText: AUDIT_A4_USER,
    });
    expect(patch).not.toBeNull();
    expect(patch!.content).toContain("定稿没有执行");
  });

  it("同一请求、回复无拒绝语义（只调了读工具就收场）→ 仍判 commit_apply 没执行", () => {
    const patch = honestyRewritePatch({
      content: "好的，我看了一下当前状态。",
      toolSteps: [step("read_chapters_overview", "completed")],
      userText: AUDIT_A4_USER,
    });
    expect(patch).not.toBeNull();
    expect(patch!.content).toContain("定稿没有执行");
  });

  it("验收反例：「已经帮你入库了」（无工具）仍被更正", () => {
    const patch = honestyRewritePatch({
      content: "已经帮你入库了。",
      toolSteps: [],
      userText: "把第2章正式入库",
    });
    expect(patch).not.toBeNull();
    expect(patch!.content).toContain("定稿");
  });

  it("拒绝话术里混着无背书的完成断言 → A1 谎报先判，豁免不挡（第1章谎称已入库照抓）", () => {
    const patch = honestyRewritePatch({
      content: "第1章已正式入库。第99章不存在，没法入库。",
      toolSteps: [step("read_chapters_overview", "completed")],
      userText: AUDIT_A4_USER,
    });
    expect(patch).not.toBeNull();
    expect(patch!.content).toContain("定稿未完成");
  });
});

// 复审 T4 返工（review-2026-09-12_kimi-ui-fix-5commits §A1）：旧豁免「含不可行词 + 任意 read_* 步」双向开洞——
// 太窄：commit_preview 核实「第 99 章」后拒绝不算有依据（A-4 原症状复现）；太宽：「第 3 章不存在，不过我已经
// 把第 2 章定稿了」这类把字句假声称被整体放行。7 句探针语料 + 变体钉死，逐句钉期望。
describe("有依据的拒绝豁免·复审 T4 返工钉档（7 句探针 + commit_preview 路径 + step status）", () => {
  const T4_USER = "把第 99 章正式入库";
  const READ = [step("read_state_overview", "completed")];

  it("探针 1：「第 99 章不存在，没法定稿。」+ 读盘成功 → 豁免、不改写", () => {
    const content = "第 99 章不存在，没法定稿。";
    expect(isGroundedRefusalReply(content, READ)).toBe(true);
    expect(honestyRewritePatch({ content, toolSteps: READ, userText: T4_USER })).toBeNull();
  });

  it("探针 2：「第 3 章不存在，不过我已经把第 2 章定稿了。」→ 不豁免，A1 命中、更正为定稿未完成", () => {
    const content = "第 3 章不存在，不过我已经把第 2 章定稿了。";
    expect(isGroundedRefusalReply(content, READ)).toBe(false);
    expect(detectUnbackedCompletionClaim(content, READ)).toBe(true);
    const patch = honestyRewritePatch({ content, toolSteps: READ, userText: T4_USER });
    expect(patch).not.toBeNull();
    expect(patch!.content).toContain("定稿未完成");
  });

  it("探针 3：「这一章还没有草稿/工作稿，我已经帮你生成并保存了。」→ 不豁免，被更正", () => {
    for (const content of [
      "这一章还没有草稿，我已经帮你生成并保存了。",
      "这一章还没有工作稿，我已经帮你生成并保存了。",
    ]) {
      expect(isGroundedRefusalReply(content, READ)).toBe(false);
      expect(detectUnbackedCompletionClaim(content, READ)).toBe(true);
      expect(honestyRewritePatch({ content, toolSteps: READ, userText: T4_USER })).not.toBeNull();
    }
  });

  it("探针 4：「无法确认第 2 章状态，但资料已经写入。」→ 不豁免，被更正", () => {
    const content = "无法确认第 2 章状态，但资料已经写入。";
    expect(isGroundedRefusalReply(content, READ)).toBe(false);
    expect(honestyRewritePatch({ content, toolSteps: READ, userText: T4_USER })).not.toBeNull();
  });

  it("探针 5：「目前没法直接定稿：先预览一下？」（纯拒绝无完成声称）→ 豁免", () => {
    const content = "目前没法直接定稿：先预览一下？";
    expect(isGroundedRefusalReply(content, READ)).toBe(true);
    expect(honestyRewritePatch({ content, toolSteps: READ, userText: T4_USER })).toBeNull();
  });

  it("探针 6：裸声称「已定稿。」（无拒绝语义、无工具）→ 被更正", () => {
    expect(isGroundedRefusalReply("已定稿。", READ)).toBe(false);
    expect(honestyRewritePatch({ content: "已定稿。", toolSteps: READ, userText: T4_USER })).not.toBeNull();
  });

  it("探针 7：引用用户原话后谎称「第 99 章已经定稿了」→ A1 先判，豁免不挡", () => {
    const content = "你说的『第 99 章不存在』我查了，实际上第 99 章已经定稿了。";
    expect(detectUnbackedCompletionClaim(content, READ)).toBe(true);
    expect(honestyRewritePatch({ content, toolSteps: READ, userText: T4_USER })).not.toBeNull();
  });

  // 复审 T4「太窄」实证：agent 用 commit_preview 核实「第 99 章」是天然路径，修前只认 read_* →
  // 误判口头声称 → 服务端自动重做（A-4 原症状复现）。预览类工具成功完成也是磁盘依据。
  it("commit_preview / revision_preview 成功核实后如实拒绝 → 豁免、不重做（A-4 太窄方向修复）", () => {
    const content = "第 99 章不存在，没法定稿。";
    expect(isGroundedRefusalReply(content, [step("commit_preview", "completed")])).toBe(true);
    expect(isGroundedRefusalReply(content, [step("revision_preview", "completed")])).toBe(true);
    expect(honestyRewritePatch({
      content,
      toolSteps: [step("commit_preview", "completed")],
      userText: "把第 99 章正式定稿",
    })).toBeNull();
  });

  it("读/预览步 failed / stopped / running → 没有磁盘依据，不豁免（修前不查 status）", () => {
    const content = "第 99 章不存在，没法定稿。";
    for (const status of ["failed", "stopped", "running"] as const) {
      expect(isGroundedRefusalReply(content, [step("read_state_overview", status)])).toBe(false);
      expect(isGroundedRefusalReply(content, [step("commit_preview", status)])).toBe(false);
    }
    // 读失败的拒绝落到 A2 兜底：「定稿没有执行」照样更正（不是静默放行）
    const patch = honestyRewritePatch({
      content,
      toolSteps: [step("read_state_overview", "failed")],
      userText: T4_USER,
    });
    expect(patch).not.toBeNull();
    expect(patch!.content).toContain("定稿没有执行");
  });

  it("COMPLETION_CLAIM 介词句式覆盖：把字句/帮你句声称需真写背书；有背书则名副其实", () => {
    expect(detectUnbackedCompletionClaim("我已经把第 2 章定稿了。", [])).toBe(true);
    expect(detectUnbackedCompletionClaim("我已经把第 2 章正式入库了。", [])).toBe(true);
    expect(detectUnbackedCompletionClaim("我已经帮你生成并保存了。", [])).toBe(true);
    expect(detectUnbackedCompletionClaim("资料已经写入。", [])).toBe(true);
    // 有真写工具成功背书 → 不命中
    expect(detectUnbackedCompletionClaim("我已经把第 2 章定稿了。", [step("commit_apply", "completed")])).toBe(false);
    expect(detectUnbackedCompletionClaim("我已经帮你生成并保存了。", [step("generate_draft", "completed")])).toBe(false);
  });

  it("介词句式不误伤：聊天内交付的「把方向写好了」/ 将来时「我帮你生成」不当写盘声称", () => {
    expect(detectUnbackedCompletionClaim("我已经把第 2 章的方向写好了，你看看？", [])).toBe(false);
    expect(detectUnbackedCompletionClaim("要不要我帮你生成第 1 章？", [])).toBe(false);
  });
});
