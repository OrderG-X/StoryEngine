// @vitest-environment node
//
// 守护「确认口径唯一」铁律：写作总控 agent 的 instructions 是「直接做 + 可撤销」控制面，
// 绝不能把含 confirm_before_foundation_write 的能力清单原样注入——否则会被渲染成
// 「资料写入前必须给用户确认」，和铁律①「写类操作不需要事前确认弹窗」自相矛盾，
// 让模型有概率在 foundation_write 落盘前反向要求用户确认，破坏用户最在意的控制面。
import { describe, expect, it, vi } from "vitest";

// 只看工具表，不连模型：Mastra Agent 构造期只存 model，给一个最小假 model 即可。
vi.mock("./model.js", () => ({
  resolveGlmModel: vi.fn(async () => ({
    model: { specificationVersion: "v2", provider: "fake", modelId: "fake", doGenerate: async () => ({}), doStream: async () => ({}) },
    profile: { model: "fake" },
    provider: { id: "fake" },
  })),
}));

import { buildInstructions, getStoryAgent, invalidateStoryAgent } from "./story-agent.js";

describe("story agent 工具表（重构 P9：补资料并进 foundation_write；P12 加 settle_fact，19 个）", () => {
  it("19 个工具；没有 enrich_foundation 和老的补全/文风样本工具；指令里也不再提它们", async () => {
    invalidateStoryAgent();
    const tools = Object.keys(await (await getStoryAgent()).listTools()).sort();
    invalidateStoryAgent();
    expect(tools).toEqual([
      "ai_review",
      "brainstorm_chapter",
      "check_ai_flavor",
      "check_continuity",
      "commit_preview",
      "foundation_write",
      "generate_draft",
      "manage_ledger",
      "manage_snapshots",
      "quality_check",
      "read_chapters_overview",
      "read_draft",
      "read_foundation",
      "read_state_overview",
      "read_timeline",
      "revise_draft",
      "settle_fact",
      "suggest_next_steps",
      "web_search",
    ]);
    const instructions = buildInstructions();
    for (const gone of ["enrich_foundation", "generate_alias_table", "kind=aliases", "style_exemplar_add", "manage_style_exemplars"]) {
      expect(instructions).not.toContain(gone);
    }
  });
});

describe("story agent instructions（确认口径唯一）", () => {
  const instructions = buildInstructions();

  it("声明了「直接做、可撤销」的统一确认口径（铁律①）", () => {
    expect(instructions).toContain("写类操作不需要事前确认弹窗");
    expect(instructions).toContain("可撤销");
  });

  it("绝不包含任何「写入前必须确认」措辞，避免与铁律①冲突", () => {
    // 这些正是 describeAgentCapabilitiesForPrompt 默认会注入、与本 agent 直接矛盾的句子。
    expect(instructions).not.toContain("资料写入前必须给用户确认");
    expect(instructions).not.toContain("正式状态写入前必须给用户确认");
    expect(instructions).not.toContain("必须给用户确认");
    // 能力清单的「确认策略」整行也不应出现在这个 direct-mode agent 的 instructions 里。
    expect(instructions).not.toContain("确认策略：");
  });

  // 2026-10-10 瘦身：底层能力清单（foundationAgent 之类的内部分工，约 2 千字）不再注入，工具自己的说明管用途。
  it("不再注入底层能力清单；工具怎么选写在对照里", () => {
    expect(instructions).not.toContain("foundationAgent");
    expect(instructions).toContain("read_state_overview");
    expect(instructions).toContain("foundation_write");
    expect(instructions.length).toBeLessThan(10_000);
  });

  it("快照裁剪两步哲学：manage_snapshots op=prune 在工具清单里，默认预览、用户明确「确认裁剪」才真裁", () => {
    expect(instructions).toContain("manage_snapshots op=prune");
    expect(instructions).toContain("确认裁剪");
    expect(instructions).toMatch(/manage_snapshots op=prune（先预览、用户确认才真裁）/u);
    // 如实声明撤销边界：undo 撤不到裁剪（不动工作树），别拿 undo 撤别的顶替（复审实锤的误撤风险）
    expect(instructions).toContain("不在撤销链");
  });

  it("入库转告纪律含『新出现人物只告知不替建卡』且不编造", () => {
    expect(instructions).toContain("不替用户建卡");
    expect(instructions).toContain("绝不编造『新出现了谁』");
  });

  it("执行类请求必须实际调用对应工具，不能只在对话里口头答应", () => {
    expect(instructions).toContain("执行类请求必须工具先行");
    expect(instructions).toContain("写正文=generate_draft");
    expect(instructions).toContain("改稿=revise_draft");
    expect(instructions).toContain("写 / 改 / 删设定（人物、地点、物品、其他设定、关系、故事设定、写作规则、文风样本）=foundation_write");
    expect(instructions).toContain("定稿（入库）=先 commit_preview 再请用户点「确认定稿」按钮");
    expect(instructions).toContain("没调对应工具，就等于没执行");
  });

  it("重写有稿的章也要真调 generate_draft：按钮随调用出现，不许凭印象叫作者去点", () => {
    expect(instructions).toContain("作者要重写、重出已经有稿的章，也照样调 generate_draft");
    expect(instructions).toContain("没调就没有按钮");
    expect(instructions).not.toContain("界面已出「重写这一章」按钮");
  });

  it("审校问题顺手改纪律：先 read_draft 定位逐字原文，软提醒不拦", () => {
    expect(instructions).toContain("先 read_draft 拿到正文");
    expect(instructions).toContain("提醒、不是拦");
  });

  // R2#1：「写下一章」按钮点了不调 generate_draft（intent 不在换章触发词内 + 模型分两轮只读不写）。
  // 指令须把『写下一章/下一章』并入直接出稿触发、且要求同一轮就出稿。
  it("3a 把『写下一章/下一章』映射到同一轮 generate_draft 出稿（修 R2#1 写下一章按钮断）", () => {
    expect(instructions).toContain("写下一章");
    expect(instructions).toContain("同一轮就出稿");
  });

  // R2#1：定稿「下一步卡」intent 是模型自由生成，须用能干净映射工具的措辞。
  it("下一步卡的预览 intent 用能干净触发工具的措辞；定稿不放进选项卡（预览卡自带按钮）", () => {
    expect(instructions).toContain("生成第N章定稿预览");
    expect(instructions).toContain("定稿不放进选项卡");
  });

  // R3#4 + R5：用户可见泄漏——绝不把内部 id / 资料编号 / previewToken 复述给用户；调工具前别先吐英文思考/preamble。
  it("禁止把 id/资料编号/previewToken 复述给用户、禁止输出英文 reasoning preamble", () => {
    expect(instructions).toMatch(/绝不(把|向用户).{0,8}(id|资料编号)/u);
    expect(instructions).toMatch(/previewToken|预览令牌/u);
    expect(instructions).toMatch(/英文(思考|旁白|reasoning|preamble)/iu);
  });

  // R5 P0：用户一次点名多个实体时，必须全部写入、一个都不能漏，不能写两个就停或口头承诺后只读不写。
  it("多实体开书资料：要求全部写入、一个都不能漏、禁止只承诺不写", () => {
    expect(instructions).toMatch(/一个都不(能|得)漏|全部.{0,8}(写入|落盘)/u);
    expect(instructions).toMatch(/承诺|口头说.{0,6}补|只读不写/u);
  });

  // 重构 P9：关系记在两张人物卡之间（relation.set），不再走角色卡的关系字段、也没有关系矩阵视图了。
  it("关系登记：relation.set 记在两张人物卡之间；账里有、没建卡的人，用户要建才建", () => {
    expect(instructions).toContain("关系用 relation.set 记在两张人物卡之间");
    expect(instructions).toContain("账里有、还没建卡的人，用户要建就 card.create");
    expect(instructions).not.toContain("relationshipToProtagonist");
    expect(instructions).not.toContain("关系矩阵");
  });

  // rerun2：多项写入要逐项按真实回执汇报，不许编汇总。
  it("多项写入逐项按真实结果汇报：只报回执里改好了的，没改成的如实转告", () => {
    expect(instructions).toContain("多项写入逐项按真实结果汇报");
    expect(instructions).toContain("只报工具回执里「改好了」列出的；「没改成」的如实转告");
    expect(instructions).toContain("宁可少报");
    expect(instructions).not.toContain("assets.json");
  });

  it("AI 补的可以直接改；作者写的、改名、删卡、换主角只出「确认改设定」按钮", () => {
    expect(instructions).toContain("卡上标着「AI 补的」你可以直接改");
    expect(instructions).toContain("作者写的、改名、删卡、换主角，工具会给作者出「确认改设定」按钮");
  });

  it("删角色 / 覆盖已确立设定 / 整章重写：作者档，只告诉作者点哪个按钮、不重试（重构 P4）", () => {
    expect(instructions).toContain("确认改设定");
    expect(instructions).toContain("重写这一章");
    expect(instructions).toContain("别重试");
    expect(instructions).not.toContain("允许覆盖");
    expect(instructions).not.toContain("confirmed=true");
  });
});

describe("buildInstructions 开书引导（仅空书时主动轻引导）", () => {
  const instructions = buildInstructions();

  it("包含空书主动轻引导 + 关键缺口追问 + 题材中立", () => {
    expect(instructions).toContain("开书引导");
    expect(instructions).toContain("主角");
    expect(instructions).toMatch(/关键缺口|只在.*才追问/);
  });

  it("把开书引导限定为「故事资料基本为空、像一本新书时」条件触发（不改非空书行为）", () => {
    expect(instructions).toMatch(/故事资料基本为空|像一本新书/);
  });

  it("开书引导复用现成工具（foundation_write/brainstorm_chapter）", () => {
    const guidanceStart = instructions.indexOf("开书引导");
    const guidance = instructions.slice(guidanceStart);
    expect(guidance).toContain("foundation_write");
    expect(guidance).toContain("brainstorm_chapter");
  });

  // 重构 P9：新书不再自带占位主角，主角是作者说了才建的一张标了主角的人物卡。
  it("开书引导：主角用 card.create 带 protagonist:true 建；不再提占位主角 / 改名占位", () => {
    const guidanceStart = instructions.indexOf("开书引导");
    const guidance = instructions.slice(guidanceStart);
    expect(guidance).toContain("主角 card.create 带 protagonist:true");
    expect(guidance).toContain("故事设定 story.set");
    expect(instructions).not.toContain("rename_character");
    expect(instructions).not.toContain("占位主角");
  });

  // #3 真机瑕疵：给第一章方向前 agent 又把已建资料逐条复述/整理一遍，啰嗦。
  it("开书引导指明给第一章方向前不必重复复述/整理已建资料", () => {
    const guidanceStart = instructions.indexOf("开书引导");
    const guidance = instructions.slice(guidanceStart);
    // 「第一章」上下文里含「不必/不用 重复/复述/整理」语义。
    expect(guidance).toMatch(/第一章[\s\S]*?(不必|不用)[\s\S]*?(复述|整理|逐条)/);
  });
});

describe("buildInstructions 写设定（第一轮就把已给的写进卡，不编）", () => {
  const instructions = buildInstructions();

  it("设定本只记稳定的、作者定的；会变的记在账里，不往卡上写", () => {
    expect(instructions).toContain("设定本只记稳定的、作者定的东西");
    expect(instructions).toContain("会变的（此刻在哪、东西在谁手里、伤好没好）记在账里");
    expect(instructions).toContain("不往卡上写");
  });

  it("用户已给的信息第一轮一笔写进卡（card.create 带 fields），不先建空卡", () => {
    expect(instructions).toContain("第一轮就把用户已给的信息一笔写进卡（card.create 带 fields）");
    expect(instructions).toContain("不要先建空卡再等下一轮");
    expect(instructions).toContain("一次点名多个就全部写、一个都不能漏");
  });

  it("不得凭空补具体事实；补全某张卡先读、只补空着的栏，要和正文、账对得上", () => {
    expect(instructions).toContain("不得凭空补具体事实，不知道就不写");
    expect(instructions).toContain("先 read_foundation 读它和账里记的，只补空着的栏");
    expect(instructions).not.toMatch(/knowledgeUnknown|cannotReveal/u);
  });

  it("单一动作直接做，不套选项卡；只有开放式大活先给方向选项", () => {
    expect(instructions).toContain("一个意思没得选的单一动作直接做，不套选项卡");
    expect(instructions).not.toContain("紧接着【不要停在骨架】调 suggest_next_steps");
  });
});

// 复验残留：模型记完硬事实(ok=true)后又追问「你确定要保留这条吗？后面会不会解冻？」——
// 踩中「禁反问」红线。规则原文「不要反问『你确定吗』」被读成「动作前别问许可」，
// 没覆盖「事后回头质疑刚做的动作」。这里锁住：记完只简洁确认、不回头反问；
// 真要帮忙就用「以后变了告诉我、我来标记取代」这种前瞻提议，而非反问用户要不要保留。
describe("buildInstructions 改账 = 你提、作者点按钮（重构 P3）", () => {
  const instructions = buildInstructions();

  it("manage_ledger 只出「确认改账」按钮；绝不说已记好；作者没说过的决定不替作者做", () => {
    expect(instructions).toContain("「确认改账」按钮");
    expect(instructions).toContain("绝不说『已记好/已改好/已收口』");
    expect(instructions).toContain("作者没说过的决定不要替作者做");
  });
});

// 章节状态链修复（3/7）：单聊天走天涯后，agent 把第5章「继续」误判成回第1章（⑤），
// 以及把「写一句话草稿」当口头建议不落盘（⑥）。规则层补：当前章权威 + 禁止冒充草稿 + 入库后引路下一章。
describe("buildInstructions 章节状态跟随规则（⑤⑥修复）", () => {
  const instructions = buildInstructions();

  it("声明往下推进：当前章为基准、优先于历史旧章；继续=顺进度往前走(没写完接当前章、写完进下一章)，绝不回退旧章", () => {
    expect(instructions).toContain("往下推进");
    expect(instructions).toContain("优先级高于对话历史");
    expect(instructions).toContain("绝不回退");
    expect(instructions).toMatch(/继续[\s\S]*?(下一章|往前走)/);
  });

  it("禁止口头冒充草稿（⑥）：要正文必须调 generate_draft 落盘，没调工具就是没出稿", () => {
    expect(instructions).toContain("禁止口头冒充草稿");
    expect(instructions).toContain("没出稿");
    expect(instructions).toContain("绝不谎称已写");
  });

  it("generate_draft 工具描述声明缺章号默认当前章", () => {
    expect(instructions).toContain("缺章号时默认用户当前所在章");
  });

  it("定稿后的下一步由系统按钮通道给出，模型不用补", () => {
    expect(instructions).toContain("定稿后的下一步");
    expect(instructions).toContain("系统会直接转告定稿结果");
  });

  it("待收口提醒只转告并给归并选项；单条已完结用 manage_ledger op=resolve", () => {
    expect(instructions).toContain("待收口提醒只转告");
    expect(instructions).toContain("manage_ledger op=group");
    expect(instructions).toContain("manage_ledger op=resolve");
  });

  it("出稿后下一步交给选项卡，文字不要重复口播工作稿保存/下一步提示", () => {
    expect(instructions).toContain("不要重复口播工具 summary");
    expect(instructions).toContain("不要重复说『工作稿已保存』");
  });
});

describe("buildInstructions 定稿 = 模型预览、用户点按钮（2026-10-07）", () => {
  const instructions = buildInstructions();

  it("定稿真写入只由用户点「确认定稿」按钮完成，模型负责预览并请用户点按钮", () => {
    expect(instructions).toContain("【定稿 = 你预览、用户点按钮】");
    expect(instructions).toContain("先对该章 commit_preview");
    expect(instructions).toContain("请用户在定稿清单里点「确认定稿」");
  });

  // 2026-10-10 瘦身：commit_apply 不再给对话 AI（它调了也只是再出一个按钮），定稿只能点按钮。
  it("对话 AI 没有定稿工具，定稿只能由用户点按钮", () => {
    expect(instructions).toContain("你没有定稿工具");
    expect(instructions).not.toContain("commit_apply");
  });

  it("绝不说已定稿；不可定稿时如实说明、不让用户去点按钮", () => {
    expect(instructions).toContain("**绝不说『已定稿/已入库』**");
    expect(instructions).toContain("canCommit=false 时如实说明阻断原因");
  });

  it("旧的组合意图/强制执行条款已删（不再靠模型一轮走完定稿）", () => {
    expect(instructions).not.toContain("组合意图=一轮走完");
    expect(instructions).not.toContain("【确认定稿·强制执行】");
    expect(instructions).not.toContain("同轮继续 commit_apply");
  });

  it("纯出稿不越权：用户只要写正文时，generate_draft 后停住并给下一步，不顺手 preview/apply", () => {
    expect(instructions).toContain("出稿不越权");
    expect(instructions).toContain("用户只说『写第 N 章正文/继续写』");
    expect(instructions).toContain("出稿落工作稿后必须停");
    expect(instructions).toContain("commit_preview 都等用户明确点了或说了再动");
  });

  it("纯出稿不越权覆盖审稿/质检/AI味：generate_draft 后除 suggest_next_steps 外不追加未请求工具", () => {
    expect(instructions).toContain("除 suggest_next_steps 外");
    expect(instructions).toContain("ai_review");
    expect(instructions).toContain("quality_check");
    expect(instructions).toContain("check_ai_flavor");
    expect(instructions).toContain("用户没请求");
  });

});
