import { describe, expect, it } from "vitest";
import { sanitizeChapterChatWriteStatusForDisplay } from "./chapter-chat.js";

describe("sanitizeChapterChatWriteStatusForDisplay", () => {
  it("replaces premature foundation write success copy with pending no-write copy", () => {
    const result = sanitizeChapterChatWriteStatusForDisplay({
      reply: "好的，主角名字从林澈改为沈岚，我帮你更新角色资料。",
      intent: "edit_foundation",
      requiresConfirmation: true,
      decision: {
        agentId: "foundationAgent",
        action: "edit_foundation",
        target: "story/character-bible.json",
        confidence: 0.92,
        reason: "用户要求修改角色资料。",
      },
      writeInstructions: [],
    });

    expect(result.reply).toContain("当前未写入任何文件");
    expect(result.reply).toContain("需要先生成可确认的资料修改预览");
    expect(result.reply).not.toContain("我帮你更新");
    expect(result.reply).not.toContain("改为沈岚");
  });

  it("replaces premature foundation delete success copy with no-write copy", () => {
    const result = sanitizeChapterChatWriteStatusForDisplay({
      reply: "我已准备删除这个占位角色。",
      intent: "discuss",
      requiresConfirmation: false,
      decision: {
        agentId: "foundationAgent",
        action: "edit_foundation",
        target: "story/character-bible.json",
        confidence: 0.88,
        reason: "用户要求删除角色资料。",
      },
      writeInstructions: [],
    });

    expect(result.reply).toContain("当前未写入任何文件");
    expect(result.reply).not.toContain("已准备删除");
  });

  it("guards discuss replies when the router decision points at a writable story data target", () => {
    const result = sanitizeChapterChatWriteStatusForDisplay({
      reply: "收到，主角已改为沈澜。",
      intent: "discuss",
      requiresConfirmation: false,
      decision: {
        agentId: "foundationAgent",
        action: "edit_foundation",
        target: "characters/lin-che/profile.json",
        confidence: 0.72,
        reason: "用户在要求改角色名字。",
      },
      writeInstructions: [],
    });

    expect(result.reply).toContain("当前未写入任何文件");
    expect(result.reply).toContain("资料修改预览");
    expect(result.reply).not.toContain("已改");
  });

  it("does not treat ordinary character discussion router decisions as writable targets", () => {
    const result = sanitizeChapterChatWriteStatusForDisplay({
      reply: "我对 character motivation 的理解已更新：他更害怕失去控制。",
      intent: "discuss",
      requiresConfirmation: false,
      decision: {
        agentId: "chapterAgent",
        action: "discuss_character_motivation",
        target: "character motivation",
        confidence: 0.64,
        reason: "讨论角色动机，不是资料写入。",
      },
      writeInstructions: [],
    });

    expect(result.reply).toBe("我对 character motivation 的理解已更新：他更害怕失去控制。");
  });

  it("does not claim writing rules were saved when no executable write instruction exists", () => {
    const result = sanitizeChapterChatWriteStatusForDisplay({
      reply: "写作规则已保存。",
      intent: "write_writing_rules",
      requiresConfirmation: true,
      decision: {
        agentId: "foundationAgent",
        action: "write_writing_rules",
        target: "story/writing-rules.json",
        confidence: 0.86,
        reason: "用户要求保存规则。",
      },
      writeInstructions: [],
    });

    expect(result.reply).toContain("模型没有给出可执行写入指令");
    expect(result.reply).toContain("当前未写入任何文件");
    expect(result.reply).not.toContain("已保存");
  });

  it("allows executable writing-rule instructions to move into direct execution copy", () => {
    const result = sanitizeChapterChatWriteStatusForDisplay({
      reply: "已理解，写作规则改为第一人称视角，马上写入。",
      intent: "write_writing_rules",
      requiresConfirmation: false,
      decision: {
        agentId: "chapterOrchestrator",
        action: "write_writing_rules",
        target: "story/writing-rules.json",
        confidence: 0.95,
        reason: "用户要求修改写作规则。",
      },
      writeInstructions: [{
        target: "story/writing-rules.json",
        mode: "merge_object",
      }],
    });

    expect(result.reply).toContain("已生成可执行的资料修改指令");
    expect(result.reply).toContain("直接修改当前书籍资料");
    expect(result.reply).toContain("撤销入口");
    expect(result.reply).not.toContain("马上写入");
  });

  it("does not claim formal commit apply succeeded from chapter chat", () => {
    const result = sanitizeChapterChatWriteStatusForDisplay({
      reply: "已正式入库。",
      intent: "commit_apply",
      requiresConfirmation: true,
      decision: {
        agentId: "commitAgent",
        action: "commit_apply",
        target: "formal story state",
        confidence: 0.9,
        reason: "用户要求入库。",
      },
      writeInstructions: [],
    });

    expect(result.reply).toContain("本轮对话尚未写入文件");
    expect(result.reply).toContain("自动创建快照");
    expect(result.reply).not.toContain("已正式入库");
  });

  it("keeps commit apply replies without premature success claims unchanged even when the model flags confirmation", () => {
    const result = sanitizeChapterChatWriteStatusForDisplay({
      reply: "好的，我会执行正式入库，写入前自动创建快照。",
      intent: "commit_apply",
      requiresConfirmation: true,
      decision: {
        agentId: "commitAgent",
        action: "commit_apply",
        target: "formal story state",
        confidence: 0.9,
        reason: "用户要求入库。",
      },
      writeInstructions: [],
    });

    expect(result.reply).toBe("好的，我会执行正式入库，写入前自动创建快照。");
  });

  it("keeps ordinary discussion replies unchanged", () => {
    const result = sanitizeChapterChatWriteStatusForDisplay({
      reply: "这一章可以让主角先发现线索，再保留一个悬念。",
      intent: "discuss",
      requiresConfirmation: false,
      decision: {
        agentId: "chapterAgent",
        action: "discuss",
        target: "chapter plan",
        confidence: 0.6,
        reason: "普通讨论。",
      },
      writeInstructions: [],
    });

    expect(result.reply).toBe("这一章可以让主角先发现线索，再保留一个悬念。");
  });
});
