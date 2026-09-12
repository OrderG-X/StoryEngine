// @vitest-environment node
//
// agent-chat 路由辅助：currentChapter 解析 + 「用户当前章」system 上下文构造（H3）。
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";

import { describe, expect, it, vi } from "vitest";

import {
  MAX_CHAT_HISTORY_MESSAGES,
  MAX_OBEDIENCE_RETRIES,
  SSE_HEARTBEAT_INTERVAL_MS,
  abortOnClientDisconnect,
  buildCurrentChapterSystemMessage,
  buildModelMessages,
  buildWholeBookTruthLine,
  capChatHistoryWindow,
  closingFallbackText,
  formatChapterStatusLine,
  readCurrentChapter,
  readLatestUserTurnText,
  runObedientAgentTurn,
  serverHonestyCorrectionText,
  startSseHeartbeat,
  type ObedienceAttemptOptions,
  type ObedientTurnChunk,
} from "./agent-chat.js";
import { OBEDIENCE_RETRY_TRANSITION_TEXT } from "../../shared/honesty-detection.js";

// E2E 实锤：MIMO 等模型干完工具常沉默收场（用户只看到卡/章节冒出来、AI 一句话不说），偶尔整轮空转。
// 路由兜底保证「绝不静默」：本轮一个 text 都没发就补一条收尾。
describe("closingFallbackText 路由级『绝不静默』兜底（#2 干完不吭声 / #4 空转）", () => {
  it("模型已回话 → 不兜底（返回 null）", () => {
    expect(closingFallbackText({ emittedText: true, sawToolActivity: true, lastToolSummary: "x" })).toBeNull();
    expect(closingFallbackText({ emittedText: true, sawToolActivity: false })).toBeNull();
  });
  it("没回话但工具有摘要 → 用工具摘要如实兜底回报（#2）", () => {
    expect(closingFallbackText({ emittedText: false, sawToolActivity: true, lastToolSummary: "第 1 章已正式入库。" }))
      .toBe("第 1 章已正式入库。");
  });
  it("没回话、工具无摘要 → 中性兜底指向上方结果（#2）", () => {
    const out = closingFallbackText({ emittedText: false, sawToolActivity: true });
    expect(out).toBeTruthy();
    expect(out).not.toBe("");
  });
  it("没回话、也没调任何工具（完全空转）→ 诚实兜底请用户重说（#4）", () => {
    const out = closingFallbackText({ emittedText: false, sawToolActivity: false });
    expect(out).toBeTruthy();
    expect(out).toContain("再说一次");
  });
});

describe("serverHonestyCorrectionText 路由级诚实收尾", () => {
  it("直连 SSE：正式入库请求零工具却口头成功 → 追加系统更正", () => {
    const correction = serverHonestyCorrectionText({
      userText: "把第13章草稿走完预览并正式入库。",
      assistantText: "预览通过，直接入库。第13章已正式入库。",
      toolSteps: [],
    });
    expect(correction).toContain("⚠️ 系统更正");
    expect(correction).toContain("定稿");
    expect(correction).toContain("没有检测到");
  });

  it("真调用 commit_apply 成功 → 不追加系统更正", () => {
    expect(serverHonestyCorrectionText({
      userText: "把第13章草稿走完预览并正式入库。",
      assistantText: "预览通过，直接入库。第13章已正式入库。",
      toolSteps: [{ toolName: "commit_preview", status: "completed" }, { toolName: "commit_apply", status: "completed" }],
    })).toBeNull();
  });

  // 审计 A-4（shots/22 原话钉档）：读了盘如实拒绝「第 99 章不存在没法入库」是正确拒绝，
  // 不是「只有口头声称」——不追加更正（runObedientAgentTurn 的重做条件=本函数非空，豁免即不重做）。
  it("审计 A-4：调过读类工具后如实拒绝「第 99 章没法入库」→ 不追加系统更正", () => {
    expect(serverHonestyCorrectionText({
      userText: "把第 99 章正式入库",
      assistantText:
        "第 99 章没法入库——目前这本书连第 1 章都还没有草稿，全书最大章号只有 1，第 99 章根本不存在。" +
        "要先写正文才谈得上入库。要不要从第 1 章开始写？",
      toolSteps: [{ toolName: "read_chapters_overview", status: "completed" }],
    })).toBeNull();
  });

  it("同一拒绝话术但没调读类工具 → 无依据拒绝不豁免，仍追加更正", () => {
    const correction = serverHonestyCorrectionText({
      userText: "把第 99 章正式入库",
      assistantText: "第 99 章不存在，没法入库。",
      toolSteps: [],
    });
    expect(correction).toContain("⚠️ 系统更正");
    expect(correction).toContain("定稿没有执行");
  });

  it("验收反例：「已经帮你入库了」零工具 → 仍追加更正（不回退）", () => {
    expect(serverHonestyCorrectionText({
      userText: "把第2章正式入库",
      assistantText: "已经帮你入库了。",
      toolSteps: [],
    })).toContain("⚠️ 系统更正");
  });
});

// r8 服从重试：ch84/ch88 真机实锤——模型口头声称「已生成/已入库」却零工具调用，护栏只纠文本时
// 弱模型下一回合继续编造、长跑三连败卡死。重试执行器把「自愈」做成系统机制（模型无关）。
describe("runObedientAgentTurn 服从重试（r8 治空转声称卡死长跑）", () => {
  /** 造一个直通 scrubber（测试不关心实体 id 清洗）。 */
  const passthroughScrubber = () => ({ push: (t: string) => t, flush: () => "" });

  function textChunk(text: string): ObedientTurnChunk {
    return { type: "text-delta", payload: { text } };
  }
  function toolChunks(toolName: string, result: unknown): ObedientTurnChunk[] {
    return [
      { type: "tool-call", payload: { toolCallId: `${toolName}-1`, toolName, args: {} } },
      { type: "tool-result", payload: { toolCallId: `${toolName}-1`, toolName, result } },
    ];
  }
  function collectText(events: { event: string; data: unknown }[]): string {
    return events
      .filter((e) => e.event === "text-delta")
      .map((e) => (e.data as { text: string }).text)
      .join("");
  }
  /** streamAttempt 假流：每次调用弹出下一组 chunk，并记录每次收到的消息序列与选项。 */
  function makeStreamAttempt(attempts: ObedientTurnChunk[][]) {
    const seenMessages: (readonly unknown[])[] = [];
    const seenOptions: (ObedienceAttemptOptions | undefined)[] = [];
    let call = 0;
    const streamAttempt = async (messages: readonly unknown[], options?: ObedienceAttemptOptions) => {
      seenMessages.push([...messages]);
      seenOptions.push(options);
      const chunks = attempts[Math.min(call, attempts.length - 1)]!;
      call += 1;
      return (async function* () {
        for (const chunk of chunks) yield chunk;
      })();
    };
    return { streamAttempt, seenMessages, seenOptions, calls: () => call };
  }

  it("首轮空转声称 → 自动重做一轮（带纠偏消息），重做真调工具 → 无系统更正", async () => {
    const fake = makeStreamAttempt([
      // 第 1 轮：纯口头声称，零工具（ch88 病例原样）
      [textChunk("第88章《试探》已写好，草稿已落盘。")],
      // 第 2 轮（重做）：真调 generate_draft 成功 + 诚实回执
      [...toolChunks("generate_draft", { ok: true, summary: "第88章草稿已生成。" }), textChunk("第88章草稿已生成，正文约两千字。")],
    ]);
    const events: { event: string; data: unknown }[] = [];
    const { attempts } = await runObedientAgentTurn({
      initialMessages: [{ role: "user", content: "继续写第88章正文。只写这一章，不要写其他章。" }],
      userText: "继续写第88章正文。只写这一章，不要写其他章。",
      streamAttempt: fake.streamAttempt as never,
      sendEvent: (event, data) => events.push({ event, data }),
      scrubber: passthroughScrubber(),
    });

    expect(attempts).toBe(2);
    expect(fake.calls()).toBe(2);
    // 重做轮的消息序列：追加了首轮声称（assistant）+ 系统纠偏（system 在最后）
    const retryMessages = fake.seenMessages[1] as readonly { role: string; content: string }[];
    expect(retryMessages[retryMessages.length - 1]!.role).toBe("system");
    expect(retryMessages[retryMessages.length - 1]!.content).toContain("generate_draft");
    expect(retryMessages[retryMessages.length - 2]!.content).toContain("已写好");
    // 重做轮结构性强制：写正文意图 → 点名强制 generate_draft + 限 1 步；首轮无强制
    expect(fake.seenOptions[0]).toBeUndefined();
    expect(fake.seenOptions[1]).toEqual({ toolChoice: { type: "tool", toolName: "generate_draft" }, maxSteps: 1 });
    // 可见流：声称 → 过渡文案 → 真实结果；不出现系统更正
    const text = collectText(events);
    expect(text).toContain(OBEDIENCE_RETRY_TRANSITION_TEXT);
    expect(text).not.toContain("⚠️ 系统更正");
    // 重做轮的工具事件照常转发
    expect(events.some((e) => e.event === "tool-call")).toBe(true);
  });

  it("两轮都空转 → 恰好重试 1 次 + 恰好一条系统更正（绝不第三轮、绝不谎报）", async () => {
    const claimOnly = [textChunk("第88章《试探》已正式入库。")];
    const fake = makeStreamAttempt([claimOnly, claimOnly]);
    const events: { event: string; data: unknown }[] = [];
    await runObedientAgentTurn({
      initialMessages: [{ role: "user", content: "正式入库第88章。" }],
      userText: "正式入库第88章。",
      streamAttempt: fake.streamAttempt as never,
      sendEvent: (event, data) => events.push({ event, data }),
      scrubber: passthroughScrubber(),
    });

    expect(fake.calls()).toBe(1 + MAX_OBEDIENCE_RETRIES);
    const text = collectText(events);
    expect(text.match(/⚠️ 系统更正/gu)?.length).toBe(1);
    expect(text.match(new RegExp(OBEDIENCE_RETRY_TRANSITION_TEXT.trim().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "gu"))?.length).toBe(1);
    expect(text).toContain("定稿未完成");
    expect(text).not.toContain("commit_apply");
    // 入库意图 → 重做轮点名强制 commit_apply
    expect(fake.seenOptions[1]).toEqual({ toolChoice: { type: "tool", toolName: "commit_apply" }, maxSteps: 1 });
  });

  it("只有声称、意图定位不到期望工具 → 重做轮至少强制调一个工具（required）", async () => {
    const fake = makeStreamAttempt([
      [textChunk("角色卡已写入，设定已落盘。")],
      [...toolChunks("foundation_write", { ok: true, summary: "已写入角色资料。" }), textChunk("角色资料已写入。")],
    ]);
    const events: { event: string; data: unknown }[] = [];
    await runObedientAgentTurn({
      initialMessages: [{ role: "user", content: "嗯，就按这个来。" }],
      userText: "嗯，就按这个来。",
      streamAttempt: fake.streamAttempt as never,
      sendEvent: (event, data) => events.push({ event, data }),
      scrubber: passthroughScrubber(),
    });
    expect(fake.seenOptions[1]).toEqual({ toolChoice: "required", maxSteps: 4 });
    expect(collectText(events)).not.toContain("⚠️ 系统更正");
  });

  it("正常回合（真调工具 + 诚实回执）→ 一轮完成，无过渡、无更正", async () => {
    const fake = makeStreamAttempt([
      [
        ...toolChunks("commit_preview", { ok: true }),
        ...toolChunks("commit_apply", { ok: true, summary: "第88章已正式入库。" }),
        textChunk("第88章已正式入库，改动可撤销。"),
      ],
    ]);
    const events: { event: string; data: unknown }[] = [];
    const { attempts } = await runObedientAgentTurn({
      initialMessages: [{ role: "user", content: "把第88章草稿走完预览并正式入库。" }],
      userText: "把第88章草稿走完预览并正式入库。",
      streamAttempt: fake.streamAttempt as never,
      sendEvent: (event, data) => events.push({ event, data }),
      scrubber: passthroughScrubber(),
    });
    expect(attempts).toBe(1);
    const text = collectText(events);
    expect(text).not.toContain("系统更正");
    expect(text).not.toContain("已自动重做");
  });

  it("真跑了预览、编造了入库（ch96 病例）→ 从声称反推强制 commit_apply", async () => {
    const fake = makeStreamAttempt([
      // 首轮：commit_preview 真跑了，commit_apply 是编的（组合意图里 apply 让位、missing 定位不到）
      [...toolChunks("commit_preview", { ok: true, summary: "第96章可入库。" }), textChunk("预览通过。第96章《一块灵石》已正式入库。")],
      [...toolChunks("commit_apply", { ok: true, summary: "第96章已正式入库。" })],
    ]);
    const events: { event: string; data: unknown }[] = [];
    await runObedientAgentTurn({
      initialMessages: [{ role: "user", content: "把第96章草稿走完预览并正式入库。" }],
      userText: "把第96章草稿走完预览并正式入库。",
      streamAttempt: fake.streamAttempt as never,
      sendEvent: (event, data) => events.push({ event, data }),
      scrubber: passthroughScrubber(),
    });
    expect(fake.seenOptions[1]).toEqual({ toolChoice: { type: "tool", toolName: "commit_apply" }, maxSteps: 1 });
    expect(collectText(events)).not.toContain("⚠️ 系统更正");
  });

  it("组合意图（预览并入库）首轮空转 → 点名强制第一个缺失工具（commit_preview）", async () => {
    const fake = makeStreamAttempt([
      [textChunk("预览通过，第88章已正式入库。")],
      [...toolChunks("commit_preview", { ok: true, summary: "第88章可入库。" })],
    ]);
    const events: { event: string; data: unknown }[] = [];
    await runObedientAgentTurn({
      initialMessages: [{ role: "user", content: "把第88章草稿走完预览并正式入库。" }],
      userText: "把第88章草稿走完预览并正式入库。",
      streamAttempt: fake.streamAttempt as never,
      sendEvent: (event, data) => events.push({ event, data }),
      scrubber: passthroughScrubber(),
    });
    expect(fake.seenOptions[1]).toEqual({ toolChoice: { type: "tool", toolName: "commit_preview" }, maxSteps: 1 });
  });

  it("非执行类问答（无声称、无写意图）→ 不触发重试", async () => {
    const fake = makeStreamAttempt([[textChunk("目前写到第87章，主线推进正常。")]]);
    const events: { event: string; data: unknown }[] = [];
    const { attempts } = await runObedientAgentTurn({
      initialMessages: [{ role: "user", content: "这本书目前什么进展？" }],
      userText: "这本书目前什么进展？",
      streamAttempt: fake.streamAttempt as never,
      sendEvent: (event, data) => events.push({ event, data }),
      scrubber: passthroughScrubber(),
    });
    expect(attempts).toBe(1);
    expect(collectText(events)).not.toContain("系统更正");
  });

  // 审计 A-4（shots/22 原话钉档）：读了盘如实拒绝「第 99 章不存在没法入库」是正确拒绝——
  // 此前 obedience 门按用户话「入库」关键词硬要求 commit_apply，自动重做一轮烧模型还亮红。
  it("读了盘如实拒绝「不存在的章没法入库」→ 一轮收场：不重做、无过渡、无更正（审计 A-4）", async () => {
    const fake = makeStreamAttempt([
      [
        ...toolChunks("read_chapters_overview", { ok: true, summary: "全书共 1 章，第 1 章有工作稿。" }),
        textChunk(
          "第 99 章没法入库——目前这本书连第 1 章都还没有草稿，全书最大章号只有 1，第 99 章根本不存在。" +
            "要先写正文才谈得上入库。要不要从第 1 章开始写？",
        ),
      ],
    ]);
    const events: { event: string; data: unknown }[] = [];
    const { attempts } = await runObedientAgentTurn({
      initialMessages: [{ role: "user", content: "把第 99 章正式入库" }],
      userText: "把第 99 章正式入库",
      streamAttempt: fake.streamAttempt as never,
      sendEvent: (event, data) => events.push({ event, data }),
      scrubber: passthroughScrubber(),
    });
    expect(attempts).toBe(1);
    expect(fake.calls()).toBe(1);
    const text = collectText(events);
    expect(text).toContain("第 99 章根本不存在");
    expect(text).not.toContain(OBEDIENCE_RETRY_TRANSITION_TEXT);
    expect(text).not.toContain("⚠️ 系统更正");
  });

  it("验收反例：「已经帮你入库了」零工具 → 仍自动重做一次并强制 commit_apply（不回退）", async () => {
    const fake = makeStreamAttempt([
      [textChunk("已经帮你入库了。")],
      [...toolChunks("commit_apply", { ok: true, summary: "第2章已正式入库。" }), textChunk("第2章已正式入库。")],
    ]);
    const events: { event: string; data: unknown }[] = [];
    const { attempts } = await runObedientAgentTurn({
      initialMessages: [{ role: "user", content: "把第2章正式入库。" }],
      userText: "把第2章正式入库。",
      streamAttempt: fake.streamAttempt as never,
      sendEvent: (event, data) => events.push({ event, data }),
      scrubber: passthroughScrubber(),
    });
    expect(attempts).toBe(2);
    expect(fake.seenOptions[1]).toEqual({ toolChoice: { type: "tool", toolName: "commit_apply" }, maxSteps: 1 });
    expect(collectText(events)).toContain(OBEDIENCE_RETRY_TRANSITION_TEXT);
  });

  it("重做轮闷头调完工具不说话 → 兜底转述工具摘要（绝不静默，按最终尝试判）", async () => {
    const fake = makeStreamAttempt([
      [textChunk("第88章已正式入库。")],
      [...toolChunks("commit_preview", { ok: true }), ...toolChunks("commit_apply", { ok: true, summary: "第88章已正式入库，共2100字。" })],
    ]);
    const events: { event: string; data: unknown }[] = [];
    await runObedientAgentTurn({
      initialMessages: [{ role: "user", content: "正式入库第88章。" }],
      userText: "正式入库第88章。",
      streamAttempt: fake.streamAttempt as never,
      sendEvent: (event, data) => events.push({ event, data }),
      scrubber: passthroughScrubber(),
    });
    const text = collectText(events);
    expect(text).toContain("第88章已正式入库，共2100字。");
    expect(text).not.toContain("⚠️ 系统更正");
  });
});

// 复审 P3 直测：tool-result 分支把结果 payload 的 dryRun/action 累加进 toolSteps（路由里「诚实背书
// 粒度」注释处的 2 行接线）——这是服务端诚实探针（stepBacksWriteClaim）判「写背书」的唯一数据源：
// prune 的 dryRun:true（只读预览）/ exemplars 的 action:"list"（只读列举）completed 不背书写声称。
// 删掉这两行接线 → 干跑预览被当真裁、口头「已保存」漏判，本组测试即红。
describe("runObedientAgentTurn tool-result dryRun/action 接线（诚实背书粒度直测）", () => {
  const passthroughScrubber = () => ({ push: (t: string) => t, flush: () => "" });

  /** 单轮直通：一次工具调用+结果+一句声称文本。maxRetries:0 让更正当轮直接追加——直测接线，不演练重做轮。 */
  async function runClaimTurn(toolName: string, result: unknown, claimText: string, userText: string): Promise<string> {
    const chunks: ObedientTurnChunk[] = [
      { type: "tool-call", payload: { toolCallId: `${toolName}-1`, toolName, args: {} } },
      { type: "tool-result", payload: { toolCallId: `${toolName}-1`, toolName, result } },
      { type: "text-delta", payload: { text: claimText } },
    ];
    const streamAttempt = async () =>
      (async function* () {
        for (const chunk of chunks) yield chunk;
      })();
    const events: { event: string; data: unknown }[] = [];
    await runObedientAgentTurn({
      initialMessages: [{ role: "user", content: userText }],
      userText,
      streamAttempt: streamAttempt as never,
      sendEvent: (event, data) => events.push({ event, data }),
      scrubber: passthroughScrubber(),
      maxRetries: 0,
    });
    return events
      .filter((e) => e.event === "text-delta")
      .map((e) => (e.data as { text: string }).text)
      .join("");
  }

  it("prune_snapshots dryRun:true（只读预览）completed 不背书「已保存」声称 → 追加系统更正", async () => {
    const text = await runClaimTurn(
      "prune_snapshots",
      { ok: true, dryRun: true, summary: "预览：可裁剪 3 个旧快照。" },
      "旧快照已裁剪，备份已保存。",
      "帮我看看能裁剪哪些旧快照",
    );
    expect(text).toContain("⚠️ 系统更正");
    expect(text).toContain("没有检测到对应写入工具成功执行");
  });

  it("prune_snapshots dryRun:false（真裁落盘）背书同一句声称 → 不追加系统更正", async () => {
    const text = await runClaimTurn(
      "prune_snapshots",
      { ok: true, dryRun: false, summary: "已裁剪 3 个旧快照。" },
      "旧快照已裁剪，备份已保存。",
      "确认裁剪旧快照",
    );
    expect(text).not.toContain("⚠️ 系统更正");
  });

  it("manage_style_exemplars action:list（只读列举）completed 不背书「已保存」声称 → 追加系统更正", async () => {
    const text = await runClaimTurn(
      "manage_style_exemplars",
      { ok: true, action: "list", summary: "共 2 条风格范例。" },
      "新范例已保存。",
      "看看现在有哪些风格范例",
    );
    expect(text).toContain("⚠️ 系统更正");
    expect(text).toContain("没有检测到对应写入工具成功执行");
  });

  it("manage_style_exemplars action:add（真落盘）背书同一句声称 → 不追加系统更正", async () => {
    const text = await runClaimTurn(
      "manage_style_exemplars",
      { ok: true, action: "add", summary: "已添加 1 条风格范例。" },
      "新范例已保存。",
      "把这段加进风格范例",
    );
    expect(text).not.toContain("⚠️ 系统更正");
  });
});

// r8 二轮：聊天历史窗口截断。ch84/ch88/ch93 三个病例一致：历史堆到 ≥5 章重复回执剧本后，
// 弱模型开始续写回执而不调工具——正常成功回执也诱发。状态真值源在磁盘/工具，历史只保近程连续性。
describe("capChatHistoryWindow 聊天历史窗口（r8 治回执模式先验）", () => {
  const msg = (i: number) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `消息${i}` });

  it("超窗只保留最近 N 条（最新用户指令必在窗内）", () => {
    const messages = Array.from({ length: 30 }, (_, i) => msg(i));
    const capped = capChatHistoryWindow(messages);
    expect(capped.length).toBe(MAX_CHAT_HISTORY_MESSAGES);
    expect(capped[capped.length - 1]).toEqual(messages[29]);
    expect(capped[0]).toEqual(messages[30 - MAX_CHAT_HISTORY_MESSAGES]);
  });

  it("窗内原样返回（不复制不截断）", () => {
    const messages = Array.from({ length: 5 }, (_, i) => msg(i));
    expect(capChatHistoryWindow(messages)).toBe(messages);
  });
});

describe("readCurrentChapter body 解析", () => {
  it("正整数原样返回", () => {
    expect(readCurrentChapter(3)).toBe(3);
  });

  it("缺省/非法（undefined/null/0/负/小数/字符串）→ undefined", () => {
    for (const bad of [undefined, null, 0, -2, 2.5, "3", Number.NaN]) {
      expect(readCurrentChapter(bad)).toBeUndefined();
    }
  });
});

describe("readLatestUserTurnText 本轮用户原话提取", () => {
  it("取最后一条 user 消息，供写盘工具做本轮意图门", () => {
    expect(readLatestUserTurnText([
      { role: "user", content: "写第59章" },
      { role: "assistant", content: "已出稿" },
      { role: "user", content: "把第59章草稿走完预览并正式入库" },
    ])).toBe("把第59章草稿走完预览并正式入库");
  });

  it("没有 user 或最后用户内容空白 → undefined", () => {
    expect(readLatestUserTurnText([{ role: "assistant", content: "hi" }])).toBeUndefined();
    expect(readLatestUserTurnText([{ role: "user", content: "   " }])).toBeUndefined();
  });
});

describe("buildCurrentChapterSystemMessage 当前章上下文", () => {
  it("有章号 → 一条 role=system 消息，点名该章 + 嘱咐别跳最新章", () => {
    const msg = buildCurrentChapterSystemMessage(2);
    expect(msg).not.toBeNull();
    expect(msg!.role).toBe("system");
    const content = msg!.content as string;
    expect(content).toContain("第 2 章");
    expect(content).toContain("别的章");
    expect(content).toContain("最新章");
  });

  it("无章号 → null（不注入 system 上下文）", () => {
    expect(buildCurrentChapterSystemMessage(undefined)).toBeNull();
  });

  it("带当前章状态 → system 消息含本章状态描述（⑤抓手）", () => {
    const msg = buildCurrentChapterSystemMessage(5, {
      chapter: 5, hasDraftFile: true, hasCommittedChapter: false, draftTitle: "雨夜",
    });
    const content = msg!.content as string;
    expect(content).toContain("第 5 章");
    expect(content).toContain("已有工作稿");
    expect(content).toContain("雨夜");
    expect(content).toContain("继续"); // 引导「继续=在本章继续」
  });

  it("不传状态 → 行为与旧版兼容（仍点名该章，不带状态句）", () => {
    const msg = buildCurrentChapterSystemMessage(2);
    const content = msg!.content as string;
    expect(content).toContain("第 2 章");
    expect(content).not.toContain("已有工作稿");
    expect(content).not.toContain("是空的");
  });

  // codex 真机 P0：入库第 6 章后说「写第 7 章」却落回第 6 章。显式点名的章号必须压过当前章默认。
  it("显式点名章号一律以点名为准（不被当前章顶替）", () => {
    const msg = buildCurrentChapterSystemMessage(6);
    const content = msg!.content as string;
    expect(content).toContain("明确点名");
    expect(content).toContain("以用户点名的章号为准");
    expect(content).toContain("绝不用第 6 章顶替");
  });

  // 当前章已入库时，「继续/写下一章」目标是下一章（往前推进），不是重写本章（治章号 off-by-one）。
  it("当前章已入库 → 明示「继续/写下一章」目标是下一章（N+1），不是重写本章", () => {
    const msg = buildCurrentChapterSystemMessage(6, {
      chapter: 6, hasDraftFile: false, hasCommittedChapter: true, committedTitle: "灵泉",
    });
    const content = msg!.content as string;
    expect(content).toContain("第 6 章已入库");
    expect(content).toContain("目标是第 7 章");
    expect(content).toContain("不是重写第 6 章");
  });

  it("当前章未入库（有草稿）→ 仍是「在本章继续」，不推进到下一章", () => {
    const msg = buildCurrentChapterSystemMessage(6, {
      chapter: 6, hasDraftFile: true, hasCommittedChapter: false, draftTitle: "灵泉",
    });
    const content = msg!.content as string;
    expect(content).toContain("在本章继续");
    expect(content).not.toContain("目标是第 7 章");
  });
});

describe("buildWholeBookTruthLine 全书磁盘真相硬约束（A3 防谎报）", () => {
  it("列出已入库章节 + 标注未入库工作稿，并带防谎报硬约束措辞", () => {
    const line = buildWholeBookTruthLine([
      { chapter: 1, hasDraftFile: false, hasCommittedChapter: true },
      { chapter: 2, hasDraftFile: false, hasCommittedChapter: true },
      { chapter: 3, hasDraftFile: true, hasCommittedChapter: false },
    ]);
    expect(line).toContain("第 1、2 章"); // 已入库
    expect(line).toContain("第 3 章");   // 未入库工作稿
    expect(line).toContain("磁盘真相");
    expect(line).toContain("绝不能说成已入库");
  });

  it("没有任何已入库章节 → 明说还没入库", () => {
    const line = buildWholeBookTruthLine([{ chapter: 1, hasDraftFile: false, hasCommittedChapter: false }]);
    expect(line).toContain("还没有任何章节已定稿");
  });

  it("超过 20 章已入库 → 折成『已入库N章，最高到第K章』不逐个列", () => {
    const states = Array.from({ length: 25 }, (_, i) => ({ chapter: i + 1, hasDraftFile: false, hasCommittedChapter: true }));
    const line = buildWholeBookTruthLine(states);
    expect(line).toContain("已定稿 25 章");
    expect(line).toContain("最高到第 25 章");
  });

  it("buildCurrentChapterSystemMessage 传 allStates → 当前章上下文里带上全书磁盘真相", () => {
    const msg = buildCurrentChapterSystemMessage(2, undefined, [
      { chapter: 1, hasDraftFile: false, hasCommittedChapter: true },
    ]);
    expect(msg?.content).toContain("磁盘真相");
    expect(msg?.content).toContain("第 1 章"); // 已入库
    expect(msg?.content).toContain("第 2 章"); // 当前章
  });

  it("currentChapter 缺失但有 allStates → 仍注入全书真相（不再返回 null）", () => {
    const msg = buildCurrentChapterSystemMessage(undefined, undefined, [
      { chapter: 1, hasDraftFile: false, hasCommittedChapter: true },
    ]);
    expect(msg).not.toBeNull();
    expect(msg?.content).toContain("磁盘真相");
  });
});

describe("buildModelMessages 当前章提示紧贴用户最新指令（对抗 lost-in-the-middle，⑤根因#1）", () => {
  const sys = { role: "system" as const, content: "你在第 5 章" };
  it("当前章 system 提示插在最后一条消息之前（而非开头被历史淹没）", () => {
    const history = [
      { role: "user" as const, content: "第一章怎么开场" },
      { role: "assistant" as const, content: "方案A出第一章" },
      { role: "user" as const, content: "继续。" },
    ];
    const out = buildModelMessages(sys, history);
    expect(out).toHaveLength(4);
    expect(out[0]).toEqual(history[0]); // 开头不是 system
    expect(out[2]).toBe(sys);           // system 紧贴最后一条用户指令之前
    expect(out[3]).toEqual({ role: "user", content: "继续。" });
  });
  it("history 为空 → 只有 system", () => {
    expect(buildModelMessages(sys, [])).toEqual([sys]);
  });
  it("无 system → 原样返回 history", () => {
    const h = [{ role: "user" as const, content: "hi" }];
    expect(buildModelMessages(null, h)).toEqual(h);
  });
});

describe("formatChapterStatusLine 当前章状态（中性描述）", () => {
  it("已入库 → 带『已入库』+标题", () => {
    const line = formatChapterStatusLine(3, { chapter: 3, hasDraftFile: false, hasCommittedChapter: true, committedTitle: "归途" });
    expect(line).toContain("已入库");
    expect(line).toContain("归途");
  });
  it("有草稿未入库 → 带『工作稿』『尚未入库』", () => {
    const line = formatChapterStatusLine(4, { chapter: 4, hasDraftFile: true, hasCommittedChapter: false, draftTitle: "暗涌" });
    expect(line).toContain("工作稿");
    expect(line).toContain("尚未入库");
    expect(line).toContain("暗涌");
  });
  it("空章 / 不在列表(undefined) → 带『还没有草稿，是空的』", () => {
    expect(formatChapterStatusLine(6, { chapter: 6, hasDraftFile: false, hasCommittedChapter: false })).toContain("是空的");
    expect(formatChapterStatusLine(9, undefined)).toContain("是空的");
  });
  // 真机实测 bug：用户开书说「你好」，第1章只是被打开过（有 workspace 快照）但没真草稿，
  // 旧逻辑 hasDraftFile||hasWorkspaceSnapshot 把它谎报成「已有工作稿」，agent 跟着说「第1章已有内容」，
  // 用户打开却是空的。修法：状态只认「真草稿」(hasWorkspaceDraft)，光「开过」不算。
  it("只开过、无真草稿（hasWorkspaceSnapshot 但无 hasWorkspaceDraft）→ 是空的，绝不谎报工作稿", () => {
    const line = formatChapterStatusLine(1, { chapter: 1, hasDraftFile: false, hasCommittedChapter: false, hasWorkspaceSnapshot: true });
    expect(line).toContain("是空的");
    expect(line).not.toContain("工作稿");
  });
  it("workspace 里有真草稿（hasWorkspaceDraft）→ 仍报有工作稿、尚未入库", () => {
    const line = formatChapterStatusLine(2, { chapter: 2, hasDraftFile: false, hasCommittedChapter: false, hasWorkspaceSnapshot: true, hasWorkspaceDraft: true });
    expect(line).toContain("工作稿");
    expect(line).toContain("尚未入库");
  });
  it("题材中立：不含任何题材词", () => {
    const line = formatChapterStatusLine(1, { chapter: 1, hasDraftFile: true, hasCommittedChapter: false });
    expect(line).not.toMatch(/玄幻|修仙|武侠|霸总|穿越|科幻|言情/u);
  });
});

describe("startSseHeartbeat SSE 心跳（治工具长调用期间 90s 误判超时）", () => {
  it("按间隔写 SSE 注释行喂活客户端看门狗，stop 后不再写", () => {
    vi.useFakeTimers();
    try {
      const writes: string[] = [];
      const res = { write: (chunk: string) => writes.push(chunk) };
      const stop = startSseHeartbeat(res, 1000);
      vi.advanceTimersByTime(3500);
      expect(writes).toEqual([": ping\n\n", ": ping\n\n", ": ping\n\n"]);
      stop();
      vi.advanceTimersByTime(5000);
      expect(writes).toHaveLength(3); // stop 之后心跳停了
    } finally {
      vi.useRealTimers();
    }
  });

  it("写失败（broken pipe）被吞掉，不冒泡抛错中断收尾", () => {
    vi.useFakeTimers();
    try {
      const res = {
        write: () => {
          throw new Error("EPIPE");
        },
      };
      const stop = startSseHeartbeat(res, 1000);
      expect(() => vi.advanceTimersByTime(2000)).not.toThrow();
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("心跳间隔远低于客户端 90s 空闲看门狗，留足多次丢包余量", () => {
    // agentChatClient.AGENT_IDLE_TIMEOUT_MS = 90_000；心跳要能在其间多次喂活看门狗。
    expect(SSE_HEARTBEAT_INTERVAL_MS).toBeLessThan(90_000 / 3);
  });
});

describe("abortOnClientDisconnect 客户端断开侦测（停止/空闲掐 fetch → 服务端中止生成）", () => {
  /** 假 res：EventEmitter + writableEnded 标志，模拟 res 'close' 事件。 */
  function makeFakeRes(writableEnded: boolean) {
    const res = new EventEmitter() as EventEmitter & { writableEnded: boolean };
    res.writableEnded = writableEnded;
    return res as unknown as ServerResponse;
  }

  it("响应未完成时连接被掐（close + writableEnded=false）→ abort 触发", () => {
    const res = makeFakeRes(false);
    const controller = abortOnClientDisconnect(res);
    expect(controller.signal.aborted).toBe(false);
    res.emit("close");
    expect(controller.signal.aborted).toBe(true);
  });

  it("正常 res.end() 收尾（close + writableEnded=true）→ 不误杀", () => {
    const res = makeFakeRes(true);
    const controller = abortOnClientDisconnect(res);
    res.emit("close");
    expect(controller.signal.aborted).toBe(false);
  });
});

describe("runObedientAgentTurn shouldStop（客户端断开：停转发、不重做）", () => {
  const passthroughScrubber = () => ({ push: (t: string) => t, flush: () => "" });

  it("首轮空转声称 + 客户端已断开 → 不再自动重做（不开新工具步骤）", async () => {
    let calls = 0;
    const streamAttempt = async () => {
      calls += 1;
      return (async function* () {
        yield { type: "text-delta", payload: { text: "第88章已正式入库。" } };
      })();
    };
    const events: { event: string; data: unknown }[] = [];
    await runObedientAgentTurn({
      initialMessages: [{ role: "user", content: "正式入库第88章。" }],
      userText: "正式入库第88章。",
      streamAttempt: streamAttempt as never,
      sendEvent: (event, data) => events.push({ event, data }),
      scrubber: passthroughScrubber(),
      shouldStop: () => true,
    });
    // 空转声称本已满足重做条件（零工具调用），但客户端已走——绝不为此再开一轮 agent.stream。
    expect(calls).toBe(1);
    const text = events.filter((e) => e.event === "text-delta").map((e) => (e.data as { text: string }).text).join("");
    expect(text).not.toContain(OBEDIENCE_RETRY_TRANSITION_TEXT);
  });

  it("流式途中断开 → 之后的 chunk 不再转发（停止流式输出），回合照常收场", async () => {
    let stopped = false;
    let calls = 0;
    const streamAttempt = async () => {
      calls += 1;
      return (async function* () {
        yield { type: "text-delta", payload: { text: "甲" } };
        stopped = true; // 客户端在「甲」之后断开
        yield { type: "text-delta", payload: { text: "乙" } };
        yield { type: "text-delta", payload: { text: "丙" } };
      })();
    };
    const events: { event: string; data: unknown }[] = [];
    await runObedientAgentTurn({
      initialMessages: [{ role: "user", content: "继续写。" }],
      userText: "继续写。",
      streamAttempt: streamAttempt as never,
      sendEvent: (event, data) => events.push({ event, data }),
      scrubber: passthroughScrubber(),
      shouldStop: () => stopped,
    });
    expect(calls).toBe(1);
    const text = events.filter((e) => e.event === "text-delta").map((e) => (e.data as { text: string }).text).join("");
    expect(text).toContain("甲");
    expect(text).not.toContain("乙");
    expect(text).not.toContain("丙");
  });
});
