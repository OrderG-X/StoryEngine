import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchModelSettings,
  saveModelSettings,
} from "./client.js";

describe("fetchModelSettings", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads model and provider settings from the global settings route", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      ok: true,
      result: {
        passed: true,
        available: true,
        status: "loaded",
        configPath: "/Users/example/.story-engine/model-settings.json",
        summary: {
          available: true,
          status: "loaded",
          configPath: "/Users/example/.story-engine/model-settings.json",
          defaultProvider: "main",
          providers: [{
            id: "main",
            label: "OpenAI Compatible",
            type: "openai-compatible",
            baseUrl: "https://api.example.com/v1",
            apiKeyStatus: "present",
          }],
          profiles: [{
            id: "balanced",
            label: "Balanced",
            provider: "main",
            model: "model-name",
            temperature: 0.7,
            maxTokens: 4096,
            timeoutMs: 60000,
            retries: 2,
            stream: true,
          }],
          taskProfiles: { fastDraft: "balanced" },
          issueCount: 0,
          highRiskIssueCount: 0,
        },
        issues: [],
      },
      rawText: "{\"version\":1}\n",
    }, 200));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchModelSettings();

    expect(fetchMock).toHaveBeenCalledWith("/api/model-settings", expect.any(Object));
    expect(result.result.summary.providers[0]?.id).toBe("main");
    expect(result.rawText).toBe("{\"version\":1}\n");
  });
});

describe("saveModelSettings warnings passthrough", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function okPayload(warnings?: readonly string[]) {
    return {
      ok: true,
      result: {
        passed: true,
        available: true,
        status: "loaded",
        configPath: "/Users/example/.story-engine/model-settings.json",
        summary: {
          available: true,
          status: "loaded",
          configPath: "/Users/example/.story-engine/model-settings.json",
          providers: [],
          profiles: [],
          taskProfiles: {},
          issueCount: 0,
          highRiskIssueCount: 0,
        },
        issues: [],
      },
      rawText: "{\"version\":1}\n",
      ...(warnings ? { warnings } : {}),
    };
  }

  it("透传 PUT 响应的 warnings（丢头警告必须能到达面板，绝不静默吞掉）", async () => {
    const warnings = ["1 个自定义请求头无法还原已丢弃（未保存）：main 的 x-brand-new。如需保留请重新填写明文值后保存。"];
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(okPayload(warnings), 200)));

    const result = await saveModelSettings("{\"version\":1}");

    expect(result.warnings).toEqual(warnings);
  });

  it("响应不带 warnings 字段时结果为 undefined（无丢弃不刷警告）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(okPayload(), 200)));

    const result = await saveModelSettings("{\"version\":1}");

    expect(result.warnings).toBeUndefined();
  });
});

function jsonResponse(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function abortableNeverResponse(init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!(signal instanceof AbortSignal)) return;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

