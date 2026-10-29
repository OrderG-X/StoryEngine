// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { newInspectAction } from "../../../api/agentChatClient.js";
import { NextStepChoicesRow } from "./AiChatCodex.js";
import type { NextStepPrompt } from "./nextStepChoices.js";

afterEach(() => cleanup());

const prompt = (choices: NextStepPrompt["choices"]): NextStepPrompt => ({ question: "接下来？", choices });

describe("NextStepChoicesRow 点击分派（R4.7：有 action 直发结构化动作，无 action 照旧发文本）", () => {
  it("choice 带 action → 只调 onSendUserAction（发 body.action，不经模型），不把 intent 当文本发", () => {
    const onSendUserAction = vi.fn();
    const onSendMessage = vi.fn();
    render(
      <NextStepChoicesRow
        nextStep={prompt([
          { label: "预览定稿", intent: "预览第 5 章的定稿改动", primary: true, action: { toolName: "commit_preview", chapter: 5 } },
        ])}
        busy={false}
        onSendMessage={onSendMessage}
        onSendUserAction={onSendUserAction}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /预览定稿/ }));
    expect(onSendUserAction).toHaveBeenCalledTimes(1);
    expect(onSendUserAction).toHaveBeenCalledWith({ toolName: "commit_preview", chapter: 5 });
    expect(onSendMessage).not.toHaveBeenCalled();
  });

  it("choice 不带 action（模型 suggest_next_steps 生成的选项）→ 照旧把 intent 当一句话发给 agent", () => {
    const onSendUserAction = vi.fn();
    const onSendMessage = vi.fn();
    render(
      <NextStepChoicesRow
        nextStep={prompt([{ label: "补地点", intent: "帮我把地点补上" }])}
        busy={false}
        onSendMessage={onSendMessage}
        onSendUserAction={onSendUserAction}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /补地点/ }));
    expect(onSendMessage).toHaveBeenCalledWith("帮我把地点补上");
    expect(onSendUserAction).not.toHaveBeenCalled();
  });

  it("无 action 的「确认定稿第 N 章」不再按措辞认成按钮（重构 P4）：当一句话发给 AI，AI 调定稿只会出确认按钮", () => {
    const onSendUserAction = vi.fn();
    const onSendMessage = vi.fn();
    render(
      <NextStepChoicesRow
        nextStep={prompt([{ label: "确认定稿", intent: "确认定稿第 5 章" }])}
        busy={false}
        onSendMessage={onSendMessage}
        onSendUserAction={onSendUserAction}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /确认定稿/ }));
    expect(onSendMessage).toHaveBeenCalledWith("确认定稿第 5 章");
    expect(onSendUserAction).not.toHaveBeenCalled();
  });

  it("带 action 但外层没接 onSendUserAction（老挂载路径）→ 退回发 intent 文本，不静默丢点击", () => {
    const onSendMessage = vi.fn();
    render(
      <NextStepChoicesRow
        nextStep={prompt([{ label: "再核一次", intent: "重新核第 5 章的账", action: newInspectAction("continuity", 5) }])}
        busy={false}
        onSendMessage={onSendMessage}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /再核一次/ }));
    expect(onSendMessage).toHaveBeenCalledWith("重新核第 5 章的账");
  });
});
