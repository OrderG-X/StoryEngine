import { describe, expect, it } from "vitest";
import { formatMessageBlocks, getPlaceholder, workflowErrorTitle } from "./chatRenderShared.js";

describe("chatRenderShared", () => {
  describe("formatMessageBlocks", () => {
    it("把纯文本切成块", () => {
      const blocks = formatMessageBlocks("第一段\n\n第二段");
      expect(blocks.length).toBeGreaterThanOrEqual(1);
    });

    it("把列表行聚合成 list 块", () => {
      const blocks = formatMessageBlocks("- 第一项\n- 第二项\n- 第三项");
      expect(blocks).toHaveLength(1);
      expect(blocks[0].kind).toBe("list");
      if (blocks[0].kind === "list") {
        expect(blocks[0].items).toHaveLength(3);
        expect(blocks[0].items[0]).toBe("第一项");
      }
    });

    it("把 markdown 表格解析成 table 块", () => {
      const input = "| 姓名 | 年龄 |\n|------|------|\n| 林澈 | 28   |";
      const blocks = formatMessageBlocks(input);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].kind).toBe("table");
      if (blocks[0].kind === "table") {
        expect(blocks[0].headers).toContain("姓名");
        expect(blocks[0].rows).toHaveLength(1);
      }
    });

    it("单行表格（无分隔行）退化成段落", () => {
      const blocks = formatMessageBlocks("| 姓名 | 年龄 |");
      expect(blocks).toHaveLength(1);
      expect(blocks[0].kind).toBe("paragraph");
    });

    it("纯空白字符串（trim 后为空）返回至多 1 个块（uiText 替换空串为占位符）", () => {
      // uiText("") 返回 "尚未设定" 占位，所以不期待空数组
      const blocks = formatMessageBlocks("   ");
      // 非空内容（来自 uiText fallback）会产生 1 个段落块
      expect(blocks.length).toBe(1);
    });

    it("混合段落与列表", () => {
      const blocks = formatMessageBlocks("介绍\n- 第一项\n- 第二项\n结语");
      expect(blocks.length).toBeGreaterThanOrEqual(3);
      const kinds = blocks.map((b) => b.kind);
      expect(kinds).toContain("paragraph");
      expect(kinds).toContain("list");
    });

    // 马拉松实测：模型方案文本里的 markdown 分隔线 `---` 被列表剥离剩「--」，渲染成假列表项。
    it("markdown 分隔线（--- / --）按块边界跳过，不渲染成「--」假列表项", () => {
      const blocks = formatMessageBlocks("方案甲说明\n---\n方案乙说明\n--\n结尾");
      expect(blocks.every((block) => block.kind === "paragraph")).toBe(true);
      const texts = blocks.map((block) => (block.kind === "paragraph" ? block.text : ""));
      expect(texts).toEqual(["方案甲说明", "方案乙说明", "结尾"]);
    });

    it("分隔线夹在列表中间 → 按边界切成两个 list 块，项内容不混入分隔符", () => {
      const blocks = formatMessageBlocks("- 甲\n- 乙\n---\n- 丙");
      expect(blocks.every((block) => block.kind === "list")).toBe(true);
      expect(blocks).toHaveLength(2);
      const items = blocks.flatMap((block) => (block.kind === "list" ? [...block.items] : []));
      expect(items).toEqual(["甲", "乙", "丙"]);
    });

    it("孤立的「-」空列表行剥完为空 → 丢弃，不产生空列表项", () => {
      const blocks = formatMessageBlocks("- 第一项\n-\n- 第二项");
      const items = blocks.flatMap((block) => (block.kind === "list" ? [...block.items] : []));
      expect(items).toEqual(["第一项", "第二项"]);
    });

    it("孤立的「1.」序号行保留为段落，不吞内容（评审加固）", () => {
      const blocks = formatMessageBlocks("说明\n1.\n结尾");
      const texts = blocks.map((block) => (block.kind === "paragraph" ? block.text : "")).filter(Boolean);
      expect(texts).toContain("1.");
    });
  });

  describe("getPlaceholder", () => {
    it("返回非空提示", () => {
      expect(getPlaceholder("idle").length).toBeGreaterThan(0);
    });

    it("idle 状态返回正确提示", () => {
      expect(getPlaceholder("idle")).toBe("说说这章想写什么…");
    });

    it("draft_ready 状态返回提示", () => {
      expect(getPlaceholder("draft_ready").length).toBeGreaterThan(0);
    });

    it("committed 状态返回提示", () => {
      expect(getPlaceholder("committed").length).toBeGreaterThan(0);
    });

    it("未知状态返回默认提示", () => {
      expect(getPlaceholder("unknown_state")).toBe("输入你的想法…");
    });

    it("开书阶段（isOpenBook）：placeholder 跟开书语气一致、不显示「这章」(rerun2 P2)", () => {
      const p = getPlaceholder("idle", true);
      expect(p).toContain("主角");
      expect(p).not.toContain("这章");
    });
  });

  describe("workflowErrorTitle", () => {
    it("返回非空标题", () => {
      expect(workflowErrorTitle("idle").length).toBeGreaterThan(0);
    });

    it("idle 状态返回正确标题", () => {
      expect(workflowErrorTitle("idle")).toBe("本章方案整理失败");
    });

    it("commit_preview_ready 状态返回正确标题", () => {
      expect(workflowErrorTitle("commit_preview_ready")).toBe("定稿失败");
    });

    it("draft_generating 状态返回正确标题", () => {
      expect(workflowErrorTitle("draft_generating")).toBe("工作稿处理失败");
    });

    it("quality_checked 状态返回正确标题", () => {
      expect(workflowErrorTitle("quality_checked")).toBe("硬伤检查失败");
    });
  });
});
