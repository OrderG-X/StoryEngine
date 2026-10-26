// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BibleEntry, BibleView, Card, CardField, CardOp } from "../../../api/bibleClient.js";

const saveCards = vi.fn<(projectPath: string, ops: readonly CardOp[]) => Promise<{ ok: true; lines: string[] } | { ok: false; error: string }>>();
vi.mock("../../../api/bibleClient.js", () => ({ saveCards: (projectPath: string, ops: readonly CardOp[]) => saveCards(projectPath, ops) }));

const { BibleBook } = await import("./BibleBook.js");
const { bibleNavCounts, bibleSearchSources, mentionNamesOf, namePeekCardsOf, paletteCharactersOf } = await import("./bibleIndex.js");
const { PresenceStrip, graphLayout } = await import("./bibleVisual.js");



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
    canon: [],
    protagonist: "林澈",
    ...over,
  };
}

type Cat = Parameters<typeof BibleBook>[0]["cat"];

function renderBook(cat: Cat, over: { bible?: BibleView; busy?: boolean; focusName?: string; chapterCount?: number } = {}) {
  const reload = vi.fn();
  const onChanged = vi.fn();
  const onJump = vi.fn();
  const onOpenCat = vi.fn();
  const onAction = vi.fn();
  const view = render(
    <BibleBook cat={cat} projectPath="/books/fog" bible={over.bible ?? bibleView()} error={null} reload={reload} busy={over.busy ?? false}
      onChanged={onChanged} onJump={onJump} onOpenCat={onOpenCat} onAction={onAction} {...(over.focusName ? { focusName: over.focusName } : {})}
      {...(over.chapterCount !== undefined ? { chapterCount: over.chapterCount } : {})} />,
  );
  return { ...view, reload, onChanged, onJump, onOpenCat, onAction };
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

  it("存成了的提示：整句引文收尾不再补句号；几秒后自己收起（没存成的留着）", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      saveCards.mockResolvedValue({ ok: true, lines: ["记下定论「长风镖局一共有三匹老马。」"] });
      renderBook("story");
      fireEvent.click(screen.getByRole("button", { name: "删掉「题材」" }));
      expect(await screen.findByRole("status")).toHaveProperty("textContent", "记下定论「长风镖局一共有三匹老马。」可在操作历史里撤销。");
      await vi.advanceTimersByTimeAsync(6000);
      await waitFor(() => expect(screen.queryByText("记下定论「长风镖局一共有三匹老马。」可在操作历史里撤销。")).toBeNull());
    } finally {
      vi.useRealTimers();
    }
  });

  it("没改成：如实说原因，不重读、不刷新", async () => {
    saveCards.mockResolvedValue({ ok: false, error: "没改设定：AI 正在改这本书，等它做完再试。" });
    const { reload, onChanged } = renderBook("story");
    fireEvent.click(screen.getByRole("button", { name: "删掉「题材」" }));
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "没改设定：AI 正在改这本书，等它做完再试。");
    expect(reload).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("存完、设定本重读回来才收起编辑框（不闪改前的字）；没存成框留着，写的字不丢", async () => {
    let finishReload: () => void = () => undefined;
    const reload = vi.fn(() => new Promise<void>((resolve) => { finishReload = resolve; }));
    render(<BibleBook cat="canon" projectPath="/books/fog" bible={bibleView({ canon: [{ id: "n-1", text: "杜长顺十年前去世", at: AT }] })} error={null} reload={reload} busy={false} />);
    fireEvent.click(screen.getByRole("button", { name: "杜长顺十年前去世" }));
    fireEvent.change(screen.getByLabelText("改这条定论"), { target: { value: "杜长顺九年前去世" } });
    fireEvent.keyDown(screen.getByLabelText("改这条定论"), { key: "Enter" });
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText("改这条定论")).toHaveProperty("value", "杜长顺九年前去世");
    finishReload();
    await waitFor(() => expect(screen.queryByLabelText("改这条定论")).toBeNull());

    saveCards.mockResolvedValue({ ok: false, error: "没改设定：AI 正在改这本书，等它做完再试。" });
    fireEvent.click(screen.getByRole("button", { name: "杜长顺十年前去世" }));
    fireEvent.change(screen.getByLabelText("改这条定论"), { target: { value: "杜长顺八年前去世" } });
    fireEvent.keyDown(screen.getByLabelText("改这条定论"), { key: "Enter" });
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "没改设定：AI 正在改这本书，等它做完再试。");
    expect(screen.getByLabelText("改这条定论")).toHaveProperty("value", "杜长顺八年前去世");
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

  it("还没建卡：作者说「不用建卡」的收到最底下一行，点开能放回；人物页和左边的数都不算它", async () => {
    renderBook("uncarded");
    const row = screen.getByRole("button", { name: /旧邮局/u }).closest("article") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "不用建卡" }));
    await waitFor(() => expect(lastOps()).toEqual([{ op: "uncarded.skip", name: "旧邮局" }]));
    cleanup();
    const skippedBible = bibleView({
      uncarded: [
        { name: "老周", aliases: ["周叔"], character: true, skipped: true, appearances: { chapters: [2], first: 2, last: 2, viewpointChapters: 0 }, now: [], fixed: [] },
        { name: "旧邮局", aliases: [], character: false, now: [], fixed: [] },
      ],
    });
    renderBook("uncarded", { bible: skippedBible });
    expect(screen.queryByRole("button", { name: "建人物卡" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "不用建卡的 1 个" }));
    fireEvent.click(screen.getByRole("button", { name: "放回" }));
    await waitFor(() => expect(lastOps()).toEqual([{ op: "uncarded.unskip", name: "老周" }]));
    expect(bibleNavCounts(skippedBible).uncarded).toBe(1);
    cleanup();
    renderBook("chars", { bible: skippedBible });
    expect(screen.queryByRole("button", { name: /没建卡/u })).toBeNull();
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

  it("定论（P12）：一条一行，点字改、删要点两下、「查前文」在右边出定论卡；没有时说怎么来", async () => {
    const empty = renderBook("canon");
    expect(screen.getByText(/核账卡上点「以第 N 章为准」/)).toBeTruthy();
    empty.unmount();
    const { onAction } = renderBook("canon", { bible: bibleView({ canon: [{ id: "n-1", text: "杜长顺十年前去世", at: AT }] }) });
    fireEvent.click(screen.getByRole("button", { name: "查前文" }));
    expect(onAction).toHaveBeenCalledWith({ toolName: "settle_preview", statement: "杜长顺十年前去世" });
    fireEvent.click(screen.getByRole("button", { name: "杜长顺十年前去世" }));
    const box = screen.getByLabelText("改这条定论");
    fireEvent.change(box, { target: { value: "杜长顺九年前去世" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(lastOps()).toEqual([{ op: "canon.set", canon: "n-1", text: "杜长顺九年前去世" }]));
    fireEvent.click(screen.getByRole("button", { name: "删" }));
    fireEvent.click(screen.getByRole("button", { name: "确定删" }));
    await waitFor(() => expect(lastOps()).toEqual([{ op: "canon.set", canon: "n-1", text: "" }]));
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

describe("设定本的样子（卡片墙、扉页、关系图）", () => {
  it("故事设定扉页：没写「一句话」点占位就写；「题材」「基调」是小签，没写的点「+」补", async () => {
    renderBook("story", { bible: bibleView({ story: [field("世界规矩", "没有超自然")] }) });
    fireEvent.click(screen.getByRole("button", { name: "一句话写下这本书讲什么" }));
    const box = screen.getByLabelText("一句话");
    fireEvent.change(box, { target: { value: "雾港的邮差收到一封十年前的信。" } });
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    await waitFor(() => expect(lastOps()).toEqual([{ op: "story.set", label: "一句话", value: "雾港的邮差收到一封十年前的信。" }]));
    fireEvent.click(screen.getByRole("button", { name: "+ 基调" }));
    const tone = screen.getByLabelText("基调");
    fireEvent.change(tone, { target: { value: "冷、慢" } });
    fireEvent.keyDown(tone, { key: "Enter", metaKey: true });
    await waitFor(() => expect(lastOps()).toEqual([{ op: "story.set", label: "基调", value: "冷、慢" }]));
    // 扉页摆了的栏不再出现在「+ 加一项」的快捷里
    fireEvent.click(screen.getByRole("button", { name: "+ 加一项" }));
    expect(screen.queryByRole("button", { name: "题材" })).toBeNull();
    expect(screen.getByRole("button", { name: "主线冲突" })).toBeTruthy();
  });

  it("人物卡：没点开时露出第一栏和出场条；点开后关系签点了打开那个人", () => {
    const { container } = renderBook("chars", { chapterCount: 8 });
    expect(screen.getByRole("button", { name: /林澈.*邮差/u, expanded: false })).toBeTruthy();
    const strip = container.querySelector(".se-bk-strip");
    expect(strip?.getAttribute("viewBox")).toBe("0 0 8 1");
    expect(strip?.querySelectorAll("rect")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: /林澈/u, expanded: false }));
    fireEvent.click(screen.getByRole("button", { name: /许微.*旧同学/u }));
    expect(screen.getByRole("button", { name: /许微/u, expanded: true })).toBeTruthy();
    expect(screen.getByRole("button", { name: /林澈/u, expanded: false })).toBeTruthy();
  });

  it("关系图：主角在中间，点图里的人打开那张卡（地点去地点页）", () => {
    const { onOpenCat } = renderBook("relations", { bible: bibleView({ relations: [
      { id: "r-1", a: "林澈", b: "许微", label: "旧同学", by: "ai" },
      { id: "r-2", a: "许微", b: "雾港灯塔", label: "在这儿值夜班", by: "author" },
    ] }) });
    expect(screen.getByRole("img", { name: "关系图" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "打开「许微」" }));
    expect(onOpenCat).toHaveBeenLastCalledWith("chars", "许微");
    fireEvent.keyDown(screen.getByRole("button", { name: "打开「雾港灯塔」" }), { key: "Enter" });
    expect(onOpenCat).toHaveBeenLastCalledWith("places", "雾港灯塔");
  });

  it("关系图排法：主角居中，和主角有关系的先上圈；人多只画关系最多的 12 个，如实报剩几个", () => {
    const rel = (id: string, a: string, b: string) => ({ id, a, b, label: "认识", by: "author" as const });
    const small = graphLayout([rel("1", "甲", "乙"), rel("2", "乙", "丙"), rel("3", "主", "丙")], "主", 640);
    expect(small.nodes.map((node) => [node.name, node.center])).toEqual([["主", true], ["丙", false], ["甲", false], ["乙", false]]);
    const many = Array.from({ length: 15 }, (_, i) => rel(`m${i}`, "主", `人${i}`));
    const big = graphLayout([...many, rel("x", "人14", "人13")], "主", 640);
    expect(big.nodes).toHaveLength(12);
    expect(big.hidden).toBe(4);
    expect(big.nodes.map((node) => node.name)).toContain("人14");
    expect(big.edges.every((edge) => big.nodes.some((node) => node.name === edge.a) && big.nodes.some((node) => node.name === edge.b))).toBe(true);
    expect(graphLayout([rel("1", "甲", "乙")], "没人", 640).nodes[0]?.center).toBe(true);
  });

  it("页头：右边摆几个数（0 不摆）；一类卡一张没有时给一句怎么建", () => {
    renderBook("chars");
    expect(screen.getByText("张卡").closest("dl")?.textContent).toBe("张卡2待认下1出过场1");
    cleanup();
    renderBook("relations", { bible: bibleView({ relations: [{ id: "r-1", a: "林澈", b: "许微", label: "旧同学", by: "author" }] }) });
    expect(screen.getByText("条关系").closest("dl")?.textContent).toBe("条关系1");
    cleanup();
    renderBook("items");
    expect(screen.getByText("还没有物品卡。点「+ 新物品」建一张，或者在右边让 AI 补。")).toBeTruthy();
    expect(screen.queryByText("张卡")).toBeNull();
  });

  it("点开的卡：头上一张名片（名字、也叫、操作），收起按钮收回去", () => {
    renderBook("chars", { focusName: "林澈" });
    fireEvent.click(screen.getByRole("button", { name: "收起「林澈」" }));
    expect(screen.getByRole("button", { name: /林澈/u, expanded: false })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "删卡" })).toBeNull();
  });

  it("左边分类后面的数", () => {
    expect(bibleNavCounts(bibleView())).toEqual({ canon: 0, chars: 2, relations: 1, items: 0, places: 1, uncarded: 2 });
    expect(bibleNavCounts(null)).toEqual({});
  });

  it("出场条：全书多长画多长，只亮出场的章；没出场不画", () => {
    const { container, rerender } = render(<PresenceStrip chapters={[2, 5]} total={4} />);
    expect(container.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 5 1");
    expect(container.querySelectorAll("rect")).toHaveLength(2);
    rerender(<PresenceStrip chapters={[]} total={4} />);
    expect(container.querySelector("svg")).toBeNull();
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
