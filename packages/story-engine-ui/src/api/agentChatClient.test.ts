import { afterEach, describe, expect, it, vi } from "vitest";
import { readStoredOperationAction, streamAgentChat, type OperationViewData } from "./agentChatClient.js";

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

const OP_ID = "op-0123456789abcdef0123";

/** 服务端的操作视图（写作版本 P2a）：检查做完了，结果体照四个检查原来的输出形状。 */
function opView(mode: string, body: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    opId: OP_ID, kind: "inspect.run", mode, what: "核账·第 8 章", chapter: 8, state: "succeeded", stateText: "做完了", allowed: [],
    origin: { kind: "chat", messageId: "user-1", chapter: 3 }, summary: "做完了",
    result: { schema: "operation-result/1", summary: "做完了", body }, pendingActions: [], eventSeq: 4, createdAt: "", updatedAt: "",
    ...overrides,
  };
}

/** 发几帧 operation 事件，收 onOperation / onOperationProgress。 */
async function collectOperations(frames: readonly string[]) {
  vi.stubGlobal("fetch", vi.fn(async () => sseResponse([...frames, frame("done", {})])));
  const views: OperationViewData[] = [];
  const progress: { opId: string; text: string }[] = [];
  await streamAgentChat(
    { projectPath: "/tmp/p", messages: [{ role: "user", content: "核一下" }] },
    {
      onTextDelta: () => undefined, onToolCall: () => undefined, onToolResult: () => undefined, onToolError: () => undefined,
      onError: () => undefined, onDone: () => undefined,
      onOperation: (view) => { views.push(view); },
      onOperationProgress: (item) => { progress.push(item); },
    },
  );
  return { views, progress };
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

  it("出完稿这一轮别的工具没让执行：skipped 随 tool-result 透传（投影层置「已停止」）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      sseResponse([
        frame("tool-result", { toolCallId: "p1", toolName: "commit_preview", output: { ok: false, skipped: true, summary: "这一步先不做" } }),
        frame("done", {}),
      ]),
    ));
    let received: { ok?: boolean; skipped?: boolean } | undefined;
    await streamAgentChat(
      { projectPath: "/tmp/p", messages: [{ role: "user", content: "写第 25 章" }] },
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
    expect(received).toMatchObject({ ok: false, skipped: true });
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

  it("检查做完（operation 事件）→ 视图带针对的章；核账结果按原来的卡片字段解析（revisited、earlierOpen、查的版本）", async () => {
    const twice = { quote: "还剩八天", earlierQuote: "还剩九天", earlierChapter: 7, reason: "天数", revisited: { from: "还剩九天。" } };
    const bad = { quote: "她走了", earlierQuote: "她没走", earlierChapter: 7, reason: "去留", revisited: { from: 3 } };
    const old = { quote: "走了五年", earlierQuote: "三年前过世", earlierChapter: 3, fixChapter: 3, reason: "设定说三年", againstSetting: { label: "人物卡" } };
    const { views } = await collectOperations([
      frame("operation", { type: "record", operation: opView("continuity", { ok: true, chapter: 8, source: "draft", checkedVersion: "abc123", sure: [], maybe: [twice, bad], earlierOpen: [old], failures: [], summary: "核了" }) }),
    ]);
    const { revisited: _ignored, ...plain } = bad;
    expect(views[0]).toMatchObject({ opId: OP_ID, mode: "continuity", chapter: 8, what: "核账·第 8 章", state: "succeeded", origin: { kind: "chat", messageId: "user-1" } });
    expect(views[0]?.inspect).toEqual({ continuityCheck: { chapter: 8, sure: [], maybe: [twice, plain], earlierOpen: [old] }, checkedVersion: "abc123" });
  });

  it("硬伤检查 / 内容审阅 / 查 AI 味做完 → 各自的结果卡字段；查的是定稿时不带版本", async () => {
    const refined = { passed: false, blocking: [{ type: "forbidden_reveal", label: "提前泄密", severity: "error", message: "m" }], soft: [], reference: [], summary: "s" };
    const review = { issues: [{ id: "x", message: "m" }] };
    const violations = [{ id: "aiflavor-0", text: "心中五味杂陈。", reason: "套路抒情", severity: "high", suggestedFix: "改成具体动作" }];
    const { views } = await collectOperations([
      frame("operation", { type: "record", operation: opView("quality", { ok: true, source: "draft", checkedVersion: "v1", refined }) }),
      frame("operation", { type: "record", operation: opView("review", { ok: true, usedFallback: false, source: "committed", checkedVersion: "v1", review }) }),
      frame("operation", { type: "record", operation: opView("flavor", { ok: true, usedFallback: false, source: "draft", checkedVersion: "v2", violations }) }),
    ]);
    expect(views[0]?.inspect).toEqual({ qualityReport: refined, checkedVersion: "v1" });
    expect(views[1]?.inspect).toEqual({ draftReview: review });
    expect(views[2]?.inspect).toMatchObject({ aiFlavorReport: { ok: true, usedFallback: false, violations }, checkedVersion: "v2" });
  });

  it("没查成的不出结果卡：ok:false、审稿走了回退、操作没做成（空清单不等于没问题）", async () => {
    const { views } = await collectOperations([
      frame("operation", { type: "record", operation: opView("continuity", { ok: false, chapter: 8, source: "draft", sure: [], maybe: [], failures: ["没跑成"] }) }),
      frame("operation", { type: "record", operation: opView("quality", { ok: false, refined: { passed: true, blocking: [], soft: [], reference: [], summary: "s" } }) }),
      frame("operation", { type: "record", operation: opView("review", { ok: true, usedFallback: true, review: { issues: [{ id: "x", message: "AI 审稿结果不可用" }] } }) }),
      frame("operation", { type: "record", operation: opView("flavor", { ok: false, usedFallback: false, violations: [] }) }),
      frame("operation", { type: "record", operation: opView("continuity", { ok: true, chapter: 8, sure: [], maybe: [] }, { state: "failed", failure: { code: "x", message: "模型没回", retryable: true } }) }),
    ]);
    expect(views).toHaveLength(5);
    for (const view of views) expect(view.inspect).toBeUndefined();
    expect(views[4]).toMatchObject({ state: "failed", failure: { message: "模型没回", retryable: true } });
  });

  it("写稿做完了 → draft（章、换没换上、章名、存档点按先后、落选几版）；没做完、不是写稿的不带", async () => {
    const draftView = (body: unknown, overrides: Record<string, unknown> = {}) => opView("write", body, { kind: "draft.change", what: "写稿·第 38 章", chapter: 38, ...overrides });
    const { views } = await collectOperations([
      frame("operation", { type: "record", operation: draftView({ kind: "draft.change", mode: "write", ok: true, chapter: 38, draftTitle: " 雨夜 ", planSnapshotId: "s-plan", snapshotId: "s-draft", otherVersions: [{ index: 1, candidateId: "0038-op-1", sha: "a".repeat(64), body: "另一版。" }] }) }),
      frame("operation", { type: "record", operation: draftView({ kind: "draft.change", mode: "write", pick: "author", ok: false, chapter: 38, planSnapshotId: "s-plan", otherVersions: [{ index: 1, candidateId: "0038-op-1", sha: "a".repeat(64), body: "甲。" }, { index: 2, candidateId: "0038-op-2", handled: true }] }) }),
      frame("operation", { type: "record", operation: opView("write", { kind: "draft.adopt", chapter: 38, applied: true, version: "v9", snapshotId: "s-adopt" }, { kind: "draft.adopt", what: "换上 AI 稿·第 38 章", chapter: 38, mode: undefined }) }),
      frame("operation", { type: "record", operation: draftView({ kind: "draft.change", mode: "write", ok: false, chapter: 38, planSnapshotId: "s-plan", snapshotId: "s-stale", kept: { candidateId: "c1", reason: "draft_moved" } }) }),
      frame("operation", { type: "record", operation: draftView({ kind: "draft.change", mode: "write", ok: true, chapter: 38 }, { state: "running" }) }),
      frame("operation", { type: "record", operation: opView("continuity", { kind: "draft.change", ok: true, chapter: 8 }) }),
    ]);
    expect(views[0]?.draft).toEqual({ chapter: 38, applied: true, title: "雨夜", snapshots: ["s-plan", "s-draft"], versions: { chapter: 38, versions: [{ index: 1, candidateId: "0038-op-1", sha: "a".repeat(64), body: "另一版。" }] } });
    // 作者自己挑：一版都没换上，几版带 pick；处理过的那版不收。
    expect(views[1]?.draft).toEqual({ chapter: 38, applied: false, snapshots: ["s-plan"], versions: { chapter: 38, pick: true, versions: [{ index: 1, candidateId: "0038-op-1", sha: "a".repeat(64), body: "甲。" }] } });
    // 换上作者挑的那版：带存档点。
    expect(views[2]?.draft).toEqual({ chapter: 38, applied: true, snapshots: ["s-adopt"] });
    // 没换上：稿的存档点不算（没写），章纲存过的照算。
    expect(views[3]?.draft).toEqual({ chapter: 38, applied: false, snapshots: ["s-plan"] });
    expect(views[4]?.draft).toBeUndefined();
    expect(views[5]?.draft).toBeUndefined();
  });

  it("想走法（片 2D）做完了 → plan（走法卡那一份）；没做完、没想出能用的不带", async () => {
    const planView = (body: unknown, overrides: Record<string, unknown> = {}) => opView("", body, { kind: "plan.propose", mode: undefined, what: "想走法·第 8 章", ...overrides });
    const options = [{ title: "老周开口", steps: ["夜里上楼", "说出钥匙在哪"], recommended: true, threads: [], problems: [] }];
    const { views } = await collectOperations([
      frame("operation", { type: "record", operation: planView({ kind: "plan.propose", ok: true, chapter: 8, idea: "让老周开口", options, checked: true, summary: "s" }) }),
      frame("operation", { type: "record", operation: planView({ kind: "plan.propose", ok: true, chapter: 8, options, checked: true }, { state: "running" }) }),
      frame("operation", { type: "record", operation: planView({ kind: "plan.propose", ok: true, chapter: 8, options: [], checked: false }) }),
    ]);
    expect(views[0]?.plan).toEqual({ chapter: 8, idea: "让老周开口", options, checked: true });
    expect(views[1]?.plan).toBeUndefined();
    expect(views[2]?.plan).toBeUndefined();
  });

  it("「再想一次」按钮存下来、读回来（和服务端同一口径）：章号不对的不认", () => {
    const stamp = { requestKey: "rk-1", issuedAt: "2026-10-30T00:00:00.000Z" };
    expect(readStoredOperationAction({ kind: "new", type: "plan.propose", params: { chapter: 8, idea: " 让老周开口 ", avoid: ["甲", "甲", " "] }, ...stamp }))
      .toEqual({ kind: "new", type: "plan.propose", params: { chapter: 8, idea: "让老周开口", avoid: ["甲"] }, ...stamp });
    expect(readStoredOperationAction({ kind: "new", type: "plan.propose", params: { chapter: 0 }, ...stamp })).toBeUndefined();
  });

  it("改稿（片 2C）做完了 → draft 带改了的几处；停着等作者的带改法和能点的决定，点过的、认不出的不算", async () => {
    const editView = (overrides: Record<string, unknown>) => opView("revise", null, { kind: "draft.change", what: "改稿·第 4 章", chapter: 4, ...overrides });
    const preview = { round: 2, changes: [{ from: "旧句。", to: "新句。" }, { from: 3 }], failed: [{ target: "那句", why: "稿里找不到" }], brief: "压一压语气" };
    const { views } = await collectOperations([
      frame("operation", { type: "record", operation: editView({
        result: { schema: "operation-result/1", summary: "改好了", body: { kind: "draft.change", mode: "fix", ok: true, chapter: 4, snapshotId: "s-1", changes: [{ from: "旧。", to: "新。" }, "坏的"], failed: [] } },
      }) }),
      frame("operation", { type: "record", operation: editView({ state: "waiting_author", result: undefined, pendingActions: [
        { actionId: "confirm:1", kind: "draft.revise.confirm", decisions: ["apply", "again"], preview: { round: 1, changes: [{ from: "a", to: "b" }], failed: [] }, decided: true },
        { actionId: "other", kind: "something.else", decisions: ["x"], preview: {}, decided: false },
        { actionId: "confirm:2", kind: "draft.revise.confirm", decisions: ["apply", "again", 7], preview, decided: false },
      ] }) }),
      frame("operation", { type: "record", operation: editView({ state: "running", result: undefined, pendingActions: [{ actionId: "confirm:3", kind: "draft.revise.confirm", decisions: ["apply"], preview, decided: false }] }) }),
    ]);
    expect(views[0]?.draft).toEqual({ chapter: 4, applied: true, snapshots: ["s-1"], changes: [{ from: "旧。", to: "新。" }] });
    expect(views[1]?.pending).toEqual({
      actionId: "confirm:2",
      decisions: ["apply", "again"],
      revise: { round: 2, changes: [{ from: "旧句。", to: "新句。" }], failed: [{ target: "那句", why: "稿里找不到" }], brief: "压一压语气" },
    });
    // 不在等作者的不带（停着等作者才有按钮）。
    expect(views[2]?.pending).toBeUndefined();
  });

  it("改稿按钮、等作者点的「接着做」防御解析（和服务端同一口径）：章号、原文、决定不对的不认", () => {
    const stamp = { requestKey: "rk-1", issuedAt: "2026-10-30T00:00:00.000Z" };
    expect(readStoredOperationAction({ kind: "new", type: "draft.change", mode: "fix", params: { chapter: 4, fixes: [{ targetText: "旧。", revisionGoal: "对上前文" }] }, ...stamp }))
      .toEqual({ kind: "new", type: "draft.change", mode: "fix", params: { mode: "fix", chapter: 4, fixes: [{ targetText: "旧。", revisionGoal: "对上前文" }] }, ...stamp });
    expect(readStoredOperationAction({ kind: "new", type: "draft.change", mode: "revise", params: { chapter: 4, edits: [{ targetText: " 原样 ", revisionGoal: "润色" }], preview: true, style: "deai" }, ...stamp }))
      .toMatchObject({ mode: "revise", params: { edits: [{ targetText: " 原样 ", revisionGoal: "润色" }], preview: true, style: "deai" } });
    expect(readStoredOperationAction({ kind: "new", type: "draft.change", mode: "deai", params: { chapter: 4, violations: [{ id: "v1", text: "那一刻。", severity: "high" }] }, ...stamp }))
      .toMatchObject({ mode: "deai", params: { violations: [{ id: "v1", text: "那一刻。", severity: "high" }] } });
    expect(readStoredOperationAction({ kind: "new", type: "draft.change", mode: "fix", params: { chapter: 4, fixes: [{ targetText: "旧。" }] }, ...stamp })).toBeUndefined();
    expect(readStoredOperationAction({ kind: "new", type: "draft.change", mode: "revise", params: { chapter: 0, edits: [{ targetText: "a" }] }, ...stamp })).toBeUndefined();
    expect(readStoredOperationAction({ kind: "new", type: "draft.change", mode: "deai", params: { chapter: 4, violations: [] }, ...stamp })).toBeUndefined();
    expect(readStoredOperationAction({ kind: "resume", opId: OP_ID, answer: { actionId: "confirm:1", decision: "apply" } }))
      .toEqual({ kind: "resume", opId: OP_ID, answer: { actionId: "confirm:1", decision: "apply" } });
    expect(readStoredOperationAction({ kind: "resume", opId: OP_ID, answer: { actionId: "confirm 1", decision: "apply" } })).toBeUndefined();
    expect(readStoredOperationAction({ kind: "resume", opId: OP_ID, answer: "apply" })).toBeUndefined();
  });

  it("步骤、正文流（live）→ onOperationLive；进度不进这里，形状不对的不认", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([
      frame("operation", { type: "live", opId: OP_ID, event: { type: "step", step: "write:0", exec: "1:write:0" } }),
      frame("operation", { type: "live", opId: OP_ID, event: { type: "draft-delta", exec: "1:write:0", streamSeq: 1, text: "雨下了", replace: true, base: false } }),
      frame("operation", { type: "live", opId: OP_ID, event: { type: "draft-delta", exec: "1:write:0", streamSeq: "2", text: "号不是数" } }),
      frame("operation", { type: "live", opId: OP_ID, event: { type: "progress", text: "在写" } }),
      frame("done", {}),
    ])));
    const live: unknown[] = [];
    await streamAgentChat(
      { projectPath: "/tmp/p", messages: [{ role: "user", content: "写" }] },
      {
        onTextDelta: () => undefined, onToolCall: () => undefined, onToolResult: () => undefined, onToolError: () => undefined,
        onError: () => undefined, onDone: () => undefined,
        onOperationLive: (item) => { live.push(item); },
      },
    );
    expect(live).toEqual([
      { opId: OP_ID, event: { type: "step", step: "write:0", exec: "1:write:0" } },
      { opId: OP_ID, event: { type: "draft-delta", exec: "1:write:0", streamSeq: 1, text: "雨下了", replace: true } },
    ]);
  });

  it("change_draft 有稿时的按钮（rewriteChoices）防御解析：动作不对的那个丢掉；别的工具不认", async () => {
    const action = { kind: "new", type: "draft.change", mode: "write", params: { chapter: 3, rewrite: true }, requestKey: "rk-1", issuedAt: "2026-10-29T00:00:00.000Z" };
    vi.stubGlobal("fetch", vi.fn(async () => sseResponse([
      frame("tool-result", { toolCallId: "c1", toolName: "change_draft", output: { ok: false, code: "chapter_has_text", chapter: 3, rewriteChoices: [
        { label: "重写第 3 章", intent: "重写", action },
        { label: "坏的", intent: "x", action: { kind: "new", type: "draft.change", mode: "write", params: {} } },
      ] } }),
      frame("tool-result", { toolCallId: "r1", toolName: "revise_draft", output: { ok: false, rewriteChoices: [{ label: "重写第 3 章", intent: "重写", action }] } }),
      frame("done", {}),
    ])));
    const received: { rewriteChoices?: unknown }[] = [];
    await streamAgentChat(
      { projectPath: "/tmp/p", messages: [{ role: "user", content: "写第 3 章" }] },
      {
        onTextDelta: () => undefined, onToolCall: () => undefined, onToolResult: (info) => { received.push(info); }, onToolError: () => undefined,
        onError: () => undefined, onDone: () => undefined,
      },
    );
    expect(received[0]?.rewriteChoices).toEqual([{ label: "重写第 3 章", mode: "write", action }]);
    expect(received[1]?.rewriteChoices).toBeUndefined();
  });

  it("进度（live）→ onOperationProgress；形状不对的不认", async () => {
    const { progress } = await collectOperations([
      frame("operation", { type: "live", opId: OP_ID, event: { type: "progress", text: "核账员在读第 3 章" } }),
      frame("operation", { type: "live", opId: OP_ID, event: { type: "progress" } }),
      frame("operation", { type: "live", event: { type: "progress", text: "没有号" } }),
    ]);
    expect(progress).toEqual([{ opId: OP_ID, text: "核账员在读第 3 章" }]);
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
      missed: [],
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
              { label: "再细核一遍", intent: "再细核一遍：这一章重新对一遍前文", action: { kind: "new", type: "inspect.run", mode: "continuity", params: { chapter: 5, fresh: true }, requestKey: "rk-1", issuedAt: "2026-10-29T00:00:00.000Z" } },
              // 操作按钮缺了请求号 / 交的时间：不透传（服务端也拒）。
              { label: "缺请求号", intent: "w", action: { kind: "new", type: "inspect.run", mode: "quality", params: { chapter: 5 } } },
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

    const prompt = received?.nextStepPrompt as { question: string; choices: { label: string; action?: Record<string, unknown> }[] };
    expect(prompt.question).toBe("核账做完了，接下来？");
    expect(prompt.choices[0]).toMatchObject({ label: "预览定稿", action: { toolName: "commit_preview" } });
    expect(prompt.choices[1]).toMatchObject({ label: "再细核一遍", action: { kind: "new", mode: "continuity", params: { chapter: 5, fresh: true }, requestKey: "rk-1" } });
    for (const index of [2, 3, 4, 5, 6]) expect(prompt.choices[index]).not.toHaveProperty("action");
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

  it("改账 / 改设定 / 认下按钮带的依据摘要原样透传（作者点按钮时服务端拿它核）", async () => {
    const basis = "a".repeat(64);
    const from = "b".repeat(64);
    vi.stubGlobal("fetch", vi.fn(async () =>
      sseResponse([
        frame("tool-result", {
          toolCallId: "l1",
          toolName: "manage_ledger",
          output: { ok: false, needsConfirmation: true, ledgerConfirm: { key: "ledger:x", decisions: [{ type: "fact.retract", fact: "f1" }], basis }, summary: "…" },
        }),
        frame("tool-result", {
          toolCallId: "f1",
          toolName: "foundation_write",
          output: { ok: true, needsConfirmation: true, foundationConfirm: { key: "card-1", input: { ops: [] }, label: "改", basis, basisFrom: from }, summary: "…" },
        }),
        frame("done", {}),
      ]),
    ));
    const received: { ledgerConfirmAction?: unknown; foundationConfirmAction?: unknown }[] = [];
    await streamAgentChat(
      { projectPath: "/tmp/p", messages: [{ role: "user", content: "改" }] },
      { ...noopHandlers(), onToolResult: (info) => { received.push(info); } },
    );
    expect(received[0]?.ledgerConfirmAction).toMatchObject({ key: "ledger:x", basis });
    expect(received[1]?.foundationConfirmAction).toMatchObject({ key: "card-1", basis, basisFrom: from });
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
