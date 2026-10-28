// @vitest-environment node
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { chapterCommit, runCommand, type EntryInput } from "@actalk/story-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import type { BrainCallModel } from "../editorial/reader-window.js";
import { runSettleAction, type SettleUserAction } from "./settle-actions.js";
import { parseUserAction } from "./user-actions.js";

const CH1 = "# 第1章 · 旧屋\n\n杜叔走了整整十年。屋里没人住过。";
const CH2 = "# 第2章 · 来信\n\n“杜叔走了五年了。”孟叔说。许微没接话。";
const E1: EntryInput[] = [{ kind: "fact", review: "auto", nature: "hard", subject: "杜长顺", attribute: "去世", value: "十年前", text: "杜长顺十年前去世", quote: "杜叔走了整整十年" }];
const E2: EntryInput[] = [{ kind: "summary", review: "auto", text: "孟叔说起杜叔", quote: "杜叔走了五年了" }];

let dir: string;
beforeEach(async () => {
  dir = await makeHomeTempDir("settle-action-");
  for (const [chapter, text, entries] of [[1, CH1, E1], [2, CH2, E2]] as const) {
    const outcome = await runCommand(dir, chapterCommit, { chapter, text, entries: [...entries] }, { caller: "author", idempotencyKey: `c${chapter}` });
    if (!outcome.ok) throw new Error(outcome.message);
  }
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const model: BrainCallModel = async (messages) => {
  const prompt = messages.at(-1)?.content ?? "";
  if (prompt.includes("写成一条「定论」")) return JSON.stringify({ canon: "杜长顺十年前去世", names: ["杜叔"] });
  if (prompt.includes("设定本里相关的几栏")) return JSON.stringify({ edits: [] });
  if (prompt.includes("逐句看")) {
    const unit = /\[(\d+)\]“杜叔走了五年了。”/u.exec(prompt);
    return JSON.stringify({ edits: unit ? [{ chapter: 2, id: Number(unit[1]), to: "“杜叔走了十年了。”", why: "五年对不上十年" }] : [] });
  }
  throw new Error("没想到的提示");
};

function recorder() {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  return {
    events,
    sendEvent: (event: string, data: unknown) => events.push({ event, data: data as Record<string, unknown> }),
    scrubber: { push: (text: string) => text, flush: () => "" },
    scrubError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
    text: () => events.filter((item) => item.event === "text-delta").map((item) => item.data.text).join(""),
    result: (toolName: string) => events.find((item) => item.event === "tool-result" && item.data.toolName === toolName)?.data.output as Record<string, unknown> | undefined,
  };
}

describe("定论按钮", () => {
  it("解析：缺原句 / 票号不对回 invalid，不当普通对话", () => {
    const pick = { toolName: "settle_preview", chapter: 2, truth: { where: "chapter", chapter: 1, quote: "杜叔走了整整十年" }, other: { where: "chapter", chapter: 2, quote: "杜叔走了五年了" } };
    expect(parseUserAction(pick)).toMatchObject({ kind: "action", action: { toolName: "settle_preview", chapter: 2, truth: { chapter: 1 } } });
    expect(parseUserAction({ ...pick, truth: { where: "chapter", chapter: 1 } })).toMatchObject({ kind: "invalid" });
    const also = [{ where: "chapter", chapter: 5, quote: "老码头在东头" }, { where: "setting", quote: "西头", label: "位置" }, { where: "chapter", chapter: 6 }];
    expect(parseUserAction({ ...pick, also })).toMatchObject({ kind: "action", action: { also: [{ where: "chapter", chapter: 5, quote: "老码头在东头" }] } });
    expect(parseUserAction({ ...pick, item: "杜叔走了五年了#杜叔走了整整十年" })).toMatchObject({ kind: "action", action: { item: "杜叔走了五年了#杜叔走了整整十年" } });
    expect(parseUserAction({ toolName: "settle_preview", chapter: 2, truth: { where: "setting", quote: "十年前", label: "去世" } }))
      .toMatchObject({ kind: "action", action: { truth: { where: "setting", label: "去世" } } });
    expect(parseUserAction({ toolName: "settle_preview", statement: " 杜长顺十年前去世 " }))
      .toEqual({ kind: "action", action: { toolName: "settle_preview", statement: "杜长顺十年前去世" } });
    expect(parseUserAction({ toolName: "settle_preview", statement: "" })).toMatchObject({ kind: "invalid" });
    // 核账卡「以定论为准」带着报的那句；只认章里的句子
    expect(parseUserAction({ toolName: "settle_preview", statement: "杜长顺十年前去世", chapter: 4, also: [{ where: "chapter", chapter: 4, quote: "说他五年前就没了" }, { where: "setting", quote: "x", label: "y" }, "乱的"] }))
      .toEqual({ kind: "action", action: { toolName: "settle_preview", statement: "杜长顺十年前去世", chapter: 4, also: [{ where: "chapter", chapter: 4, quote: "说他五年前就没了" }] } });
    expect(parseUserAction({ toolName: "settle_apply", token: "abc" })).toMatchObject({ kind: "invalid" });
    expect(parseUserAction({ toolName: "settle_apply", token: "0123456789abcdef", excluded: ["e1", 3] }))
      .toEqual({ kind: "action", action: { toolName: "settle_apply", token: "0123456789abcdef", excluded: ["e1"] } });
  });

  it("预览出定论卡（不改书）→ 确认改齐（带存档点、整屏刷新、给「再核」）→ 再点只说做过了", async () => {
    const preview = recorder();
    const action: SettleUserAction = {
      toolName: "settle_preview",
      chapter: 2,
      truth: { where: "chapter", chapter: 1, quote: "杜叔走了整整十年" },
      other: { where: "chapter", chapter: 2, quote: "杜叔走了五年了" },
    };
    await runSettleAction({ ...preview, projectDir: dir, action: { ...action, item: "k#1" }, callModel: model });
    const output = preview.result("settle_preview");
    expect(output).toMatchObject({ settle: { resolves: "k#1" } });
    expect(output).toMatchObject({ ok: true, settle: { canon: "杜长顺十年前去世", edits: [{ chapter: 2, draft: false, from: "“杜叔走了五年了。”", to: "“杜叔走了十年了。”" }] } });
    expect(preview.text()).toBe("查完了：第 2 章 1 句要改。点「确认」一起改齐，改前存档、能撤销。");
    expect(await readFile(join(dir, "chapters/0002.md"), "utf-8")).toBe(CH2);

    const token = (output!.settle as { token: string }).token;
    const apply = recorder();
    await runSettleAction({ ...apply, projectDir: dir, action: { toolName: "settle_apply", token, excluded: [] } });
    expect(apply.result("settle_apply")).toMatchObject({ ok: true, refreshScope: "full", snapshotId: expect.any(String) });
    expect(apply.text()).toBe("改齐了。设定本：记下定论「杜长顺十年前去世」；改了第 2 章 1 句。");
    expect(apply.result("suggest_next_steps")).toMatchObject({ choices: [{ label: "再核第 2 章", action: { toolName: "check_continuity", chapter: 2, fresh: true } }] });
    expect(await readFile(join(dir, "chapters/0002.md"), "utf-8")).toContain("“杜叔走了十年了。”");

    const again = recorder();
    await runSettleAction({ ...again, projectDir: dir, action: { toolName: "settle_apply", token, excluded: [] } });
    expect(again.text()).toBe("这一步刚才已经做过了，没再改。");
    expect(again.result("suggest_next_steps")).toBeUndefined();
  });

  it("票号找不到如实说没改", async () => {
    const apply = recorder();
    await runSettleAction({ ...apply, projectDir: dir, action: { toolName: "settle_apply", token: "0123456789abcdef", excluded: [] } });
    expect(apply.result("settle_apply")).toMatchObject({ ok: false });
    expect(apply.text()).toBe("没改：这份定论预览找不到了，重新查一遍。");
  });
});
