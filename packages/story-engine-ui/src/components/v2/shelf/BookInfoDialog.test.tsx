import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BookInfoView } from "../../../api/shelfClient.js";
import { BookInfoDialog } from "./BookInfoDialog.js";

afterEach(cleanup);

const BOOK = { title: "雾港来信", projectPath: "/b/fog" };
const VIEW: BookInfoView = {
  title: "雾港来信",
  info: { author: "林某", tags: ["悬疑"] },
  archived: false,
  stats: { totalWords: 23456, today: { net: 1200, author: 1000, ai: 200 }, streak: 4, recent: Array.from({ length: 30 }, (_, i) => ({ date: `d${i}`, net: i === 29 ? 1200 : 0 })) },
};

function api() {
  return {
    fetchBookInfo: vi.fn(async () => VIEW),
    saveBookInfo: vi.fn(async (_path: string, info: BookInfoView["info"]) => ({ title: "雾港来信", info, archived: false })),
  };
}

describe("书的资料弹窗", () => {
  it("读出资料和统计；改笔名、加标签（回车）、去标签、设日更和封面色后存", async () => {
    const calls = api();
    const onSaved = vi.fn();
    render(<BookInfoDialog api={calls} book={BOOK} onClose={() => {}} onSaved={onSaved} />);
    expect(await screen.findByDisplayValue("林某")).toBeInTheDocument();
    expect(screen.getByText("2.3 万字")).toBeInTheDocument();
    expect(screen.getByText("+1200")).toBeInTheDocument();
    expect(screen.getByText("今天 AI 写的")).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue("林某"), { target: { value: "林二" } });
    fireEvent.change(screen.getByLabelText("加标签"), { target: { value: "港口" } });
    fireEvent.keyDown(screen.getByLabelText("加标签"), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "去掉标签 悬疑" }));
    fireEvent.change(screen.getByPlaceholderText("比如 4000"), { target: { value: "4000" } });
    fireEvent.click(screen.getByRole("radio", { name: "封面色 3" }));
    fireEvent.click(screen.getByRole("button", { name: "存" }));

    expect(await screen.findByText("存好了。")).toBeInTheDocument();
    expect(calls.saveBookInfo).toHaveBeenCalledWith("/b/fog", { author: "林二", tags: ["港口"], dailyGoal: 4000, coverTone: 2 });
    expect(onSaved).toHaveBeenCalled();
  });

  it("字数填得不对不让存", async () => {
    render(<BookInfoDialog api={api()} book={BOOK} onClose={() => {}} />);
    await screen.findByDisplayValue("林某");
    fireEvent.change(screen.getByPlaceholderText("比如 300000"), { target: { value: "三十万" } });
    expect(screen.getByRole("alert").textContent).toContain("正整数");
    expect(screen.getByRole("button", { name: "存" })).toBeDisabled();
  });
});
