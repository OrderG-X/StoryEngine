// @vitest-environment node
//
// 守护「确认口径唯一」铁律：写作总控 agent 的 instructions 是「直接做 + 可撤销」控制面，
// 绝不能把含 confirm_before_foundation_write 的能力清单原样注入——否则会被渲染成
// 「资料写入前必须给用户确认」，和铁律①「写类操作不需要事前确认弹窗」自相矛盾，
// 让模型有概率在 foundation_write 落盘前反向要求用户确认，破坏用户最在意的控制面。
import { describe, expect, it } from "vitest";

import { buildInstructions } from "./story-agent.js";

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

  it("仍保留底层能力的读写/触发线索（只去掉确认策略行，不丢能力信息）", () => {
    expect(instructions).toContain("foundationAgent");
    expect(instructions).toContain("satelliteUpdateAgent");
    expect(instructions).toContain("read_state_overview");
    expect(instructions).toContain("foundation_write");
  });

  it("快照裁剪两步哲学：prune_snapshots 在工具清单里，默认预览、用户明确「确认裁剪」才真裁", () => {
    expect(instructions).toContain("prune_snapshots");
    expect(instructions).toContain("确认裁剪");
    expect(instructions).toMatch(/prune_snapshots（先预览、用户确认才真裁）/u);
    // 如实声明撤销边界：undo 撤不到裁剪（不动工作树），别拿 undo 撤别的顶替（复审实锤的误撤风险）
    expect(instructions).toContain("不在撤销链");
  });

  it("公开 generate_alias_table 工具作为后续在场检测的别名表入口", () => {
    expect(instructions).toContain("generate_alias_table");
    expect(instructions).toContain("别名");
  });

  it("入库转告纪律含『新出现人物只告知不替建卡』且不编造", () => {
    expect(instructions).toContain("不替用户建卡");
    expect(instructions).toContain("绝不编造『新出现了谁』");
  });

  it("执行类请求必须实际调用对应工具，不能只在对话里口头答应", () => {
    expect(instructions).toContain("执行类请求必须工具先行");
    expect(instructions).toContain("写正文=generate_draft");
    expect(instructions).toContain("改稿=revise_draft");
    expect(instructions).toContain("写资料=foundation_write");
    expect(instructions).toContain("定稿（入库）=commit_apply");
    expect(instructions).toContain("没调对应工具，就等于没执行");
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
  it("下一步卡的定稿类 intent 用能干净触发工具的措辞（预览/定稿分开）", () => {
    expect(instructions).toContain("生成第N章定稿预览");
    expect(instructions).toContain("确认定稿第N章");
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

  // R2#2：开书给具名角色登记关系应走 update_character_detail 的 relationshipToProtagonist，
  // 别去调 generate_character_relationships（它只整理已入库章节、开书撞空且失败提示误导）。
  it("关系登记纪律：开书登记关系走 update_character_detail，generate_character_relationships 仅整理已入库章节", () => {
    expect(instructions).toContain("generate_character_relationships 只");
    expect(instructions).toContain("已入库章节");
  });

  // #1-B：开书阶段关系矩阵/关系网视图（character-matrix.json）建不出来，绝不谎报「关系矩阵已写入」。
  it("开书阶段关系矩阵别谎报：关系写进角色卡 + 如实说矩阵视图要等正文入库后", () => {
    expect(instructions).toMatch(/关系矩阵.{0,40}(空|建不出|建不了|未|要等)|绝不声称.{0,12}关系矩阵/u);
    expect(instructions).toContain("relationshipToProtagonist");
    expect(instructions).toMatch(/谎报|铁律④|绝不声称/u);
  });

  // rerun2：多项写入（尤其多资产）要逐项按真实 writes 汇报，资产只算写进 assets.json 的，不许编汇总。
  it("多项写入逐项按真实结果汇报：资产只算写进账本、没写成如实列、不塞没出现的项", () => {
    expect(instructions).toMatch(/逐项|多项写入/u);
    expect(instructions).toContain("assets.json");
    expect(instructions).toMatch(/没写成|没单独建成资产|宁可少报/u);
  });

  it("已确立设定覆盖被拦：如实转告缺什么、勿无限重试、改不成要诚实收尾", () => {
    expect(instructions).toMatch(/已确立|长期设定/u);
    expect(instructions).toMatch(/允许覆盖|确定/u);
    expect(instructions).toMatch(/勿无限重试|不要反复重试|不得无限重试/u);
    expect(instructions).toMatch(/没改成|没成功|如实/u);
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

  it("开书引导复用现成可撤销写盘工具（foundation_write/generate_chapter_steering）", () => {
    const guidanceStart = instructions.indexOf("开书引导");
    const guidance = instructions.slice(guidanceStart);
    expect(guidance).toContain("foundation_write");
    expect(guidance).toContain("generate_chapter_steering");
  });

  // #1 真机瑕疵：用户说真主角名时，agent 用 create_character 新增了第二个角色，
  // 于是左栏出现「主角、林晚」两个。修法是引导改名占位主角（rename_character、保 id），
  // 而非 create_character 新增。
  it("开书引导指明用户首次说真主角名时改名占位主角（rename_character、保 id），而非 create_character 新增", () => {
    const guidanceStart = instructions.indexOf("开书引导");
    const guidance = instructions.slice(guidanceStart);
    expect(guidance).toContain("rename_character");
    expect(guidance).toMatch(/改名|重命名/);
    expect(guidance).toMatch(/占位主角|默认主角/);
    // 明确警示不要用 create_character 新增主角（否则出现两个角色）。
    expect(guidance).toContain("create_character");
  });

  // #3 真机瑕疵：给第一章方向前 agent 又把已建资料逐条复述/整理一遍，啰嗦。
  it("开书引导指明给第一章方向前不必重复复述/整理已建资料", () => {
    const guidanceStart = instructions.indexOf("开书引导");
    const guidance = instructions.slice(guidanceStart);
    // 「第一章」上下文里含「不必/不用 重复/复述/整理」语义。
    expect(guidance).toMatch(/第一章[\s\S]*?(不必|不用)[\s\S]*?(复述|整理|逐条)/);
  });
});

describe("buildInstructions 资料写入资产化（补资料第一轮不能只落骨架）", () => {
  const instructions = buildInstructions();

  it("要求把用户已给基础信息一笔整理成可写正文的结构化资料，而不是先存薄骨架", () => {
    expect(instructions).toContain("资料资产化");
    expect(instructions).toContain("一笔写成可写正文的结构化资料");
    expect(instructions).toContain("不要先落骨架再等下一轮");
    expect(instructions).not.toContain("先 foundation_write 落骨架");
  });

  it("禁止为了做厚凭空补具体事实，没给的信息要留空或放进未知/不可透露边界", () => {
    expect(instructions).toContain("不得凭空补具体事实");
    expect(instructions).toContain("不知道就留空");
    expect(instructions).toMatch(/knowledgeUnknown|cannotReveal/);
  });

  it("普通新增资料不再先弹方向卡；只有开放式大范围做厚才需要先给方向选项", () => {
    expect(instructions).not.toContain("紧接着【不要停在骨架】调 suggest_next_steps");
    expect(instructions).not.toContain("补资料（纪律 2.6）");
    expect(instructions).toContain("普通新增/补充资料不是方向分叉任务");
  });
});

// 复验残留：模型记完硬事实(ok=true)后又追问「你确定要保留这条吗？后面会不会解冻？」——
// 踩中「禁反问」红线。规则原文「不要反问『你确定吗』」被读成「动作前别问许可」，
// 没覆盖「事后回头质疑刚做的动作」。这里锁住：记完只简洁确认、不回头反问；
// 真要帮忙就用「以后变了告诉我、我来标记取代」这种前瞻提议，而非反问用户要不要保留。
describe("buildInstructions 硬事实记完不回头反问（computer-use 复验残留修复）", () => {
  const instructions = buildInstructions();

  it("记完硬事实后只简洁确认，禁止回头反问『你确定要保留这条吗』去质疑刚记的事实", () => {
    expect(instructions).toContain("绝不回头反问");
    expect(instructions).toContain("你确定要保留这条吗");
  });

  it("察觉这条日后可能变（如含『暂时』）时改用前瞻提议、而非反问用户要不要保留", () => {
    expect(instructions).toContain("前瞻提议");
    expect(instructions).toMatch(/以后真变了告诉我|我来标记取代/);
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

  it("定稿后主动用 suggest_next_steps 引路下一章（章号＝刚定稿章＋1）", () => {
    expect(instructions).toContain("定稿后主动引路下一章");
    expect(instructions).toMatch(/进入下一章|刚定稿章/);
  });

  it("入库后遇到待收口/陈旧线索提醒只能转告并给选项，不能自动清理归并", () => {
    expect(instructions).toContain("待收口提醒只转告");
    expect(instructions).toContain("绝不自动调用 clean_legacy_threads / group_related_leads");
    expect(instructions).toContain("用户点了再做");
  });

  it("单条线索明确已完结时用 resolve_thread，不用全局清理工具凑", () => {
    expect(instructions).toContain("resolve_thread");
    expect(instructions).toContain("用户明确说某一条提醒其实已经完了");
    expect(instructions).toContain("不要用全局清理工具替代");
  });

  it("出稿后下一步交给选项卡，文字不要重复口播草稿保存/下一步提示", () => {
    expect(instructions).toContain("不要重复口播工具 summary");
    expect(instructions).toContain("不要重复说『草稿已保存』");
  });
});

describe("buildInstructions 定稿预览与定稿意图分离", () => {
  const instructions = buildInstructions();

  it("用户只要定稿预览时只调 commit_preview，不在同一轮顺手 commit_apply", () => {
    expect(instructions).toContain("只要用户说的是定稿预览/入库预览");
    expect(instructions).toContain("只调 commit_preview");
    expect(instructions).toContain("不要在同一轮顺手 commit_apply");
  });

  it("commit_apply 可只带章号，由系统使用最近一次有效预览票据", () => {
    expect(instructions).toContain("commit_apply 可以只带章号");
    expect(instructions).toContain("系统会使用最近一次有效 commit_preview 票据");
    expect(instructions).toContain("token_placeholder");
    expect(instructions).toContain("绝不编造");
  });

  it("用户确认定稿时必须执行 commit_apply，同时继续兼容旧入库确认", () => {
    expect(instructions).toContain("用户说『确认定稿 / 定稿吧 / 定稿并更新资料 / 确认入库 / 确认正式入库 / 正式入库 / 提交本章』");
    expect(instructions).toContain("必须实际调用 commit_apply");
    expect(instructions).toContain("绝不能只用文字回答『已定稿』");
    expect(instructions).toContain("确认定稿时直接调用 commit_apply");
    expect(instructions).toContain("说「确认定稿」我就定稿并更新资料");
    expect(instructions).toContain("确认正式入库");
    expect(instructions).toContain("提交本章");
    expect(instructions).toContain("【确认定稿·强制执行】");
    expect(instructions).toContain("本轮**必须立刻调用 commit_apply**");
  });

  it("组合意图一轮走完：用户同时要求预览+定稿时，先 preview，通过后同轮 apply，不停在预览", () => {
    expect(instructions).toContain("组合意图=一轮走完");
    expect(instructions).toContain("走完预览并定稿");
    expect(instructions).toContain("预览通过就提交");
    expect(instructions).toContain("同一轮先 commit_preview");
    expect(instructions).toContain("紧接着同轮 commit_apply");
    expect(instructions).toContain("绝不停在预览等下一轮");
  });

  it("组合意图下 warning 级提醒不阻断 commit_apply", () => {
    expect(instructions).toContain("warning 级提醒");
    expect(instructions).toContain("不阻断");
    expect(instructions).toContain("同轮继续 commit_apply");
    expect(instructions).toContain("只有 canCommit=false");
  });

  it("顺序铁律：正式入库永远先 commit_preview 后 commit_apply，不能上来就 apply", () => {
    expect(instructions).toContain("顺序铁律");
    expect(instructions).toContain("永远先 commit_preview 后 commit_apply");
    expect(instructions).toContain("绝不上来就 commit_apply");
    expect(instructions).toContain("被拒后立刻补 commit_preview 再 commit_apply");
  });

  it("纯出稿不越权：用户只要写正文时，generate_draft 后停住并给下一步，不顺手 preview/apply", () => {
    expect(instructions).toContain("出稿不越权");
    expect(instructions).toContain("用户只说『写第 N 章正文/继续写』");
    expect(instructions).toContain("出稿落工作稿后必须停");
    expect(instructions).toContain("commit_preview / commit_apply 都等用户明确点了或说了再动");
  });

  it("纯出稿不越权覆盖审稿/质检/AI味：generate_draft 后除 suggest_next_steps 外不追加未请求工具", () => {
    expect(instructions).toContain("除 suggest_next_steps 外");
    expect(instructions).toContain("ai_review");
    expect(instructions).toContain("quality_check");
    expect(instructions).toContain("check_ai_flavor");
    expect(instructions).toContain("用户没请求");
  });

  it("禁止把 ok:true/committed:true/摘要文字伪造成 previewToken", () => {
    expect(instructions).toContain("不要把 ok:true、committed:true、summary、状态文字或你自己的判断当成 previewToken");
  });
});
