import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_IDLE_TIMEOUT_MS, streamAgentChat, isDraftReview } from "./agentChatClient.js";

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

  it("passes dryRun/action (诚实背书粒度) through onToolResult — exemplars add 不再被前端误判「操作未完成」(P2③)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      sseResponse([
        frame("tool-result", {
          toolCallId: "e1",
          toolName: "manage_style_exemplars",
          output: { ok: true, action: "add", summary: "已存文风样本「雨夜开场」。" },
        }),
        frame("tool-result", {
          toolCallId: "p1",
          toolName: "prune_snapshots",
          output: { ok: true, dryRun: true, summary: "预览：将裁 3 条快照。" },
        }),
        frame("done", {}),
      ]),
    ));

    const received: readonly { readonly toolName: string; readonly dryRun?: boolean; readonly action?: string }[] = [];
    await streamAgentChat(
      { projectPath: "/tmp/p", messages: [{ role: "user", content: "加一条文风样本" }] },
      {
        onTextDelta: () => undefined,
        onToolCall: () => undefined,
        onToolResult: (info) => {
          (received as { toolName: string; dryRun?: boolean; action?: string }[]).push(info);
        },
        onToolError: () => undefined,
        onError: () => undefined,
        onDone: () => undefined,
      },
    );

    // 与服务端 honesty-detection stepBacksWriteClaim 认的字段名逐字对齐。
    expect(received[0]).toMatchObject({ toolName: "manage_style_exemplars", action: "add" });
    expect(received[1]).toMatchObject({ toolName: "prune_snapshots", dryRun: true });
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
    await vi.advanceTimersByTimeAsync(AGENT_IDLE_TIMEOUT_MS + 10);
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

describe("isDraftReview（审稿失败 fallback 不当审校问题卡渲染）", () => {
  it("正常审稿（有 issues 数组、非 fallback）→ true", () => {
    expect(isDraftReview({ review: { issues: [{ id: "x" }] }, usedFallback: false })).toBe(true);
  });
  it("usedFallback=true（审稿没跑成）→ false，绝不渲染成『审校问题 1 处』误导", () => {
    expect(isDraftReview({ review: { issues: [{ id: "ai-review-format-error" }] }, usedFallback: true })).toBe(false);
  });
  it("形状不符（无 issues 数组）→ false", () => {
    expect(isDraftReview({ review: {} })).toBe(false);
    expect(isDraftReview({})).toBe(false);
  });
});
