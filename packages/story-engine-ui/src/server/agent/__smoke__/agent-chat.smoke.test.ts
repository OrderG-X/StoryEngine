// @vitest-environment node
//
// 阶段1 server smoke：直接驱动写作 agent（不经 HTTP），验证两件事真的发生：
//   1) 问「现在什么状态」→ agent 调 read_state_overview。
//   2) 「把『主角左手有疤』记进人物卡」→ agent 调 foundation_write + 真写进设定卡（ledger/cards.json）+ 建快照。
// 同时打印 agent.stream() 的流式事件结构，作为 SSE 路由设计依据（API 实测）。
//
// 需真实网络 + 真实 GLM key，默认 skip；手动跑：
//   RUN_GLM_SMOKE=1 pnpm --filter @actalk/story-engine-ui exec vitest run agent-chat.smoke
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCards } from "@actalk/story-core";

import { createStoryProject } from "../../book/project-store.js";
import type { ModelMessage } from "ai";
import { describe, it, expect, afterAll } from "vitest";

import { getStoryAgent } from "../story-agent.js";
import { buildProjectRequestContext } from "../request-context.js";
import { listSnapshots } from "../../lib/snapshot.js";

const ENABLED = process.env.RUN_GLM_SMOKE === "1";

interface DrainResult {
  readonly events: { readonly type: string; readonly payload?: unknown }[];
  readonly toolCalls: string[];
  readonly toolResults: { readonly toolName: string; readonly output: unknown }[];
  readonly text: string;
  readonly errors: string[];
}

async function drainStream(stream: AsyncIterable<{ type: string; payload?: any }>): Promise<DrainResult> {
  const events: { type: string; payload?: unknown }[] = [];
  const toolCalls: string[] = [];
  const toolResults: { toolName: string; output: unknown }[] = [];
  const errors: string[] = [];
  let text = "";
  for await (const chunk of stream) {
    events.push({ type: chunk.type });
    if (chunk.type === "text-delta") text += chunk.payload?.text ?? "";
    if (chunk.type === "tool-call") toolCalls.push(chunk.payload?.toolName);
    if (chunk.type === "tool-result") {
      toolResults.push({ toolName: chunk.payload?.toolName, output: chunk.payload?.result });
    }
    if (chunk.type === "tool-error" || chunk.type === "error") {
      errors.push(JSON.stringify(chunk.payload?.error ?? chunk.payload));
    }
  }
  return { events, toolCalls, toolResults, text, errors };
}

describe.skipIf(!ENABLED)("写作 agent server smoke（真实 GLM）", () => {
  let rootDir: string | undefined;

  afterAll(async () => {
    if (rootDir) await rm(rootDir, { recursive: true, force: true });
  });

  it("两轮对话：读状态 + 把事实落盘到角色卡，并建快照", async () => {
    rootDir = await mkdtemp(join(tmpdir(), "agent-smoke-"));
    const { projectDir } = await createStoryProject({
      rootDir,
      title: "Smoke Demo",
      genre: "通用",
      logline: "一个用于冒烟测试的最小项目。",
      protagonistName: "Lin Wan",
    });

    const agent = await getStoryAgent();
    const requestContext = buildProjectRequestContext(projectDir);

    // ---- 第 1 轮：现在什么状态 → 期望调 read_state_overview ----
    const messages1: ModelMessage[] = [
      { role: "user", content: "现在这个故事写到什么程度了？有哪些角色？" },
    ];
    const stream1 = await agent.stream(messages1, { requestContext });
    const r1 = await drainStream(stream1.fullStream as AsyncIterable<{ type: string; payload?: any }>);
    // eslint-disable-next-line no-console
    console.log("[smoke] round1 event types =", r1.events.map((e) => e.type).join(","));
    // eslint-disable-next-line no-console
    console.log("[smoke] round1 toolCalls =", r1.toolCalls);
    // eslint-disable-next-line no-console
    console.log("[smoke] round1 first tool-result output keys =",
      r1.toolResults[0] ? Object.keys(r1.toolResults[0].output as Record<string, unknown>) : "none");
    // eslint-disable-next-line no-console
    console.log("[smoke] round1 text =", r1.text.slice(0, 200));

    expect(r1.errors).toEqual([]);
    expect(r1.toolCalls).toContain("read_state_overview");

    // ---- 第 2 轮：把「主角左手有疤」记进人物卡 → 期望调 foundation_write + 真写入 ----
    // 重构 P9：设定卡按名字认，对话里只说名字（不再有角色 id）。
    const messages2: ModelMessage[] = [
      {
        role: "user",
        content: "把这条记进主角 Lin Wan 的人物卡：他左手有一道明显的疤痕。",
      },
    ];
    const stream2 = await agent.stream(messages2, { requestContext });
    const r2 = await drainStream(stream2.fullStream as AsyncIterable<{ type: string; payload?: any }>);
    // eslint-disable-next-line no-console
    console.log("[smoke] round2 toolCalls =", r2.toolCalls);
    // eslint-disable-next-line no-console
    console.log("[smoke] round2 archive output =",
      JSON.stringify(r2.toolResults.find((t) => t.toolName === "foundation_write")?.output, null, 2)?.slice(0, 800));
    // eslint-disable-next-line no-console
    console.log("[smoke] round2 errors =", r2.errors);

    expect(r2.errors).toEqual([]);
    expect(r2.toolCalls).toContain("foundation_write");

    // foundation_write 真改了：output 含 snapshotId + refreshScope:"foundation"
    const archiveOut = r2.toolResults.find((t) => t.toolName === "foundation_write")?.output as
      | { snapshotId?: string; refreshScope?: string; applied?: string[] }
      | undefined;
    expect(archiveOut?.refreshScope).toBe("foundation");
    expect(typeof archiveOut?.snapshotId).toBe("string");

    // 真写进设定卡：主角卡上某一栏读得回疤痕（疤/左手 任一命中即算）。
    const cards = await readCards(projectDir);
    const protagonist = cards?.cards.find((card) => card.protagonist);
    expect(protagonist?.name).toBe("Lin Wan");
    expect(protagonist?.fields.map((field) => `${field.label}：${field.value}`).join("\n")).toMatch(/疤|左手/u);

    // 快照已建：改设定前的存档点在操作历史里。
    const snapshots = await listSnapshots(projectDir);
    // eslint-disable-next-line no-console
    console.log("[smoke] snapshots =", snapshots.map((s) => s.label));
    expect(snapshots.some((s) => s.id === archiveOut?.snapshotId)).toBe(true);
  }, 180_000);
});
