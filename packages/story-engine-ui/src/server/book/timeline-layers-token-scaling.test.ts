// @vitest-environment node
// followup-3：长篇 token 收敛测量 + 回归护栏。
// 关切：名额放宽 + L2/L3 全保留，180/300 章下 timeline 分层会不会随章数线性膨胀失控。
// 结论（见下断言）：L1 近3章定长、L2 固定窗口（约12章）定长、L3 每5章压一块（块数线性增长但每块截断到 ~200 字），
// 故 L3 总量 ≈ (章数/5) × 单块上限，是线性但每块有界；300 章绝对量仍远低于 token 预算。本测试锁住"单块有界 + 300章总量上限"。
import { describe, expect, it } from "vitest";
import { buildTimelineLayers } from "./timeline-layers.js";
import type { TimelineEvent } from "./types.js";

function synthEvents(n: number): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (let ch = 1; ch <= n; ch += 1) {
    events.push({
      id: `ch${String(ch).padStart(4, "0")}-001`,
      chapter: ch,
      summary: `第${ch}章发生了一些事，推动主线往前走，涉及若干角色与地点的互动与冲突。`,
      participants: ["c-1", "c-2"],
      effects: {
        semanticSummary: {
          chapter: ch,
          mainEvent: `第${ch}章主事件：主角在调查中又揭开一层与父亲旧案相关的线索，与对手的博弈升级，留下新的悬念待后续收口。`,
          timelineSummary: `第${ch}章时间线摘要：事态进一步发酵。`,
        },
      },
    });
  }
  return events;
}

// CJK 粗略按 1 token/字估（GLM 中文偏保守），英文标点忽略，足够看趋势与量级。
function approxTokens(value: unknown): number {
  return JSON.stringify(value).length;
}

describe("timeline 分层 token 随章数缩放（followup-3 长跑收敛）", () => {
  it("量级表：N=50/100/180/300 的 L1/L2/L3 条数与序列化体积", () => {
    const rows: string[] = [];
    for (const n of [50, 100, 180, 300]) {
      const layers = buildTimelineLayers(synthEvents(n), n);
      rows.push(
        `N=${String(n).padStart(3)} | L1条=${layers.l1.length} L2条=${layers.l2.length} L3块=${layers.l3.length} ` +
          `| L1字=${approxTokens(layers.l1)} L2字=${approxTokens(layers.l2)} L3字=${approxTokens(layers.l3)} ` +
          `| 合计字=${approxTokens(layers)}`,
      );
    }
    // eslint-disable-next-line no-console
    console.log("\n[timeline 分层缩放]\n" + rows.join("\n") + "\n");
    expect(rows.length).toBe(4);
  });

  it("L1 定长（与总章数无关，恒 ≈ l1Window=3）", () => {
    expect(buildTimelineLayers(synthEvents(50), 50).l1.length).toBe(3);
    expect(buildTimelineLayers(synthEvents(300), 300).l1.length).toBe(3);
  });

  it("L2 定长窗口（约 12 章，不随总章数膨胀）", () => {
    const l2at100 = buildTimelineLayers(synthEvents(100), 100).l2.length;
    const l2at300 = buildTimelineLayers(synthEvents(300), 300).l2.length;
    expect(l2at100).toBe(l2at300); // 固定窗口 (current-15, current-3]
    expect(l2at300).toBeLessThanOrEqual(15);
  });

  it("L3 每块有界：单块序列化 ≤ 600 字（mainEvent 拼接已截断），块数随章数线性但每块不膨胀", () => {
    const layers300 = buildTimelineLayers(synthEvents(300), 300);
    for (const block of layers300.l3) {
      expect(approxTokens(block)).toBeLessThanOrEqual(600);
    }
    // 块数 ≈ (300-15)/5 ≈ 57，线性但可控
    expect(layers300.l3.length).toBeLessThanOrEqual(60);
  });

  it("300 章整体分层序列化体积有上限（不失控）：< 60000 字（约几千 token，远低于 300k 预算）", () => {
    const total = approxTokens(buildTimelineLayers(synthEvents(300), 300));
    expect(total).toBeLessThan(60_000);
  });
});

describe("远期分层有上限（2026-10-10 引擎升级第 4 期）", () => {
  it("500 章：远期至多 12 块、整段不随章数涨；最早一章仍被覆盖、最近的远期保持 5 章一块", () => {
    const at300 = buildTimelineLayers(synthEvents(300), 300);
    const at500 = buildTimelineLayers(synthEvents(500), 500);
    expect(at500.l3.length).toBeLessThanOrEqual(12);
    expect(at500.l3[0]!.fromChapter).toBe(1);
    const last = at500.l3.at(-1)!;
    expect(last.toChapter - last.fromChapter).toBe(4);
    expect(JSON.stringify(at500.l3).length).toBeLessThanOrEqual(JSON.stringify(at300.l3).length * 1.1);
    for (const block of at500.l3) expect(block.summary.length).toBeLessThanOrEqual(200);
    // 块与块首尾相接、不重叠
    for (let i = 1; i < at500.l3.length; i += 1) expect(at500.l3[i]!.fromChapter).toBe(at500.l3[i - 1]!.toChapter + 1);
  });
});
