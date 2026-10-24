import { afterEach, describe, expect, it, vi } from "vitest";
import { streamAgentChat } from "./agentChatClient.js";

/** 把若干 SSE 帧拼成一个文本，返回带 body(ReadableStream) 的 Response。 */
function sseResponse(frames: readonly string[], init?: { ok?: boolean; status?: number }): Response {
  const body = frames.join("");
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // 故意分两块推送，验证跨 chunk 的行缓冲。
      const bytes = encoder.encode(body);
      const mid = Math.floor(bytes.length / 2);
      controller.enqueue(bytes.slice(0, mid));
      controller.enqueue(bytes.slice(mid));
      controller.close();
    },
  });
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    body: stream,
  } as unknown as Response;
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** 一个永远不主动出数据的 Response：reader.read() 只在传入的 signal abort 时 reject（模拟上游半挂/被中止）。 */
function hangingResponse(): { fetchMock: ReturnType<typeof vi.fn> } {
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const signal = init.signal as AbortSignal;
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: () =>
            new Promise((_resolve, reject) => {
              const fail = () => reject(new DOMException("aborted", "AbortError"));
              if (signal.aborted) fail();
              else signal.addEventListener("abort", fail, { once: true });
            }),
          cancel: async () => undefined,
        }),
      },
    } as unknown as Response;
  });
  return { fetchMock };
}

const noopHandlers = () => ({
  onTextDelta: vi.fn(),
  onToolCall: vi.fn(),
  onToolResult: vi.fn(),
  onToolError: vi.fn(),
  onError: vi.fn(),
  onDone: vi.fn(),
});

describe("streamAgentChat", () => {
  it("posts to /api/agent/chat and dispatches text / tool / done events in order", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        frame("text-delta", { text: "你好" }),
        frame("tool-call", { toolCallId: "c1", toolName: "read_state_overview", args: {} }),
        frame("tool-result", {
          toolCallId: "c1",
          toolName: "read_state_overview",
          output: { summary: "读到了。", refreshScope: "full", overview: { project: { title: "T" } } },
        }),
        frame("text-delta", { text: "看完了。" }),
        frame("done", { finishReason: "stop" }),
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    const events: string[] = [];
    let textConcat = "";
    let toolResult: unknown;
    await streamAgentChat(
      { projectPath: "/tmp/p", messages: [{ role: "user", content: "现状？" }] },
      {
        onTextDelta: (text) => {
          events.push("text");
          textConcat += text;
        },
        onToolCall: (info) => {
          events.push(`call:${info.toolName}`);
        },
        onToolResult: (info) => {
          events.push(`result:${info.toolName}`);
          toolResult = info;
        },
        onToolError: () => events.push("tool-error"),
        onError: () => events.push("error"),
        onDone: () => events.push("done"),
      },
    );

    // 请求落到正确端点 + body 带 projectPath/messages。
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, requestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/agent/chat");
    expect(requestInit.method).toBe("POST");
    expect(JSON.parse(requestInit.body as string)).toEqual({
      projectPath: "/tmp/p",
      messages: [{ role: "user", content: "现状？" }],
    });

    expect(events).toEqual([
      "text",
      "call:read_state_overview",
      "result:read_state_overview",
      "text",
      "done",
    ]);
    expect(textConcat).toBe("你好看完了。");
    expect(toolResult).toEqual({
      toolCallId: "c1",
      toolName: "read_state_overview",
      summary: "读到了。",
      refreshScope: "full",
      overview: { project: { title: "T" } },
      snapshotId: undefined,
    });
  });

  it("passes snapshotId and foundation scope through onToolResult", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      sseResponse([
        frame("tool-result", {
          toolCallId: "c2",
          toolName: "foundation_write",
          output: { summary: "记下了。", refreshScope: "foundation", snapshotId: "snap-7", overview: {} },
        }),
        frame("done", {}),
      ]),
    ));

    let received: { snapshotId?: string; refreshScope?: string } | undefined;
    await streamAgentChat(
      { projectPath: "/tmp/p", messages: [{ role: "user", content: "记一下" }] },
      {
        onTextDelta: () => undefined,
        onToolCall: () => undefined,
        onToolResult: (info) => {
          received = info;
        },
        onToolError: () => undefined,
        onError: () => undefined,
        onDone: () => undefined,
      },
    );

    expect(received?.refreshScope).toBe("foundation");
    expect(received?.snapshotId).toBe("snap-7");
  });

  it("R7.9：校验失败标记 toolValidationFailure + ok:false + summary 随 tool-result 透传（投影层据此置「失败」并显示原因）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      sseResponse([
        frame("tool-result", {
          toolCallId: "g1",
          toolName: "generate_draft",
          output: {
            ok: false,
            toolValidationFailure: true,
            summary: "AI 传的参数没通过校验（mustHitBeats），这一步没有执行，具体原因已回给 AI 处理。",
          },
        }),
        frame("done", {}),
      ]),
    ));

    let received: { ok?: boolean; toolValidationFailure?: boolean; summary?: string } | undefined;
    await streamAgentChat(
      { projectPath: "/tmp/p", messages: [{ role: "user", content: "写第 5 章" }] },
      {
        onTextDelta: () => undefined,
        onToolCall: () => undefined,
        onToolResult: (info) => {
          received = info;
        },
        onToolError: () => undefined,
        onError: () => undefined,
        onDone: () => undefined,
      },
    );

    expect(received?.ok).toBe(false);
    expect(received?.toolValidationFailure).toBe(true);
    expect(received?.summary).toContain("没通过校验");
  });

  it("工具结果无 dryRun/action → 不带这两个 key（读类工具轻量投影行为不变）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      sseResponse([
        frame("tool-result", {
          toolCallId: "r1",
          toolName: "read_state_overview",
          output: { summary: "读到了。", refreshScope: "full", overview: {} },
        }),
        frame("done", {}),
      ]),
    ));

    let received: Record<string, unknown> | undefined;
    await streamAgentChat(
      { projectPath: "/tmp/p", messages: [{ role: "user", content: "现状？" }] },
      {
        onTextDelta: () => undefined,
        onToolCall: () => undefined,
        onToolResult: (info) => {
          received = info as unknown as Record<string, unknown>;
        },
        onToolError: () => undefined,
        onError: () => undefined,
        onDone: () => undefined,
      },
    );

    expect(received && "dryRun" in received).toBe(false);
    expect(received && "action" in received).toBe(false);
  });

  it("passes draftBody and draftTitle through onToolResult for draft-writing tools", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      sseResponse([
        frame("tool-result", {
          toolCallId: "d1",
          toolName: "generate_draft",
          output: {
            ok: true,
            summary: "第 1 章已生成正文并写入工作稿。",
            refreshScope: "full",
            overview: {},
            draftBody: "夜色四合，主角推开祠堂的木门。",
            draftTitle: "夜探祠堂",
          },
        }),
        frame("done", {}),
      ]),
    ));

    let received: { draftBody?: string; draftTitle?: string; ok?: boolean } | undefined;
    await streamAgentChat(
      { projectPath: "/tmp/p", messages: [{ role: "user", content: "写第一章" }] },
      {
        onTextDelta: () => undefined,
        onToolCall: () => undefined,
        onToolResult: (info) => {
          received = info;
        },
        onToolError: () => undefined,
        onError: () => undefined,
        onDone: () => undefined,
      },
    );

    // 真正文必须透传到投影层：否则前端只能用不含正文的 overview 刷新→草稿被占位覆盖→autosave 抹掉真正文。
    expect(received?.draftBody).toBe("夜色四合，主角推开祠堂的木门。");
    expect(received?.draftTitle).toBe("夜探祠堂");
    expect(received?.ok).toBe(true);
  });

  it("passes the check_ai_flavor report (violations/usedFallback) through onToolResult", async () => {
    // 体检卡需要 violations/usedFallback——这俩字段不在 read/draft 工具的投影白名单里，
    // 必须为 check_ai_flavor 专门透传整份 AiFlavorReport，否则前端拿不到违规清单。
    vi.stubGlobal("fetch", vi.fn(async () =>
      sseResponse([
        frame("tool-result", {
          toolCallId: "f1",
          toolName: "check_ai_flavor",
          output: {
            ok: true,
            summary: "有一处 AI 腔。",
            usedFallback: false,
            violations: [
              { id: "aiflavor-0", text: "心中五味杂陈。", reason: "套路抒情", severity: "high", suggestedFix: "改成具体动作" },
            ],
          },
        }),
        frame("done", {}),
      ]),
    ));

    let received: { aiFlavorReport?: { ok: boolean; violations: readonly unknown[]; usedFallback: boolean } } | undefined;
    await streamAgentChat(
      { projectPath: "/tmp/p", messages: [{ role: "user", content: "体检这章 AI 味" }] },
      {
        onTextDelta: () => undefined,
        onToolCall: () => undefined,
        onToolResult: (info) => {
          received = info;
        },
        onToolError: () => undefined,
        onError: () => undefined,
        onDone: () => undefined,
      },
    );

    expect(received?.aiFlavorReport?.ok).toBe(true);
    expect(received?.aiFlavorReport?.usedFallback).toBe(false);
    expect(received?.aiFlavorReport?.violations).toHaveLength(1);
  });

  it("translates commit_apply output.report (真实字段名) → commitReport for the 入库 delta 卡", async () => {
    // commit_apply 真实输出字段名是 report（commit-apply.ts），且只有 committed:true 才透传。
    // 测翻译层：原始帧给 report（不是 commitReport），断言 onToolResult 收到 commitReport。
    vi.stubGlobal("fetch", vi.fn(async () =>
      sseResponse([
        frame("tool-result", {
          toolCallId: "c1",
          toolName: "commit_apply",
          output: {
            ok: true,
            committed: true,
            report: { updatedCharacters: ["c1", "c2"], timelineEventIds: ["e1"], updatedHooks: [] },
          },
        }),
        frame("done", {}),
      ]),
    ));

    let received: { commitReport?: unknown } | undefined;
    await streamAgentChat(
      { projectPath: "/tmp/p", messages: [{ role: "user", content: "入库这章" }] },
      {
        onTextDelta: () => undefined,
        onToolCall: () => undefined,
        onToolResult: (info) => { received = info; },
        onToolError: () => undefined,
        onError: () => undefined,
        onDone: () => undefined,
      },
    );

    expect(received?.commitReport).toBeDefined();
    expect((received?.commitReport as { updatedCharacters?: readonly unknown[] }).updatedCharacters).toHaveLength(2);
  });

  it("does NOT translate commit_apply.report when committed=false (反谎报：入库未通过不挂卡)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      sseResponse([
        frame("tool-result", {
          toolCallId: "c2",
          toolName: "commit_apply",
          output: { ok: false, committed: false, report: { updatedCharacters: ["c1"] } },
        }),
        frame("done", {}),
      ]),
    ));

    let received: { commitReport?: unknown } | undefined;
    await streamAgentChat(
      { projectPath: "/tmp/p", messages: [{ role: "user", content: "入库这章" }] },
      {
        onTextDelta: () => undefined,
        onToolCall: () => undefined,
        onToolResult: (info) => { received = info; },
        onToolError: () => undefined,
        onError: () => undefined,
        onDone: () => undefined,
      },
    );

    expect(received?.commitReport).toBeUndefined();
  });

  it("translates quality_check output.refined (真实字段名) → qualityReport for the 质检明细卡", async () => {
    // quality_check 真实输出分层报告字段名是 refined（quality-check.ts）。测翻译层：原始帧给 refined，断言收到 qualityReport。
    vi.stubGlobal("fetch", vi.fn(async () =>
      sseResponse([
        frame("tool-result", {
          toolCallId: "q1",
          toolName: "quality_check",
          output: {
            ok: true,
            summary: "有 1 处硬伤。",
            refined: { passed: false, blocking: [{ type: "forbidden_reveal", label: "提前泄密", severity: "error", message: "m" }], soft: [], reference: [], summary: "s" },
          },
        }),
        frame("done", {}),
      ]),
    ));

    let received: { qualityReport?: unknown } | undefined;
    await streamAgentChat(
      { projectPath: "/tmp/p", messages: [{ role: "user", content: "质检这章" }] },
      {
        onTextDelta: () => undefined,
        onToolCall: () => undefined,
        onToolResult: (info) => { received = info; },
        onToolError: () => undefined,
        onError: () => undefined,
        onDone: () => undefined,
      },
    );

    expect(received?.qualityReport).toBeDefined();
    expect((received?.qualityReport as { blocking?: readonly unknown[] }).blocking).toHaveLength(1);
  });

  it("check_continuity 没核成（ok:false：还在读 / 出错）→ 不透传 continuityCheck，不出「没发现对不上」卡；pending 透传 continuityPending（R4.1/验收 3.1）", async () => {
    // 验收 3.1 的根因：只要有 sure/maybe 数组就建卡，空数组被渲染成「没发现对不上」的假成功卡。
    // 现在 ok:false 一律不建卡（还在读、模型失败、没正文都一样），只留工具文字如实说。
    vi.stubGlobal("fetch", vi.fn(async () =>
      sseResponse([
        frame("tool-result", {
          toolCallId: "cc1",
          toolName: "check_continuity",
          output: {
            ok: false,
            chapter: 5,
            source: "draft",
            sure: [],
            maybe: [],
            failures: ["核账员还在读前文（第 4 / 57 章），这次没核"],
            pending: { done: 4, total: 57 },
            summary: "核账员还在读这本书的前文：第 4 / 57 章。这次没有核（不糊弄）。",
          },
        }),
        frame("tool-result", {
          toolCallId: "cc2",
          toolName: "check_continuity",
          output: { ok: false, chapter: 5, source: "draft", sure: [], maybe: [], failures: ["第 1 遍（盯东西）没跑成"], summary: "第 5 章核账没跑成。" },
        }),
        frame("tool-result", {
          toolCallId: "cc3",
          toolName: "check_continuity",
          output: { ok: false, chapter: 5, source: null, sure: [], maybe: [], summary: "第 5 章还没有正文，没法核账。" },
        }),
        frame("done", {}),
      ]),
    ));

    const received: { continuityCheck?: unknown; continuityPending?: unknown }[] = [];
    await streamAgentChat(
      { projectPath: "/tmp/p", messages: [{ role: "user", content: "核一下" }] },
      {
        onTextDelta: () => undefined,
        onToolCall: () => undefined,
        onToolResult: (info) => { received.push(info); },
        onToolError: () => undefined,
        onError: () => undefined,
        onDone: () => undefined,
      },
    );

    expect(received).toHaveLength(3);
    for (const info of received) expect(info.continuityCheck).toBeUndefined();
    // 「还在读」的结构化进度照透传（前端区分「还在读」和「出错」用这个字段，别解析 failures 文字）；
    // 出错 / 没正文没有 pending。
    expect(received[0]?.continuityPending).toEqual({ done: 4, total: 57 });
    expect(received[1]?.continuityPending).toBeUndefined();
    expect(received[2]?.continuityPending).toBeUndefined();
  });

  it("check_continuity ok:true 且 0 处 → 照旧透传 continuityCheck（渲染「没发现对不上」卡，正常路不回归）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      sseResponse([
        frame("tool-result", {
          toolCallId: "cc4",
          toolName: "check_continuity",
          output: { ok: true, chapter: 4, source: "draft", sure: [], maybe: [], failures: [], summary: "核了第 4 章，没发现和前文对不上的地方。" },
        }),
        frame("done", {}),
      ]),
    ));

    let received: { continuityCheck?: unknown } | undefined;
    await streamAgentChat(
      { projectPath: "/tmp/p", messages: [{ role: "user", content: "核一下" }] },
      {
        onTextDelta: () => undefined,
        onToolCall: () => undefined,
        onToolResult: (info) => { received = info; },
        onToolError: () => undefined,
        onError: () => undefined,
        onDone: () => undefined,
      },
    );

    expect(received?.continuityCheck).toEqual({ chapter: 4, sure: [], maybe: [] });
  });

  it("check_continuity 带 earlierOpen（前面章节之前报过、没改的）→ 透传进 continuityCheck", async () => {
    const old = { quote: "走了五年", earlierQuote: "三年前过世", earlierChapter: 3, fixChapter: 3, reason: "设定说三年", againstSetting: { label: "人物卡" } };
    vi.stubGlobal("fetch", vi.fn(async () =>
      sseResponse([
        frame("tool-result", {
          toolCallId: "cc5",
          toolName: "check_continuity",
          output: { ok: true, chapter: 8, source: "draft", sure: [], maybe: [], earlierOpen: [old], failures: [], checkedVersion: "abc123", summary: "核了第 8 章，没发现和前文对不上的地方。第 3 章还有 1 处之前报过、还没改。" },
        }),
        frame("done", {}),
      ]),
    ));

    let received: { continuityCheck?: unknown; checkedVersion?: string } | undefined;
    await streamAgentChat(
      { projectPath: "/tmp/p", messages: [{ role: "user", content: "核一下" }] },
      {
        onTextDelta: () => undefined,
        onToolCall: () => undefined,
        onToolResult: (info) => { received = info; },
        onToolError: () => undefined,
        onError: () => undefined,
        onDone: () => undefined,
      },
    );

    expect(received?.continuityCheck).toEqual({ chapter: 8, sure: [], maybe: [], earlierOpen: [old] });
    expect(received?.checkedVersion).toBe("abc123");
  });

  it("定论（P12）：settle_preview / settle_fact 的卡防御解析后透传；没查成不建卡；settle_apply 成功带票号", async () => {
    const settle = {
      token: "0123456789abcdef",
      canon: "杜长顺十年前去世",
      canonExists: false,
      chapter: 4,
      edits: [{ key: "e1", chapter: 2, draft: false, from: "“杜叔走了五年了。”", to: "“杜叔走了十年了。”" }, { key: "", chapter: 2, from: "坏的", to: "丢掉" }],
      facts: [{ chapter: 2, before: "杜长顺五年前去世", after: "杜长顺十年前去世" }],
      fields: [],
      searched: [1, 2, 4],
      failures: [],
    };
    vi.stubGlobal("fetch", vi.fn(async () =>
      sseResponse([
        frame("tool-result", { toolCallId: "s1", toolName: "settle_preview", output: { ok: true, summary: "定论", settle } }),
        frame("tool-result", { toolCallId: "s2", toolName: "settle_fact", output: { ok: false, summary: "没写出定论", settle } }),
        frame("tool-result", { toolCallId: "s3", toolName: "settle_apply", output: { ok: true, summary: "改齐了。", settleToken: settle.token, refreshScope: "full" } }),
        frame("done", {}),
      ]),
    ));
    const received: { toolName: string; settle?: unknown; settleToken?: string }[] = [];
    await streamAgentChat(
      { projectPath: "/tmp/p", messages: [{ role: "user", content: "以第 1 章为准" }] },
      {
        onTextDelta: () => undefined,
        onToolCall: () => undefined,
        onToolResult: (info) => { received.push(info); },
        onToolError: () => undefined,
        onError: () => undefined,
        onDone: () => undefined,
      },
    );
    expect(received[0]?.settle).toEqual({ ...settle, edits: [settle.edits[0]] });
    expect(received[1]?.settle).toBeUndefined();
    expect(received[2]?.settleToken).toBe(settle.token);
  });

  it("suggest_next_steps 的 choice.action（R4.7）→ 白名单内透传、白名单外/形状不对丢掉（选项保留，退回发文本）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      sseResponse([
        frame("tool-result", {
          toolCallId: "ns1",
          toolName: "suggest_next_steps",
          output: {
            ok: true,
            question: "核账做完了，接下来？",
            choices: [
              { label: "预览定稿", intent: "预览第 5 章的定稿改动", recommended: true, action: { toolName: "commit_preview", chapter: 5 } },
              { label: "再细核一遍", intent: "再细核一遍：这一章重新对一遍前文", action: { toolName: "check_continuity", chapter: 5, fresh: true } },
              { label: "我自己改", intent: "我自己改，先放着" },
              // 白名单外（授权写盘动作不许藏在选项里直达）→ action 丢掉，选项照旧发文本。
              { label: "假确认定稿", intent: "x", action: { toolName: "commit_apply", chapter: 5 } },
              { label: "坏章号", intent: "y", action: { toolName: "commit_preview", chapter: 0 } },
              { label: "认不出的工具", intent: "z", action: { toolName: "web_search" } },
            ],
          },
        }),
        frame("done", {}),
      ]),
    ));

    let received: { nextStepPrompt?: unknown } | undefined;
    await streamAgentChat(
      { projectPath: "/tmp/p", messages: [{ role: "user", content: "核一下" }] },
      {
        onTextDelta: () => undefined,
        onToolCall: () => undefined,
        onToolResult: (info) => { received = info; },
        onToolError: () => undefined,
        onError: () => undefined,
        onDone: () => undefined,
      },
    );

    const prompt = received?.nextStepPrompt as { question: string; choices: { label: string; action?: { toolName: string } }[] };
    expect(prompt.question).toBe("核账做完了，接下来？");
    expect(prompt.choices[0]).toMatchObject({ label: "预览定稿", action: { toolName: "commit_preview" } });
    expect(prompt.choices[1]).toMatchObject({ label: "再细核一遍", action: { toolName: "check_continuity" } });
    expect(prompt.choices[1].action).toMatchObject({ fresh: true });
    expect(prompt.choices[2]).not.toHaveProperty("action");
    expect(prompt.choices[3]).not.toHaveProperty("action");
    expect(prompt.choices[4]).not.toHaveProperty("action");
    expect(prompt.choices[5]).not.toHaveProperty("action");
  });

  it("quality_check ok:false（防御位）→ 不透传 refined 质检卡（今天失败走抛错，ok:false+refined 一旦出现不能显成「质检通过」卡）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      sseResponse([
        frame("tool-result", {
          toolCallId: "q2",
          toolName: "quality_check",
          output: {
            ok: false,
            summary: "没跑成。",
            refined: { passed: true, blocking: [], soft: [], reference: [], summary: "s" },
          },
        }),
        frame("done", {}),
      ]),
    ));

    let received: { qualityReport?: unknown } | undefined;
    await streamAgentChat(
      { projectPath: "/tmp/p", messages: [{ role: "user", content: "质检这章" }] },
      {
        onTextDelta: () => undefined,
        onToolCall: () => undefined,
        onToolResult: (info) => { received = info; },
        onToolError: () => undefined,
        onError: () => undefined,
        onDone: () => undefined,
      },
    );

    expect(received?.qualityReport).toBeUndefined();
  });

  it("ai_review ok:false（防御位）→ 不透传 draftReview 审稿卡（usedFallback 之外的失败位，空手不显成「1 处问题」卡）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      sseResponse([
        frame("tool-result", {
          toolCallId: "ar1",
          toolName: "ai_review",
          output: {
            ok: false,
            usedFallback: false,
            review: { issues: [{ id: "x", message: "m" }] },
            summary: "这次没审完。",
          },
        }),
        frame("done", {}),
      ]),
    ));

    let received: { draftReview?: unknown } | undefined;
    await streamAgentChat(
      { projectPath: "/tmp/p", messages: [{ role: "user", content: "审一下" }] },
      {
        onTextDelta: () => undefined,
        onToolCall: () => undefined,
        onToolResult: (info) => { received = info; },
        onToolError: () => undefined,
        onError: () => undefined,
        onDone: () => undefined,
      },
    );

    expect(received?.draftReview).toBeUndefined();
  });

  it("translates commit_preview 裁决（R3）→ commitPreview for 定稿预览卡（不靠模型转述）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      sseResponse([
        frame("tool-result", {
          toolCallId: "p1",
          toolName: "commit_preview",
          output: {
            ok: false,
            chapter: 7,
            canCommit: false,
            blockingReasons: ["第 7 章还没有工作稿。"],
            summary: "暂不可定稿。",
            draftQualityIssues: [{ severity: "error", type: "too_short", message: "正文过短" }],
            semanticQualityIssues: [],
          },
        }),
        frame("done", {}),
      ]),
    ));

    let received: { commitPreview?: unknown } | undefined;
    await streamAgentChat(
      { projectPath: "/tmp/p", messages: [{ role: "user", content: "预览定稿" }] },
      {
        onTextDelta: () => undefined,
        onToolCall: () => undefined,
        onToolResult: (info) => { received = info; },
        onToolError: () => undefined,
        onError: () => undefined,
        onDone: () => undefined,
      },
    );

    expect(received?.commitPreview).toEqual({
      chapter: 7,
      canCommit: false,
      blockingReasons: ["第 7 章还没有工作稿。"],
      summary: "暂不可定稿。",
      draftIssueCount: 1,
      semanticIssueCount: 0,
      // R7.7·报告 4.3：明细文案直接透传进卡（默认折叠展示），不再指向不存在的「质检卡」。
      draftIssues: ["正文过短"],
    });
  });

  it("commit_preview 质量问题明细防御解析：非对象丢掉、无 message 丢掉、裸字符串宽容保留（R7.7）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      sseResponse([
        frame("tool-result", {
          toolCallId: "p1",
          toolName: "commit_preview",
          output: {
            chapter: 7,
            canCommit: false,
            semanticQualityIssues: [
              { severity: "warning", type: "stale_thread", message: "伏笔「钥匙」已 4 章未推进。" },
              { severity: "warning", type: "no_message" },
              "裸字符串不算",
              null,
            ],
          },
        }),
        frame("done", {}),
      ]),
    ));

    let received: { commitPreview?: { semanticIssues?: readonly string[] } } | undefined;
    await streamAgentChat(
      { projectPath: "/tmp/p", messages: [{ role: "user", content: "预览定稿" }] },
      {
        onTextDelta: () => undefined,
        onToolCall: () => undefined,
        onToolResult: (info) => { received = info; },
        onToolError: () => undefined,
        onError: () => undefined,
        onDone: () => undefined,
      },
    );

    expect(received?.commitPreview?.semanticIssues).toEqual(["伏笔「钥匙」已 4 章未推进。", "裸字符串不算"]);
  });

  it("结构化动作（「确认定稿」按钮）→ 请求体带 action；commit_preview 的 previewToken 透传给卡（按钮带回）", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        frame("tool-result", {
          toolCallId: "p1",
          toolName: "commit_preview",
          output: { ok: true, chapter: 2, canCommit: true, previewToken: "tok-2", summary: "可以定稿。" },
        }),
        frame("done", {}),
      ]),
    );
    vi.stubGlobal("fetch", fetchMock);

    let received: { commitPreview?: unknown } | undefined;
    await streamAgentChat(
      {
        projectPath: "/tmp/p",
        messages: [{ role: "user", content: "确认定稿第 2 章" }],
        action: { toolName: "commit_apply", chapter: 2, previewToken: "tok-2" },
      },
      { ...noopHandlers(), onToolResult: (info) => { received = info; } },
    );

    const [, requestInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(requestInit.body)).action).toEqual({ toolName: "commit_apply", chapter: 2, previewToken: "tok-2" });
    expect(received?.commitPreview).toMatchObject({ chapter: 2, canCommit: true, previewToken: "tok-2" });
  });

  it("模型发起的 commit_apply 只出确认按钮（needsConfirmation + confirmAction）→ 透传 commitConfirmAction；残缺 confirmAction 不透传", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      sseResponse([
        frame("tool-result", {
          toolCallId: "a1",
          toolName: "commit_apply",
          output: { ok: false, committed: false, needsConfirmation: true, confirmAction: { toolName: "commit_apply", chapter: 4, previewToken: "t4" }, summary: "等你点确认定稿。" },
        }),
        frame("tool-result", {
          toolCallId: "a2",
          toolName: "commit_apply",
          output: { ok: false, committed: false, needsConfirmation: true, confirmAction: { toolName: "commit_apply" }, summary: "残缺。" },
        }),
        frame("done", {}),
      ]),
    ));

    const received: { commitConfirmAction?: unknown; needsConfirmation?: boolean }[] = [];
    await streamAgentChat(
      { projectPath: "/tmp/p", messages: [{ role: "user", content: "确认定稿" }] },
      { ...noopHandlers(), onToolResult: (info) => { received.push(info); } },
    );

    expect(received[0]?.needsConfirmation).toBe(true);
    expect(received[0]?.commitConfirmAction).toEqual({ chapter: 4, previewToken: "t4" });
    expect(received[1]?.commitConfirmAction).toBeUndefined();
  });

  it("commit_preview 残缺输出（无 chapter/canCommit）→ 不挂 commitPreview 卡（防御解析）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      sseResponse([
        frame("tool-result", { toolCallId: "p1", toolName: "commit_preview", output: { ok: true, summary: "可以。" } }),
        frame("done", {}),
      ]),
    ));

    let received: { commitPreview?: unknown } | undefined;
    await streamAgentChat(
      { projectPath: "/tmp/p", messages: [{ role: "user", content: "预览定稿" }] },
      {
        onTextDelta: () => undefined,
        onToolCall: () => undefined,
        onToolResult: (info) => { received = info; },
        onToolError: () => undefined,
        onError: () => undefined,
        onDone: () => undefined,
      },
    );

    expect(received?.commitPreview).toBeUndefined();
  });

  it("routes an SSE status event to onStatus（R4：历史裁剪等说明不静默吞掉）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      sseResponse([
        frame("status", { message: "对话历史较长，本次只把最近 12 条发给模型。" }),
        frame("text-delta", { text: "我看了一下。" }),
        frame("done", {}),
      ]),
    ));

    const statuses: string[] = [];
    await streamAgentChat(
      { projectPath: "/tmp/p", messages: [{ role: "user", content: "继续" }] },
      {
        onTextDelta: () => undefined,
        onStatus: (message) => statuses.push(message),
        onToolCall: () => undefined,
        onToolResult: () => undefined,
        onToolError: () => undefined,
        onError: () => undefined,
        onDone: () => undefined,
      },
    );

    expect(statuses).toEqual(["对话历史较长，本次只把最近 12 条发给模型。"]);
  });

  it("routes an SSE usage event to onUsage（这一轮真实 token 用量）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      sseResponse([
        frame("text-delta", { text: "好了。" }),
        frame("usage", { agent: {}, pipeline: {}, total: { calls: 10, input: 155000, cachedInput: 106000, output: 9000, reasoning: 3000 } }),
        frame("done", {}),
      ]),
    ));
    const usages: unknown[] = [];
    await streamAgentChat(
      { projectPath: "/tmp/p", messages: [{ role: "user", content: "写第 8 章" }] },
      {
        onTextDelta: () => undefined,
        onUsage: (usage) => usages.push(usage),
        onToolCall: () => undefined,
        onToolResult: () => undefined,
        onToolError: () => undefined,
        onError: () => undefined,
        onDone: () => undefined,
      },
    );
    expect(usages).toEqual([{ input: 155000, cachedInput: 106000, output: 9000 }]);
  });

  it("routes an SSE error event to onError with retryable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      sseResponse([
        frame("error", { error: "落盘失败", retryable: true }),
        frame("done", {}),
      ]),
    ));

    const errors: { message: string; retryable: boolean }[] = [];
    let done = false;
    await streamAgentChat(
      { projectPath: "/tmp/p", messages: [{ role: "user", content: "x" }] },
      {
        onTextDelta: () => undefined,
        onToolCall: () => undefined,
        onToolResult: () => undefined,
        onToolError: () => undefined,
        onError: (message, retryable) => errors.push({ message, retryable }),
        onDone: () => {
          done = true;
        },
      },
    );

    expect(errors).toEqual([{ message: "落盘失败", retryable: true }]);
    expect(done).toBe(true);
  });

  it("routes an SSE tool-error event to onToolError (with toolCallId/toolName), not onError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      sseResponse([
        frame("tool-call", { toolCallId: "c9", toolName: "foundation_write", args: {} }),
        frame("tool-error", {
          toolCallId: "c9",
          toolName: "foundation_write",
          error: "落盘失败",
          retryable: true,
        }),
        frame("done", {}),
      ]),
    ));

    const toolErrors: { toolCallId?: string; toolName: string; message: string; retryable: boolean }[] = [];
    let onErrorCalls = 0;
    let done = false;
    await streamAgentChat(
      { projectPath: "/tmp/p", messages: [{ role: "user", content: "记一下" }] },
      {
        onTextDelta: () => undefined,
        onToolCall: () => undefined,
        onToolResult: () => undefined,
        onToolError: (info) => toolErrors.push(info),
        onError: () => {
          onErrorCalls += 1;
        },
        onDone: () => {
          done = true;
        },
      },
    );

    expect(toolErrors).toEqual([
      { toolCallId: "c9", toolName: "foundation_write", message: "落盘失败", retryable: true },
    ]);
    expect(onErrorCalls).toBe(0);
    expect(done).toBe(true);
  });

  it("reports onError when the HTTP response is not ok", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      ({ ok: false, status: 500, body: null } as unknown as Response)));

    const errors: string[] = [];
    await streamAgentChat(
      { projectPath: "/tmp/p", messages: [{ role: "user", content: "x" }] },
      {
        onTextDelta: () => undefined,
        onToolCall: () => undefined,
        onToolResult: () => undefined,
        onToolError: () => undefined,
        onError: (message) => errors.push(message),
        onDone: () => undefined,
      },
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("500");
  });

  it("非 2xx 时透传服务端真实原因（治『请求失败：500』摸不着头脑）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 500,
      body: null,
      text: async () => JSON.stringify({ ok: false, error: "项目目录不存在。", retryable: true }),
    } as unknown as Response)));

    const errors: string[] = [];
    await streamAgentChat(
      { projectPath: "/tmp/p", messages: [{ role: "user", content: "x" }] },
      {
        onTextDelta: () => undefined,
        onToolCall: () => undefined,
        onToolResult: () => undefined,
        onToolError: () => undefined,
        onError: (message) => errors.push(message),
        onDone: () => undefined,
      },
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBe("项目目录不存在。");
  });

  it("M3 空闲看门狗：约90秒无数据 → 报可重试超时、收尾 done（治永久转圈）", async () => {
    vi.useFakeTimers();
    const { fetchMock } = hangingResponse();
    vi.stubGlobal("fetch", fetchMock);
    const h = noopHandlers();

    const p = streamAgentChat({ projectPath: "/tmp/p", messages: [{ role: "user", content: "现状？" }] }, h);
    // 推进到看门狗触发：abort 内部 controller → reader.read() reject → 走超时收尾。
    await vi.advanceTimersByTimeAsync(90_000 + 10);
    await p;

    expect(h.onError).toHaveBeenCalledTimes(1);
    const [msg, retryable] = h.onError.mock.calls[0];
    expect(msg).toContain("超时");
    expect(retryable).toBe(true);
    expect(h.onDone).toHaveBeenCalledTimes(1);
  });

  it("M3 用户主动停止（abort signal）→ 不留错误气泡，干净收尾 done", async () => {
    const { fetchMock } = hangingResponse();
    vi.stubGlobal("fetch", fetchMock);
    const h = noopHandlers();
    const controller = new AbortController();

    const p = streamAgentChat(
      { projectPath: "/tmp/p", messages: [{ role: "user", content: "现状？" }] },
      h,
      controller.signal,
    );
    await new Promise((r) => setTimeout(r, 0)); // 让 fetch resolve、read() 挂起
    controller.abort();
    await p;

    // 用户停止：不报错（无错误气泡），但要收尾 done（解锁 loading）。
    expect(h.onError).not.toHaveBeenCalled();
    expect(h.onDone).toHaveBeenCalledTimes(1);
  });
});
