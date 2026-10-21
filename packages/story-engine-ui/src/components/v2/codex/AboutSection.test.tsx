import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AboutView } from "../../../api/aboutClient.js";
import { AboutSection } from "./AboutSection.js";

afterEach(cleanup);

function api(view: AboutView) {
  return { fetchAbout: vi.fn(async () => view), openAboutTarget: vi.fn(async (_what: string) => undefined) };
}

describe("设置 · 关于", () => {
  it("桌面包：显示版本，许可清单、日志、书库都能打开", async () => {
    const calls = api({ version: "0.3.0", hasNotices: true, hasLogs: true });
    render(<AboutSection api={calls} />);
    expect(await screen.findByText("StoryEngine 0.3.0")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "源代码" })).toHaveAttribute("href", "https://github.com/OrderG-X/StoryEngine");
    const [notices, logs, books] = screen.getAllByRole("button");
    fireEvent.click(notices!);
    fireEvent.click(logs!);
    fireEvent.click(books!);
    expect(calls.openAboutTarget.mock.calls.map((call: unknown[]) => call[0])).toEqual(["notices", "logs", "books"]);
  });

  it("开发版：没版本号、没许可清单和日志就灰掉；打不开如实说", async () => {
    const calls = api({ version: null, hasNotices: false, hasLogs: false });
    calls.openAboutTarget.mockRejectedValueOnce(new Error("没打开：出错了"));
    render(<AboutSection api={calls} />);
    expect(await screen.findByText("StoryEngine 开发版")).toBeInTheDocument();
    const [notices, logs, books] = screen.getAllByRole("button");
    expect(notices).toBeDisabled();
    expect(logs).toBeDisabled();
    fireEvent.click(books!);
    expect((await screen.findByRole("alert")).textContent).toContain("没打开");
  });
});
