// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { CheckerReadingNote } from "./AiChatCodex.js";

describe("CheckerReadingNote 核账员补读进度行（T5 长书）", () => {
  afterEach(() => cleanup());

  it("还在读：显示读到第几章、共几章", () => {
    render(<CheckerReadingNote progress={{ reading: true, done: 12, total: 58 }} />);
    expect(screen.getByRole("status").textContent).toContain("核账员在读前文：第 12 / 58 章");
  });

  it("读完 / 停了 / 没开过：不显示（不谎称还在读）", () => {
    const { container } = render(
      <>
        <CheckerReadingNote progress={{ reading: false, done: 58, total: 58 }} />
        <CheckerReadingNote progress={{ reading: false, done: 3, total: 58 }} />
        <CheckerReadingNote progress={undefined} />
        <CheckerReadingNote progress={null} />
      </>,
    );
    expect(container.querySelector(".se-checker-reading")).toBeNull();
  });
});
