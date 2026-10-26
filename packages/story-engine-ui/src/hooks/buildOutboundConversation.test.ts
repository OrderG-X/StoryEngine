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

  it("A2：调过工具的回合结构化带上工具名（去重）和成没成，文字原样不加注；没调工具的回合、用户回合不带", () => {
    const msgs = [
      { id: "m-0", role: "user", content: "预览第 14 章的定稿改动" },
      {
        id: "m-1", role: "assistant", content: "第 14 章可以定稿，清单打开了。",
        toolSteps: [
          { id: "t1", label: "定稿预览", toolName: "commit_preview", status: "verdict", startedAt: 1 },
          { id: "t2", label: "定稿预览", toolName: "commit_preview", status: "completed", startedAt: 2 },
        ],
      },
      { id: "m-2", role: "user", content: "写第8章" },
      {
        id: "m-3", role: "assistant", content: "第8章已生成、已入库。",
        toolSteps: [
          { id: "t3", label: "生成正文", toolName: "generate_draft", status: "failed", startedAt: 3 },
          { id: "t4", label: "下一步", toolName: "suggest_next_steps", status: "completed", startedAt: 4 },
        ],
      },
      { id: "m-4", role: "user", content: "第8章已入库了吧" },
      { id: "m-5", role: "assistant", content: "还没有。" },
    ];
    const out = buildOutboundConversation(msgs as any, 0, 96000);
    expect(out).toEqual([
      { role: "user", content: "预览第 14 章的定稿改动" },
      { role: "assistant", content: "第 14 章可以定稿，清单打开了。", tools: [{ name: "commit_preview", ok: true }] },
      { role: "user", content: "写第8章" },
      { role: "assistant", content: "第8章已生成、已入库。", tools: [{ name: "generate_draft", ok: false }, { name: "suggest_next_steps", ok: true }] },
      { role: "user", content: "第8章已入库了吧" },
      { role: "assistant", content: "还没有。" },
    ]);
  });
});
