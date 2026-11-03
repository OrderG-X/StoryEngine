// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ReadersCatchUpNote } from "./AiChatCodex.js";

describe("编辑部补读前文：平时不占字（安静账房）", () => {
  afterEach(() => cleanup());

  it("核账员 / 记账员 / 章纲员在后台读前文，这行不出；动作在等它读完也不出（卡上会说）", () => {
    const { container } = render(
      <>
        <ReadersCatchUpNote status={undefined} />
        <ReadersCatchUpNote status={null} />
        <ReadersCatchUpNote
          status={{
            reading: true,
            roles: [
              { role: "checker", reading: true, done: 34, total: 58, waiting: "核账" },
              { role: "ledger", reading: false, done: 0, total: 58 },
              { role: "planner", reading: false, done: 0, total: 58 },
            ],
          }}
        />
      </>,
    );
    expect(container.textContent).toBe("");
  });
});

describe("导入的书通读记账（P8）", () => {
  afterEach(() => cleanup());
  const roles = (done: number, reading: boolean) => [
    { role: "checker" as const, reading: false, done: 0, total: 8 },
    { role: "ledger" as const, reading, done, total: 8 },
    { role: "planner" as const, reading: false, done: 0, total: 8 },
  ];

  it("在记：说记到第几章、还要多久", () => {
    render(<ReadersCatchUpNote status={{ reading: true, roles: roles(3, true), reread: { status: "running", done: 3, total: 8, etaMinutes: 12 } }} />);
    expect(screen.getByRole("status").textContent).toBe("导入的书在记账：第 3/8 章（约 12 分钟）");
  });

  it("停下了：说停在哪、为什么，点「接着记」；接着记没成功如实写原因", async () => {
    const onResumeReread = vi.fn().mockRejectedValueOnce(new Error("网络断了")).mockResolvedValue(undefined);
    render(
      <ReadersCatchUpNote
        onResumeReread={onResumeReread}
        status={{ reading: false, roles: roles(3, false), reread: { status: "stopped", done: 3, total: 8, stoppedReason: "服务商 502" } }}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("记账员记到第 3/8 章停下了：服务商 502");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "接着记" }));
    });
    expect(onResumeReread).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status").textContent).toContain("（网络断了）");
  });

  it("还没接上 AI 时停下了：不报错、不给点了也记不上的「接着记」，说接上以后怎么做（对标走查）", () => {
    const stopped = { reading: false, roles: roles(0, false), reread: { status: "stopped" as const, done: 0, total: 120, stoppedReason: "记账员没交上账单：还没接上 AI" } };
    const { rerender } = render(<ReadersCatchUpNote aiMissing onResumeReread={vi.fn()} status={stopped} />);
    expect(screen.getByRole("status").textContent).toBe("导入的 120 章还没记账。接上 AI 后点「接着记」，它会一章章记下人物和发生的事。");
    expect(screen.queryByRole("button", { name: "接着记" })).toBeNull();
    rerender(<ReadersCatchUpNote aiMissing onResumeReread={vi.fn()} status={{ ...stopped, reread: { ...stopped.reread, done: 40 } }} />);
    expect(screen.getByRole("status").textContent).toContain("导入的书记账记到第 40/120 章。");
  });
});
