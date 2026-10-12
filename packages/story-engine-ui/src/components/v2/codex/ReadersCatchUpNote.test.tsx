// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ReadersCatchUpNote } from "./AiChatCodex.js";

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
});
