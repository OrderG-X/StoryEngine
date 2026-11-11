/**
 * 记东西那遍交完以后「章末对一遍」（写作版本 P4b 设计 2.4）。
 *
 * 评测拆解（2026-11-08）：持有人算错的三成多是记账员漏记——记过在哪、漏了后来那次挪动；声明了这样东西、从没记它在哪；
 * 已有的东西本章写到了、一条没记。这里按它刚交的条目把本章写到的东西章末在哪一样一行列给它看，再列已有的东西里叫法原样出现在
 * 本章正文、却一条没记的，请它逐样对正文补记。补的条目接在已记的后面编 seq，照常整批核；这一问没成就照第一遍的交。
 *
 * 只动交回来的 JSON（自家格式），不判断正文意思：列哪几样、补不补都由模型对着原文定。
 */
import type { BookProjection, TextUnit } from "@actalk/story-core";
import { asList, extractJsonObject, insideField } from "./keeper-parse.js";

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined);
const isDigit = (char: string): boolean => char >= "0" && char <= "9";

/** 一列最多几样（东西多的章只列前面这些，免得这一问比正文还长）。 */
export const ITEM_CHECK_MAX_LISTED = 40;
/** 「本章正文出现了叫法、一条没记」那段最多几样。 */
export const ITEM_CHECK_MAX_UNRECORDED = 20;
/** 一样东西列几处句号。 */
const UNITS_SHOWN = 6;
/** 叫法太短（一个字）不拿来找：「盘」「袋」处处都是。 */
const MIN_NAME_CHARS = 2;

/** 「I3」「n2」：自家短号（字母 + 数字），统一成大写；别的写法 → undefined。 */
function handleOf(value: unknown): string | undefined {
  const raw = isRecord(value) ? (value.item ?? value.id) : value;
  const text = str(raw)?.toUpperCase();
  if (!text || text.length < 2) return undefined;
  if (text[0] !== "I" && text[0] !== "N" && text[0] !== "P") return undefined;
  return [...text.slice(1)].every(isDigit) ? text : undefined;
}

const unitOf = (raw: Raw): number | undefined => {
  const value = Array.isArray(raw.unit) ? raw.unit[0] : raw.unit;
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" && [...value.trim()].every(isDigit) ? Number(value.trim()) : undefined;
  return number !== undefined && Number.isInteger(number) && number >= 1 ? number : undefined;
};

const seqOf = (raw: Raw): number | undefined => {
  const value = typeof raw.seq === "number" ? raw.seq : typeof raw.seq === "string" && [...raw.seq.trim()].every(isDigit) && raw.seq.trim() !== "" ? Number(raw.seq.trim()) : undefined;
  return value !== undefined && Number.isInteger(value) && value >= 1 ? value : undefined;
};

/** 去处一句（照交回来的写法读；读不出 → undefined）。 */
function placeText(raw: unknown, nameOf: (handle: string) => string): string | undefined {
  if (str(raw)?.toLowerCase() === "unknown") return "不知道在哪";
  if (!isRecord(raw)) return undefined;
  const person = str(raw.person);
  if (person) return `${person}拿着`;
  const place = str(raw.place);
  if (place) return `在${place}`;
  const inside = raw.inside ?? (raw.person === undefined && raw.place === undefined ? raw.item : undefined);
  const handle = handleOf(inside);
  if (handle) return `在${nameOf(handle)}里`;
  if (typeof inside === "string" && inside.trim()) return `在${inside.trim()}`;
  return undefined;
}

interface Listed {
  readonly handle: string;
  readonly name: string;
  readonly end?: { readonly text: string; readonly unit?: number };
  readonly units: readonly number[];
}

/**
 * 按交回来的 JSON 算每样东西本章末在哪（只是给模型看的摘要，不是投影）：按 seq、同号按交的先后，最后一下说了算；
 * 清点给的「在某样里面」也算一下。没有一条说它在哪 → 没有 end。
 */
export function listItemEnds(root: Raw, handleNames: ReadonlyMap<string, string>): Listed[] {
  const declared = new Map<string, { name: string; unit?: number }>();
  for (const raw of asList(root.newItems)) {
    if (!isRecord(raw)) continue;
    const handle = handleOf(raw.tag);
    const name = str(raw.name);
    if (handle && name && !declared.has(handle)) declared.set(handle, { name, ...(unitOf(raw) ? { unit: unitOf(raw) as number } : {}) });
  }
  const nameOf = (handle: string): string => declared.get(handle)?.name ?? handleNames.get(handle) ?? handle;
  const order: string[] = [...declared.keys()];
  const units = new Map<string, number[]>();
  const ends = new Map<string, { text: string; unit?: number }>();
  const see = (handle: string, unit: number | undefined) => {
    if (!order.includes(handle)) order.push(handle);
    if (unit !== undefined) units.set(handle, [...new Set([...(units.get(handle) ?? []), unit])].sort((a, b) => a - b));
  };
  for (const [handle, info] of declared) see(handle, info.unit);
  const steps = asList(root.items)
    .map((raw, index) => ({ raw, index }))
    .filter((step): step is { raw: Raw; index: number } => isRecord(step.raw))
    .sort((a, b) => (seqOf(a.raw) ?? Number.MAX_SAFE_INTEGER) - (seqOf(b.raw) ?? Number.MAX_SAFE_INTEGER) || a.index - b.index);
  for (const { raw } of steps) {
    const handle = handleOf(raw.item);
    if (!handle) continue;
    const unit = unitOf(raw);
    see(handle, unit);
    const op = str(raw.op)?.toLowerCase();
    if (op === "census") {
      for (const member of asList(raw.members)) {
        const memberHandle = handleOf(member);
        if (!memberHandle || memberHandle === handle) continue;
        see(memberHandle, unit);
        ends.set(memberHandle, { text: `在${nameOf(handle)}里（清点）`, ...(unit ? { unit } : {}) });
      }
      continue;
    }
    if (op === "gone") {
      const gone = str(raw.gone)?.toLowerCase();
      ends.set(handle, { text: gone === "destroyed" ? "毁了" : "丢了", ...(unit ? { unit } : {}) });
      continue;
    }
    const where = placeText(raw.to, nameOf);
    if (where) ends.set(handle, { text: where, ...(unit ? { unit } : {}) });
  }
  return order.map((handle) => {
    const end = ends.get(handle);
    return { handle, name: nameOf(handle), ...(end ? { end } : {}), units: units.get(handle) ?? [] };
  });
}

/**
 * 已有的东西里，名字或叫法原样出现在本章正文、交回来的条目却一条没提到的：编号、名字、前文记的现在、出现在哪几句。
 * 只按已有的名字找原句（列给模型看），不据此认东西。
 */
export function unrecordedMentions(
  before: BookProjection,
  itemHandles: ReadonlyMap<string, string>,
  handleNames: ReadonlyMap<string, string>,
  used: ReadonlySet<string>,
  units: readonly TextUnit[],
  nowText: (id: string) => string | undefined,
): { readonly handle: string; readonly name: string; readonly now?: string; readonly units: readonly number[] }[] {
  const byId = new Map(before.items.map((item) => [item.id, item] as const));
  const out: { handle: string; name: string; now?: string; units: number[] }[] = [];
  for (const [handle, id] of itemHandles) {
    if (used.has(handle)) continue;
    const item = byId.get(id);
    if (!item) continue;
    const names = [...new Set([item.name, ...item.mentions].filter((name): name is string => typeof name === "string" && [...name].length >= MIN_NAME_CHARS))];
    // 不猜白名单：找原句
    const hits = units.filter((unit) => names.some((name) => unit.text.includes(name))).map((unit) => unit.id);
    if (hits.length === 0) continue;
    const now = nowText(id);
    out.push({ handle, name: handleNames.get(handle) ?? item.name ?? handle, ...(now ? { now } : {}), units: hits });
  }
  return out.slice(0, ITEM_CHECK_MAX_UNRECORDED);
}

const unitList = (units: readonly number[]): string =>
  units.length === 0 ? "" : `第 ${units.slice(0, UNITS_SHOWN).join("、")}${units.length > UNITS_SHOWN ? " 等" : ""} 句`;

/**
 * 只动写成东西号的那几处（声明的 tag、条目的 item、去处 / 从哪来里解析当成「装在哪样里面」的、清点成员），
 * 和解析同一把尺子；人名、地方、叫法里碰巧写成「N1」的不碰。fn 返回换成的号（不换 → 原样）。
 */
function mapItemRefs(root: Raw, fn: (handle: string) => string): Raw {
  const ref = (value: unknown): unknown => {
    if (typeof value === "string") {
      const handle = handleOf(value);
      return handle ? fn(handle) : value;
    }
    if (!isRecord(value)) return value;
    // 和解析 itemRefOf 同一个取法：item ?? id（item 写成 null 就看 id）。
    const key = value.item !== undefined && value.item !== null ? "item" : value.id !== undefined && value.id !== null ? "id" : undefined;
    return key ? { ...value, [key]: ref(value[key]) } : value;
  };
  const place = (value: unknown): unknown => {
    if (!isRecord(value) || insideField(value) === undefined) return value;
    return value.inside !== undefined && value.inside !== null && value.inside !== "" ? { ...value, inside: ref(value.inside) } : { ...value, item: ref(value.item) };
  };
  const list = (value: unknown, each: (raw: Raw) => Raw): unknown => (Array.isArray(value) ? value.map((raw) => (isRecord(raw) ? each(raw) : raw)) : isRecord(value) ? each(value) : value);
  return {
    ...root,
    newItems: list(root.newItems, (raw) => (raw.tag !== undefined ? { ...raw, tag: ref(raw.tag) } : raw)),
    items: list(root.items, (raw) => ({
      ...raw,
      ...(raw.item !== undefined ? { item: ref(raw.item) } : {}),
      ...(raw.to !== undefined ? { to: place(raw.to) } : {}),
      ...(raw.from !== undefined ? { from: place(raw.from) } : {}),
      ...(raw.members !== undefined ? { members: Array.isArray(raw.members) ? raw.members.map(ref) : ref(raw.members) } : {}),
    })),
  };
}

/** 交回来的 JSON 里用到的全部 N 号（声明的、只引用没声明的都算；只看写东西号的那几处）。 */
function usedNewTags(root: Raw): Set<string> {
  const out = new Set<string>();
  mapItemRefs(root, (handle) => {
    if (handle.startsWith("N")) out.add(handle);
    return handle;
  });
  return out;
}

/** 下一个没用过的 N 号的数字（第一遍用了没声明的也算用过）。 */
export function nextNewTag(root: Raw): number {
  let max = 0;
  for (const handle of usedNewTags(root)) max = Math.max(max, Number(handle.slice(1)));
  return max + 1;
}

/** 章末对一遍那条 user 消息（单测也用）。列不出东西 → undefined（不问）。 */
export function buildItemCheckTask(
  listed: readonly Listed[],
  unrecorded: readonly { readonly handle: string; readonly name: string; readonly now?: string; readonly units: readonly number[] }[],
  nextTag: number,
): string | undefined {
  if (listed.length === 0 && unrecorded.length === 0) return undefined;
  const shown = listed.slice(0, ITEM_CHECK_MAX_LISTED);
  const lines = shown.map((item) => {
    const end = item.end ? `章末：${item.end.text}${item.end.unit ? `（第 ${item.end.unit} 句）` : ""}` : "章末：本章没记它在哪";
    const where = unitList(item.units);
    return `${item.handle} ${item.name} · ${end}${where ? ` · 你记它的句子：${where}` : ""}`;
  });
  const more = listed.length > shown.length ? [`（另有 ${listed.length - shown.length} 样没列）`] : [];
  const second = unrecorded.map((item) => `${item.handle} ${item.name}${item.now ? ` · 前文记的现在：${item.now}` : ""} · 本章${unitList(item.units)}出现它的叫法`);
  const sections = [
    ["【对一遍章末】下面是按你刚交的条目，本章写到的每样东西章末在哪：", ...lines, ...more],
    second.length > 0 ? ["【已有的东西里，叫法在本章正文出现、你却一条没记的】", ...second] : [],
    [
      "逐样回到正文，看它在本章最后出现的那几句：",
      "1. 章末其实不在这儿（后面又拿起、放下、揣起、递给谁、装进哪儿）：补记那几下，最后落到哪儿那一下一定要有；",
      "2. 写着「本章没记它在哪」、正文其实写了它在哪（挂在身上、搁在桌上、拿在手里、装在哪个里面）：补一条 at；",
      "3. 第二段那几样：正文写到的确实是这一样、而且挪了或写了它在哪的，补记；只是同名的别的东西、或者只是嘴上提一句的，不管；",
      `4. 一个号其实是正文里的两样东西（比如两串钥匙、两只袋子）：在 newItems 里声明另一样（号从 N${nextTag} 起往后排），补记它的去向；原来那个号章末不对的，也补一条它真正的去向。`,
      "补的条目写法和前面一样（unit 写第几句，by、to、from、gone、members 照前面的规矩）；不写 seq，按故事里发生的先后排，补的都排在本章已记的之后。都对就交空的。",
    ],
    ['只交 JSON：{"newItems":[],"items":[]}'],
  ];
  return sections.filter((section) => section.length > 0).map((section) => section.join("\n")).join("\n\n");
}

/**
 * 把章末对一遍交回来的并进第一遍：交回来的声明了第一遍用过的 N 号（声明过的、只引用的都算），整份交回来的里一起换成
 * 两边都没用过的号；items 接在本章已记的最大 seq 后面按交回来的先后编号。写坏的条目（不是对象）原样并进去，
 * 解析时照常记成丢了一条（这章东西没记全），不在这里悄悄滤掉。什么都没补 → 第一遍原样。交回来的不是 JSON 对象 → undefined。
 */
export function mergeItemCheck(first: Raw, reply: string): { readonly root: Raw; readonly added: number } | undefined {
  const extra = extractJsonObject(reply);
  if (!extra) return undefined;
  if (asList(extra.newItems).length === 0 && asList(extra.items).length === 0) return { root: first, added: 0 };
  const firstUsed = usedNewTags(first);
  const taken = new Set([...firstUsed, ...usedNewTags(extra)]);
  let next = 1;
  const rename = new Map<string, string>();
  for (const raw of asList(extra.newItems)) {
    const handle = isRecord(raw) ? handleOf(raw.tag) : undefined;
    if (!handle || !handle.startsWith("N") || !firstUsed.has(handle) || rename.has(handle)) continue;
    while (taken.has(`N${next}`)) next += 1;
    rename.set(handle, `N${next}`);
    taken.add(`N${next}`);
  }
  const renamed = rename.size > 0 ? mapItemRefs(extra, (handle) => rename.get(handle) ?? handle) : extra;
  const maxSeq = asList(first.items).reduce<number>((max, raw) => Math.max(max, isRecord(raw) ? (seqOf(raw) ?? 0) : 0), 0);
  const addedItems = asList(renamed.items).map((raw, index) => (isRecord(raw) ? { ...raw, seq: maxSeq + index + 1 } : raw));
  const addedNew = asList(renamed.newItems);
  return {
    root: { ...first, newItems: [...asList(first.newItems), ...addedNew], items: [...asList(first.items), ...addedItems] },
    added: addedItems.length + addedNew.length,
  };
}

/**
 * 用到了没声明的 N 号、那条写了 as（正文里的叫法）和 unit 的：按头一条替它声明（name = 那个叫法，unit = 那一句），
 * 不再整条丢（P4b 设计 2.1）。只认主体和解析时真当成「装在哪样里面」的那处（`insideField`，和解析同一把尺子：
 * 写了 kind = person / place 的去处里多塞的 item 不算）。
 */
export function declareUsedNewTags(root: Raw): { readonly root: Raw; readonly declared: readonly string[] } {
  const known = new Set(asList(root.newItems).flatMap((raw) => (isRecord(raw) && handleOf(raw.tag) ? [handleOf(raw.tag) as string] : [])));
  const added: Raw[] = [];
  const consider = (ref: unknown, as: unknown, entry: Raw) => {
    const handle = handleOf(ref);
    if (!handle || !handle.startsWith("N") || known.has(handle)) return;
    const name = str(as) ?? (isRecord(ref) ? str(ref.as) : undefined);
    const unit = unitOf(entry);
    if (!name || unit === undefined) return;
    known.add(handle);
    added.push({ tag: handle, name, unit, by: entry.by ?? "narration", ...(str(entry.speaker) ? { speaker: entry.speaker } : {}) });
  };
  for (const raw of asList(root.items)) {
    if (!isRecord(raw)) continue;
    consider(raw.item, raw.as, raw);
    for (const key of ["to", "from"] as const) {
      const place = raw[key];
      const inside = insideField(place);
      if (inside === undefined) continue;
      // {"item":"N3","as":"木盒"}：叫法写在去处上；{"inside":{"item":"N3","as":"木盒"}}：写在它自己身上。
      const fromItemField = isRecord(place) && (place.inside === undefined || place.inside === null || place.inside === "");
      consider(inside, fromItemField && isRecord(place) ? place.as : undefined, raw);
    }
  }
  if (added.length === 0) return { root, declared: [] };
  return { root: { ...root, newItems: [...asList(root.newItems), ...added] }, declared: added.map((raw) => raw.tag as string) };
}
