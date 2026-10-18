// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReadersCatchUpNote } from "./AiChatCodex.js";
import { useReaderCatchUp, READER_CATCH_UP_POLL_MS } from "../../../hooks/useReaderCatchUp.js";
import { fetchReaderCatchUp } from "../../../api/client.js";
import type { ReaderCatchUpStatus } from "../../../api/types.js";

vi.mock("../../../api/client.js", () => ({ fetchReaderCatchUp: vi.fn() }));

describe("ReadersCatchUpNote 编辑部在读前文进度行（R4.3 验收 3.3）", () => {
  afterEach(() => cleanup());

  it("一行写全三个角色：在读的带 done/total，还没轮到的「排队」", () => {
    render(
      <ReadersCatchUpNote
        status={{
          reading: true,
          roles: [
            { role: "checker", reading: true, done: 34, total: 58 },
            { role: "ledger", reading: false, done: 0, total: 58 },
            { role: "planner", reading: false, done: 0, total: 58 },
          ],
        }}
      />,
    );
    expect(screen.getByRole("status").textContent)
      .toBe("编辑部在读前文：核账员 34/58 · 记账员 排队 · 章纲员 排队");
  });

  it("读完一个划掉一个：读完的角色划线，还在读的照常走数字", () => {
    render(
      <ReadersCatchUpNote
        status={{
          reading: true,
          roles: [
            { role: "checker", reading: false, done: 58, total: 58 },
            { role: "ledger", reading: true, done: 12, total: 58 },
            { role: "planner", reading: false, done: 0, total: 58 },
          ],
        }}
      />,
    );
    expect(screen.getByRole("status").textContent)
      .toBe("编辑部在读前文：核账员 58/58 · 记账员 12/58 · 章纲员 排队");
    // 划掉的是「核账员 58/58」那一段（<s>），不是整行。
    const struck = document.querySelector(".se-checker-reading-done");
    expect(struck?.tagName).toBe("S");
    expect(struck?.textContent).toBe("核账员 58/58");
  });

  it("全读完这行消失（reading:false）", () => {
    const { container } = render(
      <ReadersCatchUpNote
        status={{
          reading: false,
          roles: [
            { role: "checker", reading: false, done: 58, total: 58 },
            { role: "ledger", reading: false, done: 58, total: 58 },
            { role: "planner", reading: false, done: 58, total: 58 },
          ],
        }}
      />,
    );
    expect(container.querySelector(".se-checker-reading")).toBeNull();
  });

  it("没开过编辑部（没进度）/ 出错停了（reading:false 没读齐）：不显示，不谎称还在读", () => {
    const { container } = render(
      <>
        <ReadersCatchUpNote status={undefined} />
        <ReadersCatchUpNote status={null} />
        <ReadersCatchUpNote
          status={{
            reading: false,
            roles: [
              { role: "checker", reading: false, done: 3, total: 58 },
              { role: "ledger", reading: false, done: 0, total: 0 },
              { role: "planner", reading: false, done: 0, total: 0 },
            ],
          }}
        />
      </>,
    );
    expect(container.querySelector(".se-checker-reading")).toBeNull();
  });

  it("动作在等谁读完就在谁后面标出来（R5.2）：核账等核账员、拟纲等章纲员、记账等记账员，各标各的", () => {
    render(
      <ReadersCatchUpNote
        status={{
          reading: true,
          roles: [
            { role: "checker", reading: true, done: 50, total: 58, waiting: "核账" },
            { role: "ledger", reading: false, done: 0, total: 58 },
            { role: "planner", reading: false, done: 0, total: 58 },
          ],
        }}
      />,
    );
    expect(screen.getByRole("status").textContent)
      .toBe("编辑部在读前文：核账员 50/58（核账在等它读完） · 记账员 排队 · 章纲员 排队");
    cleanup();
    render(
      <ReadersCatchUpNote
        status={{
          reading: true,
          roles: [
            { role: "checker", reading: false, done: 58, total: 58 },
            { role: "ledger", reading: false, done: 0, total: 58 },
            { role: "planner", reading: true, done: 55, total: 58, waiting: "拟纲" },
          ],
        }}
      />,
    );
    expect(screen.getByRole("status").textContent)
      .toBe("编辑部在读前文：核账员 58/58 · 记账员 排队 · 章纲员 55/58（拟纲在等它读完）");
    cleanup();
    render(
      <ReadersCatchUpNote
        status={{
          reading: true,
          roles: [
            { role: "checker", reading: false, done: 58, total: 58 },
            { role: "ledger", reading: true, done: 57, total: 58, waiting: "记账" },
            { role: "planner", reading: false, done: 58, total: 58 },
          ],
        }}
      />,
    );
    expect(screen.getByRole("status").textContent)
      .toBe("编辑部在读前文：核账员 58/58 · 记账员 57/58（记账在等它读完） · 章纲员 58/58");
  });

  it("waiting 是残留脏值（reading 已翻 false）：不标——等读完了就不说还在等", () => {
    render(
      <ReadersCatchUpNote
        status={{
          reading: true,
          roles: [
            { role: "checker", reading: false, done: 58, total: 58, waiting: "核账" },
            { role: "ledger", reading: true, done: 12, total: 58 },
            { role: "planner", reading: false, done: 0, total: 58 },
          ],
        }}
      />,
    );
    expect(screen.getByRole("status").textContent)
      .toBe("编辑部在读前文：核账员 58/58 · 记账员 12/58 · 章纲员 排队");
  });
});

describe("导入的书通读记账（P8）", () => {
  afterEach(() => cleanup());
  const roles = (done: number, reading: boolean) => [
    { role: "checker" as const, reading: false, done: 0, total: 8 },
    { role: "ledger" as const, reading, done, total: 8 },
    { role: "planner" as const, reading: false, done: 0, total: 8 },
  ];

  it("在记：记账员那一段带上还要多久", () => {
    render(<ReadersCatchUpNote status={{ reading: true, roles: roles(3, true), reread: { status: "running", done: 3, total: 8, etaMinutes: 12 } }} />);
    expect(screen.getByRole("status").textContent).toBe("编辑部在读前文：核账员 排队 · 记账员 3/8（约 12 分钟） · 章纲员 排队");
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
});

describe("进度行走真轮询链路（R6.2）：动作进行中等待补读，这行不等回包落地就现出来", () => {
  const fetchMock = vi.mocked(fetchReaderCatchUp);

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("开书那轮已读完（reading:false）＋点核账（动作进行中）：5 秒轮询一轮后，进度行出现「核账员 3/10（核账在等它读完）」", async () => {
    // R6.1 服务端的 waiting 字段不在本工作树（未合并）：这里用假的轮询返回值（waiting 手写）测前端渲染，不等合并。
    fetchMock.mockResolvedValue({
      reading: true,
      roles: [
        { role: "checker", reading: true, done: 3, total: 10, waiting: "核账" },
        { role: "ledger", reading: false, done: 0, total: 10 },
        { role: "planner", reading: false, done: 0, total: 10 },
      ],
    });
    // 开书那轮的初值：全读完（概况没带 readerCatchUp 也是 undefined，这里用全读完的旧形状更严）。
    const initialAllDone: ReaderCatchUpStatus = {
      reading: false,
      roles: [
        { role: "checker", reading: false, done: 10, total: 10 },
        { role: "ledger", reading: false, done: 10, total: 10 },
        { role: "planner", reading: false, done: 10, total: 10 },
      ],
    };
    let actionInFlight = true;
    function Harness() {
      const status = useReaderCatchUp("/books/demo", initialAllDone, actionInFlight);
      return <ReadersCatchUpNote status={status} />;
    }
    const { rerender } = render(<Harness />);
    expect(screen.queryByRole("status")).toBeNull(); // 开书那轮读完：这行先收着
    await act(async () => {
      await vi.advanceTimersByTimeAsync(READER_CATCH_UP_POLL_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1); // reading:false 但动作在等回包：照轮
    expect(screen.getByRole("status").textContent)
      .toBe("编辑部在读前文：核账员 3/10（核账在等它读完） · 记账员 排队 · 章纲员 排队");
    // 回包到了，但补读还在读（reading:true）：这行留着、轮询照走。
    actionInFlight = false;
    rerender(<Harness />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(READER_CATCH_UP_POLL_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status").textContent)
      .toBe("编辑部在读前文：核账员 3/10（核账在等它读完） · 记账员 排队 · 章纲员 排队");
  });
});
