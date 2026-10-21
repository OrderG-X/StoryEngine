import { describe, expect, it } from "vitest";
import { buildOutboundConversation } from "./buildOutboundConversation.js";

const mk = (i: number, content: string) => ({ id: `m-${i}`, role: i % 2 === 0 ? "user" : "assistant", content } as const);

describe("buildOutboundConversation", () => {
  it("P11：界面塞的脚手架消息不发给 AI（不占历史条数）", () => {
    const out = buildOutboundConversation([
      { id: "s", role: "assistant", kind: "scaffolding", content: "已进入工作台" },
      { id: "u", role: "user", content: "主角叫林小满" },
      { id: "a", role: "assistant", content: "好的" },
    ], 0, 100000);
    expect(out).toEqual([{ role: "user", content: "主角叫林小满" }, { role: "assistant", content: "好的" }]);
  });

  it("排除已归档段(前 archivedCount 条不发给 AI)", () => {
    const msgs = [mk(0, "归档1"), mk(1, "归档2"), mk(2, "活跃1"), mk(3, "活跃2")];
    const out = buildOutboundConversation(msgs as any, 2, 96000);
    expect(out.map((m) => m.content)).toEqual(["活跃1", "活跃2"]);
  });

  it("活跃段超预算时从尾部保留最近的(界面数组不变)", () => {
    const msgs = Array.from({ length: 30 }, (_, i) => mk(i, "字".repeat(300)));
    const out = buildOutboundConversation(msgs as any, 0, 2000);
    expect(out.length).toBeLessThan(30);
    expect(out.at(-1)!.content).toBe(msgs.at(-1)!.content); // 保的是最近的
  });

  it("A2：assistant 回合有失败工具步骤 → 文本前加中性失败标注（防谎报回灌）", () => {
    const msgs = [
      { id: "m-0", role: "user", content: "写第8章" },
      {
        id: "m-1", role: "assistant", content: "第8章已生成、已入库。",
        toolSteps: [{ id: "t1", label: "生成正文", status: "failed", startedAt: 1 }],
      },
    ];
    const out = buildOutboundConversation(msgs as any, 0, 96000);
    expect(out[1]!.content).toContain("工具调用失败");
    expect(out[1]!.content).toContain("第8章已生成、已入库。"); // 原文保留、只加标注不删
  });

  it("A2：成功回合（无失败步骤）原样、不加标注；用户回合永不加标注", () => {
    const msgs = [
      { id: "m-0", role: "user", content: "第8章已入库了吧" }, // 用户即便这么说也不标注
      {
        id: "m-1", role: "assistant", content: "第8章已入库。",
        toolSteps: [{ id: "t1", label: "正式入库", status: "completed", startedAt: 1 }],
      },
    ];
    const out = buildOutboundConversation(msgs as any, 0, 96000);
    expect(out[0]!.content).toBe("第8章已入库了吧");
    expect(out[1]!.content).toBe("第8章已入库。");
  });
});
