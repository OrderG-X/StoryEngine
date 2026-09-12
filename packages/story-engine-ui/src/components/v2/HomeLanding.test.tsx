import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useMotionStore } from "../../stores/motionStore.js";
import type { HomePageProps } from "../../types.js";
import HomeLanding from "./HomeLanding.js";

afterEach(() => {
  cleanup();
  // 还原降低动效，避免污染其它用例
  useMotionStore.getState().set(false);
});

describe("HomeLanding", () => {
  it("reduceMotion 开 → .se-v2-home 挂 is-reduced-motion 类；关 → 不挂", () => {
    useMotionStore.getState().set(true);
    const { container, rerender } = render(<HomeLanding {...homeProps()} />);
    expect(container.querySelector(".se-v2-home")?.className).toContain("is-reduced-motion");

    useMotionStore.getState().set(false);
    rerender(<HomeLanding {...homeProps()} />);
    expect(container.querySelector(".se-v2-home")?.className).not.toContain("is-reduced-motion");
  });

  it("renders the StoryEngine brand as non-interactive text instead of a fake button", () => {
    render(<HomeLanding {...homeProps()} />);

    expect(screen.getByLabelText("StoryEngine 品牌")).toHaveTextContent("StoryEngine");
    expect(screen.queryByRole("button", { name: /StoryEngine/u })).toBeNull();
  });

  it("删除弹窗 Esc 关闭（Radix 暗金弹窗收口）", () => {
    render(<HomeLanding {...homeProps({ recentBooks: [recentBook()] })} />);

    fireEvent.click(screen.getByRole("button", { name: "书籍管理" }));
    fireEvent.click(screen.getByRole("button", { name: "删除书籍" }));

    const dialog = screen.getByRole("dialog", { name: "确认删除书籍？" });
    expect(dialog).toBeInTheDocument();

    fireEvent.keyDown(dialog, { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "确认删除书籍？" })).toBeNull();
  });

  it("一步确认删除：弹窗里点「永久删除」直接删（去掉多余的「解锁→永久删除」两步卡）", () => {
    const onDeleteRecentBook = vi.fn(async () => "deleted");
    render(<HomeLanding {...homeProps({ recentBooks: [recentBook()], onDeleteRecentBook })} />);

    fireEvent.click(screen.getByRole("button", { name: "书籍管理" }));
    fireEvent.click(screen.getByRole("button", { name: "删除书籍" }));

    // 不再有「解锁删除」中间步；弹窗本身即确认，「永久删除」一键删。
    expect(screen.queryByRole("button", { name: "解锁删除" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    expect(onDeleteRecentBook).toHaveBeenCalledWith("book-1");
  });

  it("点菜单内动作后菜单关闭（不再常驻盖住「···」按钮，V6 回归根因）", () => {
    const onOpenRecentBook = vi.fn();
    render(<HomeLanding {...homeProps({ recentBooks: [recentBook()], onOpenRecentBook })} />);

    fireEvent.click(screen.getByRole("button", { name: "书籍管理" }));
    expect(screen.getByRole("button", { name: "继续写作" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "继续写作" }));
    // 菜单已关：继续写作项消失；动作仍触发。
    expect(screen.queryByRole("button", { name: "继续写作" })).toBeNull();
    expect(onOpenRecentBook).toHaveBeenCalledWith("book-1");
  });

  it("点菜单外部 → 菜单关闭（标准下拉收口）", () => {
    render(<HomeLanding {...homeProps({ recentBooks: [recentBook()] })} />);

    fireEvent.click(screen.getByRole("button", { name: "书籍管理" }));
    expect(screen.getByRole("button", { name: "重命名" })).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("button", { name: "重命名" })).toBeNull();
  });

  it("shows a clear empty state when there are no recent books", () => {
    render(<HomeLanding {...homeProps()} />);

    const recentSection = screen.getByRole("region", { name: "最近写作" });
    expect(recentSection).toHaveTextContent("还没有最近写作");
    expect(recentSection).toHaveTextContent("可以新建一本书，或打开已有项目");
  });

  it("书卡进度条 = 已写章数 / 当前章号（真实章数），不再写死 /12", () => {
    // 已写 30 / 当前第 40 章 → 75%；旧的 /12 会顶满 100%（长篇永远低估）。
    const book = { ...recentBook(), writtenChapters: 30, currentChapterNumber: 40 };
    const { container } = render(<HomeLanding {...homeProps({ recentBooks: [book] })} />);

    const recentBar = container.querySelector(".se-v2-recent-book i b");
    expect(recentBar).not.toBeNull();
    expect((recentBar as HTMLElement).style.width).toBe("75%");

    // 顶部「继续上次写作」卡同口径。
    const continueBar = container.querySelector(".se-v2-continue-card i b");
    expect(continueBar).not.toBeNull();
    expect((continueBar as HTMLElement).style.width).toBe("75%");
  });
});

function homeProps(overrides: Partial<HomePageProps> = {}): HomePageProps {
  return {
    recentBooks: [],
    onChooseFolder: vi.fn(),
    onCreateBook: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenProject: vi.fn(),
    onOpenRecentBook: vi.fn(),
    onRenameRecentBook: vi.fn(async () => "renamed"),
    onRemoveRecentBook: vi.fn(async () => "removed"),
    onDeleteRecentBook: vi.fn(async () => "deleted"),
    onOpenRecentBookFolder: vi.fn(async () => "opened"),
    ...overrides,
  };
}

function recentBook() {
  return {
    id: "book-1",
    title: "海州账册",
    genre: "都市",
    currentChapterTitle: "第一章",
    currentChapterNumber: 1,
    protagonistName: "林序",
    status: "草稿中" as const,
    updatedAt: "刚刚",
    logline: "审计故事",
    writtenChapters: 1,
    totalWords: 1200,
    projectPath: "/Users/example/story",
  };
}
