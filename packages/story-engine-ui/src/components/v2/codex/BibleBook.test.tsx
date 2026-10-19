// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BibleEntry, BibleView, Card, CardField, CardOp } from "../../../api/bibleClient.js";

const saveCards = vi.fn<(projectPath: string, ops: readonly CardOp[]) => Promise<{ ok: true; lines: string[] } | { ok: false; error: string }>>();
vi.mock("../../../api/bibleClient.js", () => ({ saveCards: (projectPath: string, ops: readonly CardOp[]) => saveCards(projectPath, ops) }));

const { BibleBook } = await import("./BibleBook.js");
const { bibleSearchSources, mentionNamesOf, namePeekCardsOf, paletteCharactersOf } = await import("./bibleIndex.js");



const AT = "2026-10-19T00:00:00.000Z";

function field(label: string, value: string, by: "author" | "ai" = "author"): CardField {
  return { label, value, by, at: AT };
}

function entry(card: Partial<Card> & Pick<Card, "id" | "name">, extra: Partial<Omit<BibleEntry, "card">> = {}): BibleEntry {
  return {
    card: { kind: "character", aliases: [], fields: [], by: "author", at: AT, ...card },
    ledgerAliases: [],
    now: [],
    fixed: [],
    relations: [],
    ...extra,
  };
}

function bibleView(over: Partial<BibleView> = {}): BibleView {
  return {
    story: [field("一句话", "雾港的邮差收到一封十年前的信。"), field("题材", "悬疑", "ai")],
    rules: { style: [{ text: "短句", by: "author", at: AT }], musts: [], bans: [{ text: "不写血腥", by: "ai", at: AT }], avoid: [], exemplars: [], targetWords: { value: 3000, by: "author", at: AT } },
    characters: [
      entry(
        { id: "k-1", name: "林澈", protagonist: true, aliases: ["阿澈"], fields: [field("身份", "邮差"), field("年龄", "二十七", "ai")] },
        {
          ledgerAliases: ["小林"],
          appearances: { chapters: [1, 2, 3], first: 1, last: 3, viewpointChapters: 3 },
          now: [{ attribute: "在哪", value: "灯塔", chapter: 3, quote: "他推开灯塔的门" }],
          relations: [{ id: "r-1", other: "许微", label: "旧同学", by: "ai" }],
        },
      ),
      entry({ id: "k-2", name: "许微", fields: [field("身份", "灯塔看守")] }, { relations: [{ id: "r-1", other: "林澈", label: "旧同学", by: "ai" }] }),
    ],
    places: [entry({ id: "k-3", kind: "place", name: "雾港灯塔", fields: [field("样子", "白色，掉漆")] })],
    items: [],
    lore: [],
    relations: [{ id: "r-1", a: "林澈", b: "许微", label: "旧同学", by: "ai" }],
    uncarded: [
      { name: "老周", aliases: ["周叔"], character: true, appearances: { chapters: [2], first: 2, last: 2, viewpointChapters: 0 }, now: [], fixed: [] },
      { name: "旧邮局", aliases: [], character: false, now: [], fixed: [] },
    ],
    protagonist: "林澈",
    ...over,
  };
}

type Cat = Parameters<typeof BibleBook>[0]["cat"];

function renderBook(cat: Cat, over: { bible?: BibleView; busy?: boolean; focusName?: string } = {}) {
  const reload = vi.fn();
  const onChanged = vi.fn();
  const onJump = vi.fn();
  const onOpenCat = vi.fn();
  const view = render(
    <BibleBook cat={cat} projectPath="/books/fog" bible={over.bible ?? bibleView()} error={null} reload={reload} busy={over.busy ?? false}
      onChanged={onChanged} onJump={onJump} onOpenCat={onOpenCat} {...(over.focusName ? { focusName: over.focusName } : {})} />,
  );
  return { ...view, reload, onChanged, onJump, onOpenCat };
}

const lastOps = () => saveCards.mock.calls.at(-1)?.[1];

beforeEach(() => {
  saveCards.mockReset();
  saveCards.mockResolvedValue({ ok: true, lines: ["改了故事设定「一句话」"] });
});
afterEach(cleanup);

describe("设定本：作者直接改（一次改动一步，可撤销）", () => {
  it("故事设定：点字就改，回车存；存成了重读设定本、刷新开书概况，并说可撤销", async () => {
    const { reload, onChanged } = renderBook("story");
    fireEvent.click(screen.getByRole("button", { name: "雾港的邮差收到一封十年前的信。" }));
    const box = screen.getByLabelText("一句话");
    fireEvent.change(box, { target: { value: "雾港的邮差收到一封寄给死人的信。" } });
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    await waitFor(() => expect(saveCards).toHaveBeenCalledTimes(1));
    expect(saveCards.mock.calls[0]?.[0]).toBe("/books/fog");
    expect(lastOps()).toEqual([{ op: "story.set", label: "一句话", value: "雾港的邮差收到一封寄给死人的信。" }]);
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "改了故事设定「一句话」。可在操作历史里撤销。");
    expect(reload).toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalled();
  });

  it("AI 补的标出来，点「认下」算作者的；× 删掉一项", async () => {
    renderBook("story");
    fireEvent.click(screen.getByRole("button", { name: "认下" }));
    await waitFor(() => expect(lastOps()).toEqual([{ op: "story.accept", label: "题材" }]));
    fireEvent.click(screen.getByRole("button", { name: "删掉「一句话」" }));
    await waitFor(() => expect(lastOps()).toEqual([{ op: "story.set", label: "一句话", value: "" }]));
  });

  it("没改成：如实说原因，不重读、不刷新", async () => {
    saveCards.mockResolvedValue({ ok: false, error: "没改设定：AI 正在改这本书，等它做完再试。" });
    const { reload, onChanged } = renderBook("story");
    fireEvent.click(screen.getByRole("button", { name: "删掉「题材」" }));
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "没改设定：AI 正在改这本书，等它做完再试。");
    expect(reload).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("AI 在跑：提示等它做完，改不了", () => {
    renderBook("story", { busy: true });
    expect(screen.getByText("AI 正在忙，等它做完再改。")).toBeTruthy();
    expect((screen.getByRole("button", { name: "雾港的邮差收到一封十年前的信。" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("人物：按别名打开那张卡；账里用过的称呼点一下记成别名；别的人物可以设为主角", async () => {
    renderBook("chars", { focusName: "阿澈" });
    const lin = screen.getByRole("button", { name: /林澈/u, expanded: true });
    expect(lin).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "小林 +" }));
    await waitFor(() => expect(lastOps()).toEqual([{ op: "card.aliases", card: "k-1", add: ["小林"] }]));
    expect(screen.getByText("出场 第 1–3 章，共 3 章，3 章是这个人的视角")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /许微/u, expanded: false }));
    fireEvent.click(screen.getByRole("button", { name: "设为主角" }));
    await waitFor(() => expect(lastOps()).toEqual([{ op: "card.protagonist", card: "k-2" }]));
  });

  it("人物卡：账里记的现状带第几章，点了回正文那一句", () => {
    const { onJump } = renderBook("chars", { focusName: "林澈" });
    fireEvent.click(screen.getByRole("button", { name: "第 3 章" }));
    expect(onJump).toHaveBeenCalledWith(3, "他推开灯塔的门");
  });

  it("删卡要点两下", async () => {
    renderBook("chars", { focusName: "林澈" });
    fireEvent.click(screen.getByRole("button", { name: "删卡" }));
    expect(saveCards).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确定删「林澈」" }));
    await waitFor(() => expect(lastOps()).toEqual([{ op: "card.delete", card: "k-1" }]));
  });

  it("新建一张卡：名字回车就建", async () => {
    renderBook("places");
    fireEvent.click(screen.getByRole("button", { name: "+ 新地点" }));
    const box = screen.getByLabelText("新地点的名字");
    fireEvent.change(box, { target: { value: "旧邮局" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(lastOps()).toEqual([{ op: "card.create", kind: "place", name: "旧邮局" }]));
  });

  it("人物页提示账里还有几个人没建卡，点了去「还没建卡」", () => {
    const { onOpenCat } = renderBook("chars");
    fireEvent.click(screen.getByRole("button", { name: "账里还有 1 个人没建卡" }));
    expect(onOpenCat).toHaveBeenCalledWith("uncarded");
  });

  it("还没建卡：出场人物建人物卡（带上账里的称呼）；不知道是什么的由作者选建成什么", async () => {
    renderBook("uncarded");
    fireEvent.click(screen.getByRole("button", { name: "建人物卡" }));
    await waitFor(() => expect(lastOps()).toEqual([{ op: "card.create", kind: "character", name: "老周", aliases: ["周叔"] }]));
    const row = screen.getByRole("button", { name: /旧邮局/u }).closest("article") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "地点" }));
    await waitFor(() => expect(lastOps()).toEqual([{ op: "card.create", kind: "place", name: "旧邮局" }]));
  });

  it("关系：改一句、认下 AI 记的、加一条新的", async () => {
    renderBook("relations");
    fireEvent.click(screen.getByRole("button", { name: "认下" }));
    await waitFor(() => expect(lastOps()).toEqual([{ op: "relation.set", a: "林澈", b: "许微", label: "旧同学" }]));
    fireEvent.change(screen.getByLabelText("一方"), { target: { value: "许微" } });
    fireEvent.change(screen.getByLabelText("另一方"), { target: { value: "雾港灯塔" } });
    fireEvent.change(screen.getByLabelText("关系"), { target: { value: "在这儿值夜班" } });
    fireEvent.click(screen.getByRole("button", { name: "记下" }));
    await waitFor(() => expect(lastOps()).toEqual([{ op: "relation.set", a: "许微", b: "雾港灯塔", label: "在这儿值夜班" }]));
  });

  it("写作规则：AI 补的可以全部认下；字数改了就存，清空 = 不限；加一条禁写", async () => {
    renderBook("rules");
    fireEvent.click(screen.getByRole("button", { name: "全部认下" }));
    await waitFor(() => expect(lastOps()).toEqual([{ op: "rules.accept" }]));
    const target = screen.getByLabelText("每章目标字数");
    // 超过上限：不发、退回原值
    const calls = saveCards.mock.calls.length;
    fireEvent.change(target, { target: { value: "280000" } });
    fireEvent.blur(target);
    expect(saveCards.mock.calls.length).toBe(calls);
    expect((target as HTMLInputElement).value).toBe("3000");
    fireEvent.change(target, { target: { value: "2500" } });
    fireEvent.blur(target);
    await waitFor(() => expect(lastOps()).toEqual([{ op: "rules.set", field: "targetWords", value: 2500 }]));
    const block = screen.getByRole("heading", { name: /一定不要写/u }).closest("div") as HTMLElement;
    fireEvent.click(within(block).getByRole("button", { name: "+ 加一条" }));
    const box = within(block).getByLabelText("加一条一定不要写");
    fireEvent.change(box, { target: { value: "不写梦境开头" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(lastOps()).toEqual([{ op: "rules.add", list: "bans", text: "不写梦境开头" }]));
  });
});

describe("设定本派生的名单（搜索、⌘K、@、名字速览）", () => {
  it("搜索：每张卡一组，点了展开那张卡；设定类卡归在故事设定", () => {
    const sources = bibleSearchSources(bibleView({ lore: [entry({ id: "k-9", kind: "lore", name: "潮汐钟", fields: [field("规矩", "每晚敲三下")] })] }));
    expect(sources.find((s) => s.focus === "林澈")).toMatchObject({ cat: "chars", items: ["林澈 阿澈", "身份：邮差", "年龄：二十七"] });
    expect(sources.find((s) => s.focus === "潮汐钟")).toMatchObject({ cat: "story", catLabel: "设定" });
    expect(sources.find((s) => s.cat === "rules")?.items).toEqual(["短句", "不写血腥"]);
    expect(sources.find((s) => s.cat === "uncarded")?.items).toEqual(["老周 周叔", "旧邮局"]);
    expect(bibleSearchSources(null)).toEqual([]);
  });

  it("⌘K 人物带身份，主角标主角；@ 候选含账里没建卡的人", () => {
    expect(paletteCharactersOf(bibleView())).toEqual([{ name: "林澈", role: "主角" }, { name: "许微", role: "灯塔看守" }]);
    expect(mentionNamesOf(bibleView())).toEqual({ characters: ["林澈", "许微", "老周"], locations: ["雾港灯塔"] });
  });

  it("名字速览：卡名、别名、账里称呼都能认（单字不认），带关系和现状", () => {
    const [lin] = namePeekCardsOf(bibleView({ characters: [entry({ id: "k-1", name: "林澈", aliases: ["澈"], fields: [field("身份", "邮差")] }, {
      ledgerAliases: ["小林"],
      now: [{ attribute: "在哪", value: "灯塔", chapter: 3 }],
      relations: [{ id: "r-1", other: "许微", label: "旧同学", by: "ai" }],
    })] }));
    expect(lin).toEqual({ name: "林澈", terms: ["林澈", "小林"], protagonist: false, lines: ["身份：邮差"], relations: ["和许微：旧同学"], now: ["在哪：灯塔"] });
  });
});
