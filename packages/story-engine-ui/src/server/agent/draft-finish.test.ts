// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import type { OperationRecord } from "../lib/operations/store.js";
import { afterDraftCheckLine, draftRetryChoices, finishDraftOperation, rewriteChoices, type DraftFinishArgs } from "./draft-finish.js";

const BOOK = "/books/没有这本书";

/** 写稿操作的记录（只填收尾要看的那几样）。 */
function record(state: OperationRecord["state"], extra: { readonly mode?: string; readonly params?: unknown; readonly body?: unknown; readonly summary?: string; readonly failure?: OperationRecord["failure"] } = {}): OperationRecord {
  return {
    kind: "draft.change",
    mode: extra.mode ?? "write",
    params: extra.params ?? { chapter: 2 },
    origin: { kind: "chat", messageId: "user-1", chapter: 2 },
    state,
    ...(extra.body !== undefined ? { result: { schema: "operation-result/1", summary: extra.summary ?? "写好了", body: extra.body } } : {}),
    ...(extra.failure ? { failure: extra.failure } : {}),
  } as unknown as OperationRecord;
}

function written(body: Record<string, unknown>): Record<string, unknown> {
  return { kind: "draft.change", mode: "write", ok: true, chapter: 2, draftBody: "正文", qualityPipeline: {}, notes: [], issues: [], ...body };
}

async function finish(op: OperationRecord, args: Partial<DraftFinishArgs> = {}) {
  const events: { event: string; data: Record<string, unknown> }[] = [];
  await finishDraftOperation(op, {
    projectDir: BOOK,
    sendEvent: (event, data) => events.push({ event, data: data as Record<string, unknown> }),
    scrubber: { push: (text) => text, flush: () => "" },
    ...args,
  });
  const text = events.filter((item) => item.event === "text-delta").map((item) => item.data.text).join("");
  const next = events.filter((item) => item.event === "tool-result").at(-1)?.data.output as { question: string; choices: { label: string; recommended?: boolean; action?: unknown }[] } | undefined;
  return { events, text, next };
}

const draftAction = (mode: string, params: Record<string, unknown>) => expect.objectContaining({ kind: "new", type: "draft.change", mode, params });

describe("写稿做完了这一轮怎么收（写作版本 P2a：对话、按钮同一套）", () => {
  it("写好了、写完没核账 → 一句结论；下一步「定稿」「核账」", async () => {
    const { text, next } = await finish(record("succeeded", { body: written({ draftLength: { actualLength: 3000, lengthStatus: "within_range" } }) }));
    expect(text).toBe("第 2 章写好了，3000 字。");
    expect(next?.question).toBe("第 2 章写好了，接下来？");
    expect(next?.choices).toEqual([
      expect.objectContaining({ label: "定稿", recommended: true, action: expect.objectContaining({ kind: "new", type: "commit.prepare", params: { chapter: 2 } }) }),
      expect.objectContaining({ label: "核账", action: expect.objectContaining({ kind: "new", type: "inspect.run", mode: "continuity", params: { chapter: 2 } }) }),
    ]);
  });

  it("写完核过账 → 结论一句，接着出核账卡（只读核账记忆），确定有错时下一步只留「接着往下写」（稿子短了）", async () => {
    const readCachedCheck = vi.fn(async () => ({ ok: true, chapter: 2, reused: true, sure: [{ quote: "q" }], maybe: [{}], failures: [] }));
    const { events, text, next } = await finish(record("succeeded", {
      body: written({ draftTitle: "存根", draftLength: { actualLength: 2300, lowerBound: 2400, lengthStatus: "below_lower_bound" }, qualityPipeline: { continuity: { checked: true } } }),
    }), { readCachedCheck });
    expect(readCachedCheck).toHaveBeenCalledWith(BOOK, 2);
    expect(text).toBe("第 2 章写好了《存根》，2300 字，比下限少 100 字。\n写完核了一遍：确定对不上 1 处，画在稿纸上了；另有可能 1 处，在卡上点开看。");
    expect(events.filter((item) => item.event === "card")).toEqual([{ event: "card", data: { type: "continuity", check: expect.objectContaining({ chapter: 2, reused: true }) } }]);
    expect(next?.question).toBe("接下来？");
    expect(next?.choices).toEqual([expect.objectContaining({ label: "接着往下写", action: draftAction("continue", { chapter: 2 }) })]);
  });

  it("写完核过账、没有确定的 → 下一步「定稿」「AI 写下一章」", async () => {
    const { next } = await finish(record("succeeded", { body: written({ draftLength: { actualLength: 3000 }, qualityPipeline: { continuity: { checked: true } } }) }), {
      readCachedCheck: async () => ({ ok: true, chapter: 2, sure: [], maybe: [], failures: [] }),
    });
    expect(next?.choices).toEqual([
      expect.objectContaining({ label: "定稿", recommended: true }),
      expect.objectContaining({ label: "AI 写下一章", action: draftAction("write", { chapter: 3 }) }),
    ]);
  });

  it("写完核过账、但记忆对不上（有一遍没核全）→ 如实说没核全，下一步给「核账」，不偷偷再跑", async () => {
    const { events, text, next } = await finish(record("succeeded", { body: written({ draftLength: { actualLength: 3000 }, qualityPipeline: { continuity: { checked: true } } }) }), {
      readCachedCheck: async () => null,
    });
    expect(text).toBe("第 2 章写好了，3000 字。\n写完那遍核账没核全，可以点「核账」再核。");
    expect(events.some((item) => item.event === "card")).toBe(false);
    expect(next?.choices.map((choice) => choice.label)).toEqual(["定稿", "核账"]);
  });

  it("写完那遍核账没跑成 → 如实说一句，不出核账卡", async () => {
    const readCachedCheck = vi.fn(async () => ({ ok: true }));
    const { events, text } = await finish(record("succeeded", { body: written({ draftLength: { actualLength: 3000 }, qualityPipeline: { continuity: { checked: false } } }) }), { readCachedCheck });
    expect(text).toBe("第 2 章写好了，3000 字。\n写完那遍核账没跑成，可以点「核账」再核。");
    expect(readCachedCheck).not.toHaveBeenCalled();
    expect(events.some((item) => item.event === "card")).toBe(false);
  });

  it("作者要写完就定稿 → 核账卡后接着出定稿清单，不另给下一步；没核账的也直接出清单", async () => {
    const previewCommit = vi.fn(async () => undefined);
    const checked = await finish(record("succeeded", { body: written({ thenPreview: true, qualityPipeline: { continuity: { checked: true } } }) }), {
      previewCommit,
      readCachedCheck: async () => ({ ok: true, chapter: 2, sure: [], maybe: [], failures: [] }),
    });
    expect(previewCommit).toHaveBeenCalledWith(2);
    expect(checked.events.map((item) => item.event)).toContain("card");
    expect(checked.next).toBeUndefined();
    const plain = await finish(record("succeeded", { body: written({ thenPreview: true }) }), { previewCommit });
    expect(previewCommit).toHaveBeenCalledTimes(2);
    expect(plain.next).toBeUndefined();
  });

  it("写手把「第 N 章 · 」写进了章名：书名号里只放章名", async () => {
    const { text } = await finish(record("succeeded", { body: written({ chapter: 29, draftTitle: "第29章 · 手印", draftLength: { actualLength: 1859, lengthStatus: "within_range" } }) }));
    expect(text).toBe("第 29 章写好了《手印》，1859 字。");
  });

  it("作者要的要点可能没写到 → 照说，下一步先给「补上这几条」", async () => {
    const { text, next } = await finish(record("succeeded", {
      body: written({ draftLength: { actualLength: 3000 }, beatFidelity: { missingBeats: ["老周认出账本", ""], postDeAiNewMisses: ["老周认出账本", "雨停"] } }),
    }));
    expect(text).toBe("第 2 章写好了，3000 字。\n这几条要点可能没写到：老周认出账本、雨停。");
    expect(next?.choices.map((choice) => choice.label)).toEqual(["补上这几条", "定稿", "核账"]);
    expect(next?.choices[1]?.recommended).not.toBe(true);
  });

  it("接着往下写的：说接了多少、前面的没动；短了下一步先给「接着往下写」", async () => {
    const { text, next } = await finish(record("succeeded", {
      mode: "continue",
      params: { chapter: 4 },
      body: written({ mode: "continue", chapter: 4, continued: { kept: 900, added: 1200 }, draftLength: { actualLength: 2100, lowerBound: 2400, lengthStatus: "below_lower_bound" } }),
    }));
    expect(text).toBe("第 4 章接着写了 1200 字，前面的 900 字没动，全章 2100 字，比下限少 300 字。");
    expect(next?.choices.map((choice) => choice.label)).toEqual(["接着往下写", "定稿", "核账"]);
  });

  it("作者说了这次写多少、没写够：照实说少了多少；写够八成五不提（界面真点 2026-10-30）", async () => {
    const brief = async (added: number) => (await finish(record("succeeded", {
      mode: "continue",
      params: { chapter: 9, length: 300 },
      body: written({ mode: "continue", chapter: 9, continued: { kept: 2641, added, asked: 300 }, draftLength: { actualLength: 2641 + added } }),
    }))).text;
    expect(await brief(201)).toBe("第 9 章接着写了 201 字，比你要的 300 字少 99 字，前面的 2641 字没动，全章 2842 字。");
    expect(await brief(260)).toBe("第 9 章接着写了 260 字，前面的 2641 字没动，全章 2901 字。");
  });

  it("写好了没换上（写的途中作者改过稿）：照结论说，不给下一步、不再写一遍", async () => {
    const { text, next } = await finish(record("succeeded", {
      summary: "第 2 章写好了，但写的途中稿子改过：AI 这版在稿纸上等你选。",
      body: written({ ok: false, kept: { candidateId: "2-x", reason: "draft_moved" } }),
    }));
    expect(text).toBe("第 2 章写好了，但写的途中稿子改过：AI 这版在稿纸上等你选。");
    expect(next).toBeUndefined();
  });

  it("没写成：照原因说、原来的稿子没动；能重试的给「再写一次」（同样的参数）", async () => {
    const params = { chapter: 2, direction: "让林溪回来" };
    const { text, next } = await finish(record("failed", { params, failure: { code: "model_failed", message: "模型没回。", retryable: true } }));
    expect(text).toBe("写稿·第 2 章没做成：模型没回。原来的稿子没动。");
    expect(next?.choices).toEqual([expect.objectContaining({ label: "再写一次", action: draftAction("write", params) })]);
    const stuck = await finish(record("failed", { failure: { code: "x", message: "写不了。", retryable: false } }));
    expect(stuck.next).toBeUndefined();
  });
});

describe("没写成 / 没受理的下一步（按原因给）", () => {
  it("导入的书在记账、已定稿、没配模型、参数不对 → 不给；没得接 → 改成从头写（带方向）", async () => {
    for (const code of ["rereading", "chapter_committed", "model_missing", "bad_params"]) {
      expect(await draftRetryChoices(BOOK, code, "continue", { chapter: 4 })).toEqual([]);
    }
    expect(await draftRetryChoices(BOOK, "nothing_to_continue", "continue", { chapter: 4, direction: "接着打" })).toEqual([
      expect.objectContaining({ label: "AI 写第 4 章", action: draftAction("write", { chapter: 4, direction: "接着打" }) }),
    ]);
  });

  it("前一章没定稿 → 先定稿前一章 / 仍要先写（带 allowWriteAhead）；有稿 → 接着写 / 重写", async () => {
    expect(await draftRetryChoices(BOOK, "previous_chapter_not_committed", "write", { chapter: 5 })).toEqual([
      expect.objectContaining({ label: "先定稿第 4 章", action: expect.objectContaining({ kind: "new", type: "commit.prepare", params: { chapter: 4 } }) }),
      expect.objectContaining({ label: "仍要先写第 5 章", action: draftAction("write", { chapter: 5, allowWriteAhead: true }) }),
    ]);
    expect((await draftRetryChoices(BOOK, "chapter_has_text", "write", { chapter: 5 })).map((choice) => choice.label)).toEqual(["接着往下写", "重写第 5 章"]);
  });

  it("按钮没受理的（在忙、已经做过）不给「再写一次」", async () => {
    expect(await draftRetryChoices(BOOK, "busy", "write", { chapter: 5 }, false)).toEqual([]);
  });
});

describe("rewriteChoices 有稿的章（作者点了才写）", () => {
  it("没定稿：接着写只带方向和要点，重写带原参数 + rewrite；已定稿只给重写", () => {
    const params = { chapter: 3, direction: "让林溪回来", mustHitBeats: ["账本"], length: 3000, candidates: 2 as const };
    expect(rewriteChoices(params, false)).toEqual([
      expect.objectContaining({ label: "接着往下写", action: draftAction("continue", { chapter: 3, direction: "让林溪回来", mustHitBeats: ["账本"] }) }),
      expect.objectContaining({ label: "重写第 3 章", action: draftAction("write", { ...params, rewrite: true }) }),
    ]);
    expect(rewriteChoices(params, true).map((choice) => choice.label)).toEqual(["重写第 3 章"]);
  });
});

describe("afterDraftCheckLine 写完核账那一句", () => {
  it("只剩「可能」：说在卡上点开看，不说画上了；改过的说改了几处、再核还剩几处", () => {
    const item = { quote: "q", earlierQuote: "e", earlierChapter: 1, reason: "r" };
    expect(afterDraftCheckLine({ ok: true, sure: [], maybe: [item] })).toBe("写完核了一遍：没有确定对不上的；可能 1 处，在卡上点开看。");
    expect(afterDraftCheckLine({ ok: true, sure: [item], maybe: [] }, 2)).toBe("写完核账，改了 2 处对不上的；再核还有确定对不上 1 处，画在稿纸上了。");
    expect(afterDraftCheckLine({ ok: true, sure: [], maybe: [] }, 3)).toBe("写完核账，改了 3 处对不上的；再核没发现别的。");
    expect(afterDraftCheckLine({ ok: false })).toBeUndefined();
  });
});
