import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import WritingPaper from "./WritingPaper.js";
import { SentenceFocus } from "./sentenceFocusPlugin.js";
import { draftTextToHtml } from "./draftEditorSync.js";
import type { DraftPreview } from "../../types.js";

// 注：textarea→Tiptap 后，外部内容同步 / 保留本地脏编辑这两条核心逻辑改由 draftEditorSync.test.ts 纯测覆盖
// （ProseMirror 在 jsdom 下整渲染与真实输入不稳）；这里只做渲染契约的冒烟。真实打字/选区交 Codex 真机验。

const baseDraft: DraftPreview = {
  chapterNumber: 1,
  title: "第一章 · 测试",
  status: "draft",
  content: "# 第一章 · 测试\n\n这是一段测试正文。",
  wordCount: 8,
};

afterEach(() => cleanup());

function proseMirrorEl(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(".ProseMirror");
}

describe("WritingPaper", () => {
  it("renders read-only content when no onEdit", () => {
    render(<WritingPaper draft={baseDraft} />);
    expect(screen.getByRole("heading", { name: "第一章 · 测试" })).toBeDefined();
    expect(screen.getByText("这是一段测试正文。")).toBeDefined();
  });

  it("renders empty state when no content", () => {
    render(<WritingPaper draft={{ ...baseDraft, content: "" }} />);
    expect(screen.getByText("当前章节还没有工作稿")).toBeDefined();
    expect(screen.getByText("你可以在右侧让 AI 生成工作稿。")).toBeDefined();
  });

  it("renders a real (Tiptap) editor — not a textarea — when onEdit is provided", () => {
    const { container } = render(<WritingPaper draft={baseDraft} onEdit={vi.fn()} />);
    expect(container.querySelectorAll("textarea").length).toBe(0);
    const editor = proseMirrorEl(container);
    expect(editor).not.toBeNull();
    expect(editor?.getAttribute("contenteditable")).toBe("true");
    expect(editor?.textContent).toContain("这是一段测试正文。");
  });

  it("shows the empty-editor hint when an editable draft has no content", () => {
    render(<WritingPaper draft={{ ...baseDraft, content: "" }} onEdit={vi.fn()} />);
    expect(
      screen.getByText("当前章节还没有工作稿。你可以在这里手动输入，也可以在右侧让 AI 生成工作稿。"),
    ).toBeDefined();
  });

  it("renders no editable host when onEdit is absent", () => {
    const { container } = render(<WritingPaper draft={baseDraft} />);
    expect(container.querySelectorAll("textarea").length).toBe(0);
    expect(proseMirrorEl(container)).toBeNull();
  });

  it("locks the editor (non-editable) and shows a notice when the chapter is committed", () => {
    const { container } = render(<WritingPaper draft={{ ...baseDraft, status: "committed" }} onEdit={vi.fn()} />);
    expect(proseMirrorEl(container)?.getAttribute("contenteditable")).toBe("false");
    expect(screen.getByText("本章已定稿，内容以定稿版为准。如需修改请通过 AI 助手发起修改。")).toBeDefined();
  });

  it("keeps the editor editable and hides the committed notice for plain drafts", () => {
    const { container } = render(<WritingPaper draft={baseDraft} onEdit={vi.fn()} />);
    expect(proseMirrorEl(container)?.getAttribute("contenteditable")).toBe("true");
    expect(screen.queryByText("本章已定稿，内容以定稿版为准。如需修改请通过 AI 助手发起修改。")).toBeNull();
  });

  it("reflects external draft content into the editor when the user has not edited", () => {
    const { container, rerender } = render(<WritingPaper draft={baseDraft} onEdit={vi.fn()} />);
    rerender(<WritingPaper draft={{ ...baseDraft, content: "# 第二稿\n\nAI 生成的新正文。" }} onEdit={vi.fn()} />);
    expect(proseMirrorEl(container)?.textContent).toContain("AI 生成的新正文。");
  });

  it("keeps syncing an AI stream even when token boundaries carry whitespace (no freeze)", () => {
    // 回归（审查抓到的 critical）：ProseMirror 裁段落首尾空白，基准必须取编辑器回读值，
    // 否则某个 delta 以空格结尾后，之后每个 delta 都被误判成本地脏编辑、编辑器冻结。
    const deltas = ["他说道", "：", " ", "你好。", "再见。"]; // 第 3 个 delta 让累积值以空格结尾
    let accumulated = "";
    const { container, rerender } = render(<WritingPaper draft={{ ...baseDraft, content: "" }} onEdit={vi.fn()} />);
    for (const delta of deltas) {
      accumulated += delta;
      rerender(<WritingPaper draft={{ ...baseDraft, content: accumulated }} onEdit={vi.fn()} />);
    }
    const text = proseMirrorEl(container)?.textContent ?? "";
    expect(text).toContain("你好。");
    expect(text).toContain("再见。"); // 修复前会冻结在「他说道：」，这里取不到
  });

  it("聚焦模式下渲染不崩、host 与编辑器存在", () => {
    // 句级聚焦（Task 3）冒烟：带两句中文正文挂载可编辑纸面，断言不抛错、编辑器与 host 在 DOM。
    // 真实"当前句变亮/其余淡"交真机；jsdom 下 ProseMirror 渲染不稳，这里只验不崩。
    const { container } = render(
      <WritingPaper draft={{ ...baseDraft, content: "他来了。她走了。" }} onEdit={vi.fn()} />,
    );
    expect(container.querySelector(".se-v2-draft-editor-host")).not.toBeNull();
    expect(proseMirrorEl(container)).not.toBeNull();
  });

  it("装上句级聚焦扩展，注册装饰插件不抛错", () => {
    // 驱动 Task 3：句级聚焦扩展可独立挂到 Tiptap、产出 ProseMirror 插件而不崩。
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: [
        StarterKit.configure({
          heading: false,
          bulletList: false,
          orderedList: false,
          blockquote: false,
          codeBlock: false,
          horizontalRule: false,
          bold: false,
          italic: false,
          strike: false,
          code: false,
        }),
        SentenceFocus,
      ],
      content: draftTextToHtml("他来了。她走了。"),
    });
    expect(editor.state.doc.textContent).toContain("她走了");
    editor.destroy();
  });

  it("extracts selection text with the same serialization as draft.content even across a hardBreak", () => {
    // 回归（审查抓到的 critical）：选区用 textBetween(...,"\n") 必须与 draft.content 的 getText 一致，
    // 否则段内单换行(<br>) 在两边序列化不同（" " vs "\n"），revision 路由 includes 匹配失败 → 400。
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: [StarterKit.configure({
        heading: false,
        bulletList: false,
        orderedList: false,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
        bold: false,
        italic: false,
        strike: false,
        code: false,
      })],
      content: draftTextToHtml("第一行\n第二行\n\n第二段。"), // 段内单换行 → hardBreak
    });
    const draftContent = editor.getText({ blockSeparator: "\n\n" });
    const selectionText = editor.state.doc.textBetween(0, editor.state.doc.content.size, "\n\n", "\n");
    // 选区文本必须与 draft.content 完全一致（全选时）→ 是 draft.content 的子串 → 路由能定位
    expect(selectionText).toBe(draftContent);
    expect(draftContent.includes(selectionText)).toBe(true);
    editor.destroy();
  });
});
