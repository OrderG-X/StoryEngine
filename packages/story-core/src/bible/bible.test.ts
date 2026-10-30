import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBible } from "../index.js";
import { runCommand } from "../commands/runner.js";
import { project } from "../projection/project.js";
import { emptySettingCards, type SettingCardsFile } from "../schema/cards.js";
import type { ChapterLedger, ReviewMark } from "../schema/ledger.js";
import { ledgerOf, type EntryDraft } from "../ledger/entries.js";
import { readCards, readHead } from "../store/book.js";
import { readLegacyCards } from "../import/legacy-cards.js";
import { cardFill, cardsImport, cardWrite } from "./commands.js";
import { applyCardOps, splitForAi, type CardOp } from "./ops.js";
import { bibleView } from "./view.js";

const AT = "2026-10-19T08:00:00.000Z";
const NOW = new Date(AT);

function apply(file: SettingCardsFile, ops: CardOp[], by: "author" | "ai" = "author"): SettingCardsFile {
  const outcome = applyCardOps(file, ops, { by, at: AT });
  if (!outcome.ok) throw new Error(`${outcome.code} ${outcome.message}`);
  return outcome.file;
}

describe("改设定卡（ops）", () => {
  it("作者建卡、写字段、改名：写下的都算作者的；给人看的话里只有名字", () => {
    const outcome = applyCardOps(emptySettingCards(), [
      { op: "card.create", kind: "character", name: "许微", fields: [{ label: "身份", value: "夜班分拣员" }], protagonist: true },
      { op: "field.set", card: "许微", label: "外貌", value: "身形偏瘦" },
      { op: "card.aliases", card: "许微", add: ["小微"] },
      { op: "card.rename", card: "小微", name: "许薇" },
    ], { by: "author", at: AT });
    if (!outcome.ok) throw new Error(outcome.message);
    const card = outcome.file.cards[0]!;
    // 改名后旧名留作别名：按旧名记的账还认得是这个人。
    expect(card).toMatchObject({ name: "许薇", aliases: ["小微", "许微"], protagonist: true, by: "author" });
    expect(card.fields.map((field) => [field.label, field.value, field.by])).toEqual([["身份", "夜班分拣员", "author"], ["外貌", "身形偏瘦", "author"]]);
    expect(outcome.lines).toEqual(["建了人物卡「许微」（主角）", "「许微」的「外貌」写上了", "「许微」加了别名「小微」", "「许微」改名为「许薇」，旧名留作别名"]);
    expect(outcome.lines.join("")).not.toContain("k-");
  });

  it("卡名和别名全书不重复", () => {
    const file = apply(emptySettingCards(), [{ op: "card.create", kind: "character", name: "孟叔", aliases: ["孟庆山"] }]);
    const outcome = applyCardOps(file, [{ op: "card.create", kind: "place", name: "孟庆山" }], { by: "author", at: AT });
    expect(outcome).toMatchObject({ ok: false, code: "invalid" });
  });

  it("AI：能建新卡、填空的、改自己补的；碰作者写的停下要作者点头", () => {
    let file = apply(emptySettingCards(), [{ op: "card.create", kind: "character", name: "许微", fields: [{ label: "年龄", value: "二十九" }] }]);
    file = apply(file, [{ op: "field.set", card: "许微", label: "外貌", value: "瘦" }, { op: "card.create", kind: "item", name: "铜钥匙" }], "ai");
    expect(file.cards[0]!.fields.find((field) => field.label === "外貌")?.by).toBe("ai");
    file = apply(file, [{ op: "field.set", card: "许微", label: "外貌", value: "瘦，常穿工装" }], "ai");
    expect(file.cards[0]!.fields.find((field) => field.label === "外貌")?.value).toBe("瘦，常穿工装");
    const blocked = applyCardOps(file, [{ op: "field.set", card: "许微", label: "年龄", value: "三十" }], { by: "ai", at: AT });
    expect(blocked).toMatchObject({ ok: false, code: "needs_author" });
    expect(applyCardOps(file, [{ op: "card.delete", card: "许微" }], { by: "ai", at: AT })).toMatchObject({ ok: false, code: "needs_author" });
    expect(applyCardOps(file, [{ op: "card.delete", card: "铜钥匙" }], { by: "ai", at: AT })).toMatchObject({ ok: true });
    expect(applyCardOps(file, [{ op: "field.accept", card: "许微" }], { by: "ai", at: AT })).toMatchObject({ ok: false, code: "needs_author" });
  });

  // 长篇实跑第 39 章：「还没建卡」攒到 61 条（车队、字条、老汉……），作者没法说「这个不用建」。
  it("不用建卡：只有作者能说；已有卡的不收；放回去；后来建了卡就从里面拿掉", () => {
    let file = apply(emptySettingCards(), [{ op: "card.create", kind: "character", name: "沈砚" }]);
    const skipped = applyCardOps(file, [{ op: "uncarded.skip", name: "车队" }, { op: "uncarded.skip", name: "车队" }], { by: "author", at: AT });
    expect(skipped.ok && skipped.lines).toEqual(["「车队」不用建卡"]);
    file = skipped.ok ? skipped.file : file;
    expect(file.skipped).toEqual(["车队"]);
    expect(applyCardOps(file, [{ op: "uncarded.skip", name: "老汉" }], { by: "ai", at: AT })).toMatchObject({ ok: false, code: "needs_author" });
    expect(applyCardOps(file, [{ op: "uncarded.skip", name: "沈砚" }], { by: "author", at: AT })).toMatchObject({ ok: false, code: "invalid" });
    const back = applyCardOps(file, [{ op: "uncarded.unskip", name: "车队" }], { by: "author", at: AT });
    expect(back.ok && back.file.skipped).toEqual([]);
    expect(back.ok && back.lines).toEqual(["「车队」放回「还没建卡」"]);
    expect(apply(file, [{ op: "card.create", kind: "lore", name: "押镖队伍", aliases: ["车队"] }]).skipped).toEqual([]);
  });

  it("作者认下 AI 补的：变成作者的，AI 以后就改不了", () => {
    let file = apply(emptySettingCards(), [{ op: "card.create", kind: "place", name: "三号仓", fields: [{ label: "样子", value: "铁皮库房" }] }], "ai");
    file = apply(file, [{ op: "field.accept", card: "三号仓" }]);
    expect(file.cards[0]).toMatchObject({ by: "author", fields: [{ label: "样子", by: "author" }] });
    expect(applyCardOps(file, [{ op: "field.set", card: "三号仓", label: "样子", value: "砖房" }], { by: "ai", at: AT })).toMatchObject({ code: "needs_author" });
  });

  it("定论只能作者记：AI 提的交给作者；按编号或原文改、空串删", () => {
    const file = apply(emptySettingCards(), [{ op: "canon.add", text: "杜长顺十年前去世" }, { op: "canon.add", text: "杜长顺十年前去世" }]);
    expect(file.canon).toEqual([{ id: "n-1", text: "杜长顺十年前去世", at: AT }]);
    expect(applyCardOps(file, [{ op: "canon.add", text: "R 是船名缩写" }], { by: "ai", at: AT })).toMatchObject({ ok: false, code: "needs_author" });
    expect(splitForAi(file, [{ op: "canon.add", text: "R 是船名缩写" }], AT).needsAuthor).toHaveLength(1);
    const renamed = applyCardOps(file, [{ op: "canon.set", canon: "n-1", text: "杜长顺十年前病逝" }], { by: "author", at: AT });
    expect(renamed.ok && renamed.lines).toEqual(["定论「杜长顺十年前去世」改成「杜长顺十年前病逝」"]);
    // 长的只露个头，不把整条前后各抄一遍。
    const long = "杜长顺十年前病逝，葬在城北义庄后头的山坡上，坟前有一棵歪脖子枣树";
    const lengthened = applyCardOps(renamed.ok ? renamed.file : file, [{ op: "canon.set", canon: "n-1", text: long }], { by: "author", at: AT });
    expect(lengthened.ok && lengthened.lines).toEqual(["改了定论「杜长顺十年前病逝」"]);
    const again = applyCardOps(lengthened.ok ? lengthened.file : file, [{ op: "canon.set", canon: "n-1", text: `${long}。` }], { by: "author", at: AT });
    expect(again.ok && again.lines).toEqual([`改了定论「${long.slice(0, 24)}…」`]);
    const removed = apply(renamed.ok ? renamed.file : file, [{ op: "canon.set", canon: "杜长顺十年前病逝", text: "" }]);
    expect(removed.canon).toEqual([]);
  });

  it("splitForAi：能做的直接做，碰作者的交给作者，跟着它的一起交", () => {
    const file = apply(emptySettingCards(), [{ op: "card.create", kind: "character", name: "孟叔", fields: [{ label: "身份", value: "老站长" }] }]);
    const split = splitForAi(file, [
      { op: "field.set", card: "孟叔", label: "外貌", value: "花白头发" },
      { op: "card.rename", card: "孟叔", name: "孟庆山" },
      { op: "field.set", card: "孟庆山", label: "说话方式", value: "慢" },
      { op: "card.create", kind: "item", name: "台账" },
    ], AT);
    expect(split.direct.map((op) => op.op)).toEqual(["field.set", "card.create"]);
    expect(split.needsAuthor.map((item) => item.op.op)).toEqual(["card.rename", "field.set"]);
    expect(split.invalid).toEqual([]);
  });

  it("关系：一句话、两头都认；删卡连关系一起删", () => {
    let file = apply(emptySettingCards(), [
      { op: "card.create", kind: "character", name: "许微" },
      { op: "card.create", kind: "character", name: "许建平" },
      { op: "relation.set", a: "许建平", b: "许微", label: "父女（许建平是父亲）" },
    ]);
    file = apply(file, [{ op: "relation.set", a: "许微", b: "许建平", label: "父女，十五年没见" }]);
    expect(file.relations).toHaveLength(1);
    expect(file.relations[0]!.label).toBe("父女，十五年没见");
    file = apply(file, [{ op: "card.delete", card: "许建平" }]);
    expect(file.relations).toEqual([]);
  });

  it("主角只有一个；AI 只能在还没有主角时标", () => {
    let file = apply(emptySettingCards(), [{ op: "card.create", kind: "character", name: "甲" }, { op: "card.create", kind: "character", name: "乙" }]);
    file = apply(file, [{ op: "card.protagonist", card: "甲" }], "ai");
    expect(applyCardOps(file, [{ op: "card.protagonist", card: "乙" }], { by: "ai", at: AT })).toMatchObject({ code: "needs_author" });
    file = apply(file, [{ op: "card.protagonist", card: "乙" }]);
    expect(file.cards.filter((card) => card.protagonist).map((card) => card.name)).toEqual(["乙"]);
  });

  it("写作规则：标量、列表、样本；字数收数字串，删用空", () => {
    let file = apply(emptySettingCards(), [
      { op: "rules.set", field: "targetWords", value: "2500" },
      { op: "rules.set", field: "perspective", value: "第三人称，紧跟许微" },
      { op: "rules.add", list: "bans", text: "不写超自然" },
      { op: "exemplar.add", text: "雾从海上漫进来的时候，邮局的钟停了。", note: "开头" },
    ]);
    expect(file.rules).toMatchObject({ targetWords: { value: 2500 }, perspective: { value: "第三人称，紧跟许微" }, bans: [{ text: "不写超自然" }], exemplars: [{ id: "e-1" }] });
    expect(applyCardOps(file, [{ op: "rules.remove", list: "bans", text: "不写超自然" }], { by: "ai", at: AT })).toMatchObject({ code: "needs_author" });
    file = apply(file, [{ op: "rules.set", field: "targetWords", value: 0 }, { op: "exemplar.remove", exemplar: "雾从海上漫进来的时候" }]);
    expect(file.rules.targetWords).toBeUndefined();
    expect(file.rules.exemplars).toEqual([]);
  });

  it("什么都没变就不出话", () => {
    const file = apply(emptySettingCards(), [{ op: "story.set", label: "题材", value: "悬疑" }]);
    const outcome = applyCardOps(file, [{ op: "story.set", label: "题材", value: "悬疑" }], { by: "author", at: AT });
    expect(outcome).toMatchObject({ ok: true, lines: [] });
  });
});

type Draft = EntryDraft extends infer E ? (E extends EntryDraft ? Omit<E, "review"> & { readonly id?: string; readonly review?: ReviewMark } : never) : never;

function ledger(chapter: number, drafts: Draft[]): ChapterLedger {
  return ledgerOf({ chapter, committedAt: AT, entries: drafts.map((draft) => ({ review: "auto", ...draft }) as EntryDraft & { id?: string }) });
}

const presence = (name: string, nameUsed = name, viewpoint?: boolean): Draft => ({ kind: "presence", name, nameUsed, quote: `${nameUsed}来了`, ...(viewpoint ? { viewpoint } : {}) });
const fact = (nature: "hard" | "state", subject: string, attribute: string, value: string): Draft => ({
  kind: "fact", nature, subject, attribute, value, text: `${subject}${attribute}${value}`, quote: `${subject}${value}`,
});

describe("设定视图", () => {
  const projection = project({
    ledgers: [
      ledger(1, [presence("许微", "许微", true), presence("孟庆山", "孟叔"), fact("state", "铜钥匙", "在哪", "孟叔抽屉里"), fact("hard", "许微", "年龄", "二十九")]),
      ledger(2, [presence("许微", "许微", true), presence("韩德胜"), fact("state", "铜钥匙", "在哪", "许微随身带着"), fact("state", "许微", "在哪", "三号仓")]),
    ],
    decisions: [],
  });

  it("卡对上账：出场、现状（最新一章）、定下的、账里用过的称呼", () => {
    const cards = apply(emptySettingCards(), [
      { op: "card.create", kind: "character", name: "许微", protagonist: true },
      { op: "card.create", kind: "character", name: "孟庆山" },
      { op: "card.create", kind: "item", name: "铜钥匙", fields: [{ label: "规矩", value: "只开三号仓" }] },
      { op: "relation.set", a: "孟庆山", b: "许微", label: "看着许微长大的老站长" },
    ]);
    const view = bibleView(projection, cards);
    expect(view.protagonist).toBe("许微");
    const xu = view.characters[0]!;
    expect(xu.card.name).toBe("许微");
    expect(xu.appearances).toMatchObject({ chapters: [1, 2], first: 1, last: 2, viewpointChapters: 2 });
    expect(xu.now).toEqual([{ attribute: "在哪", value: "三号仓", chapter: 2, quote: "许微三号仓" }]);
    expect(xu.fixed.map((item) => item.value)).toEqual(["二十九"]);
    expect(xu.relations).toEqual([{ id: "r-1", other: "孟庆山", label: "看着许微长大的老站长", by: "author" }]);
    expect(view.characters[1]!.ledgerAliases).toEqual(["孟叔"]);
    expect(view.items[0]!.now.map((item) => item.value)).toEqual(["许微随身带着"]);
  });

  it("账里有、卡里没有的列出来：出场的人一定是人物，别的主体不分类", () => {
    const view = bibleView(projection, apply(emptySettingCards(), [{ op: "card.create", kind: "character", name: "许微" }]));
    expect(view.uncarded.map((item) => [item.name, item.character])).toEqual([["孟庆山", true], ["韩德胜", true], ["铜钥匙", false]]);
    expect(view.uncarded[0]!.aliases).toEqual(["孟叔"]);
  });

  it("作者说不用建卡的：照样在「还没建卡」里（写稿、在场检测还要用账里记的），只是标上不用建", () => {
    const view = bibleView(projection, apply(emptySettingCards(), [{ op: "uncarded.skip", name: "孟叔" }, { op: "uncarded.skip", name: "铜钥匙" }]));
    expect(view.uncarded.map((item) => [item.name, item.skipped === true])).toEqual([["许微", false], ["孟庆山", true], ["韩德胜", false], ["铜钥匙", true]]);
  });

  // 长篇实跑：「刀疤军官」改名「韩照」、旧名留作别名，设定本里韩照只算第 20、22 章，「刀疤军官」还单列在账里记的。
  it("卡的名字和别名在账里是几个人：都归这张卡（出场并起来、账并起来）", () => {
    const renamed = project({
      ledgers: [
        ledger(1, [presence("刀疤军官"), fact("hard", "刀疤军官", "姓名", "韩照"), fact("state", "刀疤军官", "立场", "放行")]),
        ledger(3, [presence("韩照"), fact("state", "韩照", "立场", "只看箱子"), fact("state", "韩照", "在哪", "溪弯")]),
      ],
      decisions: [],
    });
    const view = bibleView(renamed, apply(emptySettingCards(), [{ op: "card.create", kind: "character", name: "韩照", aliases: ["刀疤军官"] }]));
    expect(view.uncarded).toEqual([]);
    const han = view.characters[0]!;
    expect(han.appearances).toMatchObject({ chapters: [1, 3], first: 1, last: 3 });
    expect(han.fixed.map((item) => item.value)).toEqual(["韩照"]);
    expect(han.now.map((item) => [item.attribute, item.value])).toEqual([["立场", "只看箱子"], ["在哪", "溪弯"]]);
  });
});

let book: string;
beforeEach(async () => {
  book = await mkdtemp(join(tmpdir(), "story-core-bible-"));
});
afterEach(async () => {
  await rm(book, { recursive: true, force: true });
});

async function put(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(join(book, path)), { recursive: true });
  await writeFile(join(book, path), typeof value === "string" ? value : JSON.stringify(value));
}

/** 一本老格式书的设定文件：模板占位话、会变的字段、自定义字段都有。 */
async function legacyCards(): Promise<void> {
  await put("story/character-bible.json", {
    version: "v0",
    characters: [
      {
        id: "char-a", name: "许微", role: "主角", identity: "夜班分拣员", age: "二十九岁", desire: "弄清父亲失踪的真相",
        relationshipToProtagonist: "主角本人", personalityBaseline: ["记性好"], knowledgeKnown: ["父亲失踪"], knowledgeUnknown: ["信从哪来"],
        trustLevel: "high", extraFields: { 口头禅: "再说吧" },
      },
      { id: "char-b", name: "许建平", role: "许微的父亲", identity: "许微的父亲，港务局职员", relationshipToProtagonist: "许微的亲生父亲", relationshipDynamics: ["十五年前失踪"] },
    ],
  });
  await put("characters/char-a/profile.json", { id: "char-a", name: "许微", identity: "protagonist", appearanceAnchors: ["身形偏瘦"], tags: ["main-character"] });
  await put("characters/char-a/core.json", { characterId: "char-a", personality: ["自主行动"], speechStyle: "自然" });
  await put("characters/char-a/state.json", { characterId: "char-a", emotion: "平静", goal: "进入故事开篇情境", currentLocationName: "邮局" });
  await put("story/location-bible.json", {
    version: "v0",
    locations: [{ id: "loc-1", name: "雾港邮政局", type: "老城公共建筑", currentStatus: "夜里亮着灯", knownFeatures: [], risks: ["夜班人少"], resources: [], extraFields: { 位置: "老城区", 状态: "营业中" } }],
  });
  await put("story/assets.json", { version: "v0", assets: [{ id: "asset-1", name: "怪信", status: "在许微手中", ownerName: "许微", usageRules: ["邮戳是上周的"] }], containers: [] });
  await put("story/bible.json", { version: "v0", projectLogline: "主角进入一个等待展开的故事世界。", premise: "主角进入一个等待展开的故事世界。", genre: "长篇故事", subgenres: [], readerPromise: "主角进入一个等待展开的故事世界。", longFormGoals: [], centralConflicts: [], coreMysteries: [], forbiddenChanges: [], canonFacts: [], openQuestions: [] });
  await put("story/core.json", { readerPromise: "主角进入一个等待展开的故事世界。", tone: "沉浸", targetEmotion: "好奇", pacingStyle: "状态驱动的长篇连载推进" });
  await put("world/core.json", { genre: "长篇故事", premise: "主角进入一个等待展开的故事世界。", rules: [], mainConflict: "主角第一次遭遇与故事核心设定相关的明显阻力。" });
  await put("world/state.json", { currentPhase: "开篇", activeConflicts: ["许微想追查"], activeHooks: [], knownSecrets: [] });
  await put("story/world-bible.json", { version: "v0", rules: ["无超自然力量"], factions: [], powerOrSurvivalSystems: ["邮局掌握信件记录"], historyFacts: ["十五年前沉船"], socialOrder: [], resourceRules: ["邮局掌握信件记录"] });
  await put("story/writing-rules.json", {
    version: "v0", narrativePerspective: "第三人称有限视角", proseStyle: ["沉浸", "状态感知", "冷峻克制"], chapterLength: { targetWords: 2500, minWords: 2200 },
    pacing: "中等", revealPolicy: "均衡", genreRequirements: [], suspenseRules: [], payoffRules: [], reversalRules: [], readerExperienceRules: [], forbiddenContent: [],
    doNotDo: ["草稿阶段不要改写正式状态。", "没有正文证据时不要解决长期伏笔。", "不写血腥"],
  });
}

describe("搬老设定", () => {
  it("搬不会变的、自定义字段；丢会变的和模板占位话；关系按原话；主角带标记", async () => {
    await legacyCards();
    const { file, found, counts } = await readLegacyCards(book, AT);
    expect(found).toBe(true);
    expect(counts).toMatchObject({ characters: 2, places: 1, items: 1, relations: 1 });
    const [xu, father] = file.cards;
    expect(xu).toMatchObject({ name: "许微", protagonist: true, by: "author" });
    expect(Object.fromEntries(xu!.fields.map((field) => [field.label, field.value]))).toEqual({
      身份: "夜班分拣员",
      年龄: "二十九岁",
      外貌: "身形偏瘦",
      性格: "记性好",
      想要什么: "弄清父亲失踪的真相",
      还没揭开的: "信从哪来",
      口头禅: "再说吧",
    });
    expect(father!.fields.map((field) => field.label)).toEqual(["身份", "人际"]);
    expect(file.relations).toEqual([{ id: "r-1", a: father!.id, b: xu!.id, label: "许微的亲生父亲", by: "author", at: AT }]);
    const place = file.cards.find((card) => card.kind === "place")!;
    expect(place.fields.map((field) => field.label)).toEqual(["类型", "要注意", "位置"]);
    const item = file.cards.find((card) => card.kind === "item")!;
    expect(item.fields.map((field) => [field.label, field.value])).toEqual([["规矩", "邮戳是上周的"]]);
    expect(file.story.fields.map((field) => [field.label, field.value])).toEqual([["世界规矩", "无超自然力量"], ["体系", "邮局掌握信件记录"], ["历史", "十五年前沉船"]]);
    expect(file.rules).toMatchObject({ style: [{ text: "冷峻克制" }], targetWords: { value: 2500 }, minWords: { value: 2200 }, bans: [{ text: "不写血腥" }], musts: [] });
    expect(file.rules.perspective).toBeUndefined();
  });

  it("只剩模板话的占位主角不搬（以后按视角章建议真名）", async () => {
    await put("story/character-bible.json", { version: "v0", characters: [{ id: "char-x", name: "主角", role: "主角", desire: "进入开篇情境并面对核心变化", speechRules: [], behaviorBoundaries: [] }] });
    const { file } = await readLegacyCards(book, AT);
    expect(file.cards).toEqual([]);
  });

  it("cards.import 写 cards.json、只做一次；坏掉的老文件跳过并记下来", async () => {
    await legacyCards();
    await put("story/assets.json", "{坏的");
    const first = await runCommand(book, cardsImport, {}, { caller: "author", idempotencyKey: "cards-import:open", now: () => NOW });
    if (!first.ok) throw new Error(first.message);
    expect(first.result.imported).toBe(true);
    expect(first.result.skipped).toEqual([{ file: "story/assets.json", reason: "不是合法的 JSON，没搬" }]);
    expect((await readCards(book))?.cards.map((card) => card.name)).toEqual(["许微", "许建平", "雾港邮政局"]);
    expect(await readFile(join(book, "story/character-bible.json"), "utf-8")).toContain("char-a");
    const again = await runCommand(book, cardsImport, {}, { caller: "author", idempotencyKey: "cards-import:again", now: () => NOW });
    expect(again).toMatchObject({ ok: false, code: "already_imported" });
  });
});

describe("设定卡命令", () => {
  it("card.write：作者档、幂等、版本号 +1；AI 调不了", async () => {
    const args = { ops: [{ op: "card.create", kind: "character", name: "许微" }] };
    const ai = await runCommand(book, cardWrite, args, { caller: "ai", idempotencyKey: "k1" });
    expect(ai).toMatchObject({ ok: false, code: "author_only" });
    const first = await runCommand(book, cardWrite, args, { caller: "author", idempotencyKey: "k1", now: () => NOW });
    expect(first).toMatchObject({ ok: true, version: 1, changed: { cards: true }, result: { lines: ["建了人物卡「许微」"] } });
    const replay = await runCommand(book, cardWrite, args, { caller: "author", idempotencyKey: "k1", now: () => NOW });
    expect(replay).toMatchObject({ ok: true, replayed: true });
    expect((await readHead(book)).version).toBe(1);
  });

  it("card.fill：记成 AI 补的；碰作者写的整批不做", async () => {
    await runCommand(book, cardWrite, { ops: [{ op: "card.create", kind: "character", name: "许微", fields: [{ label: "年龄", value: "二十九" }] }] }, { caller: "author", idempotencyKey: "k1", now: () => NOW });
    const filled = await runCommand(book, cardFill, { ops: [{ op: "field.set", card: "许微", label: "外貌", value: "瘦" }] }, { caller: "ai", now: () => NOW });
    expect(filled).toMatchObject({ ok: true });
    expect((await readCards(book))?.cards[0]?.fields.find((field) => field.label === "外貌")?.by).toBe("ai");
    const blocked = await runCommand(book, cardFill, {
      ops: [{ op: "field.set", card: "许微", label: "身高", value: "一米六" }, { op: "field.set", card: "许微", label: "年龄", value: "三十" }],
    }, { caller: "ai", now: () => NOW });
    expect(blocked).toMatchObject({ ok: false, code: "needs_author" });
    expect(blocked.ok ? "" : blocked.message).toContain("第 2 步");
    expect((await readCards(book))?.cards[0]?.fields.map((field) => field.label)).toEqual(["年龄", "外貌"]);
  });

  it("还没迁的老书：第一次改先拼上老设定，不丢", async () => {
    await legacyCards();
    const outcome = await runCommand(book, cardWrite, { ops: [{ op: "story.set", label: "题材", value: "现实悬疑" }] }, { caller: "author", idempotencyKey: "k1", now: () => NOW });
    expect(outcome.ok).toBe(true);
    const cards = await readCards(book);
    expect(cards?.cards.map((card) => card.name)).toEqual(["许微", "许建平", "雾港邮政局", "怪信"]);
    expect(cards?.story.fields.at(-1)).toMatchObject({ label: "题材", value: "现实悬疑" });
  });

  it("readBible：没有 cards.json 时现拼老设定，不写盘", async () => {
    await legacyCards();
    const { bible } = await readBible(book);
    expect(bible.protagonist).toBe("许微");
    expect(await readCards(book)).toBeUndefined();
  });
});
