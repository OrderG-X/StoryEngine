/**
 * 记账员交回的 JSON → 新核心的账单条目（重构 P3）。
 *
 * 工具边界 = 契约层：任何合理模型可能交的退化值都在这里归一（`""` / `[]` / `0` / `"False"` / 数字写成字符串 /
 * 短号大小写和空格 / 一条推进挂好几个短号），归一不了的逐条丢、记原因，绝不整份作废、绝不静默。
 * 只有抠不出 JSON 对象才算整份失败（返回 undefined）。
 *
 * 只认精确的词表（op、类型、星期、是 / 否），不做模糊匹配；短号由调用方给的 handles 换回真编号。
 * 这里不核原句、不判断前文有没有这条线索——那是 story-core 的 checkEntries 的事，核不上的会如实列出来。
 */
import type {
  BoundaryOffsets,
  CensusMemberInput,
  DeclaredSource,
  EntryInput,
  EntryKind,
  FactInput,
  ItemGone,
  ItemInput,
  ItemPlaceInput,
  ItemRefInput,
  PresenceInput,
  SegmentInput,
  SummaryInput,
  ThreadInput,
  TimeInput,
  TimeOffset,
} from "@actalk/story-core";

export interface KeeperDrop {
  /** 哪一类、第几条（从 1 起），如「facts 第 3 条」。 */
  readonly where: string;
  readonly reason: string;
  /** 丢的那条是哪个（线索标题等，给作者看的名字）：认得出才有，作者好知道是哪条没记上。 */
  readonly name?: string;
  /** 丢的是东西那类（P3b）：这章东西账因此没记全，定稿时记成 partial、缺 item。 */
  readonly kind?: EntryKind;
}

export interface KeeperParseResult {
  readonly entries: readonly EntryInput[];
  /** 丢掉的条目或字段，带原因（预览里如实给作者看）。 */
  readonly drops: readonly KeeperDrop[];
  /** 改动过的条目（比如缺字段的事实降为「发生过的事」），带原因。 */
  readonly adjusted: readonly KeeperDrop[];
}

export interface KeeperHandles {
  readonly threadHandles: ReadonlyMap<string, string>;
  readonly factHandles: ReadonlyMap<string, string>;
  /** 短号 → 给作者看的名字（线索标题、事实内容）：模型在说明里写了「归入T1」，换成名字再进清单。 */
  readonly handleNames?: ReadonlyMap<string, string>;
  /** 重定稿：「R2」→ 这一章上次定稿时开的线索真编号（本章还在开，就沿用编号，后文的推进才接得上）。 */
  readonly reopenHandles?: ReadonlyMap<string, string>;
  /** 「I3」→ 东西真编号（【已有的东西】）。 */
  readonly itemHandles?: ReadonlyMap<string, string>;
  /** 重定稿：「P2」→ 这一章上次定稿时新记的东西真编号。 */
  readonly reopenItemHandles?: ReadonlyMap<string, string>;
}

const isDigit = (char: string | undefined): boolean => char !== undefined && char >= "0" && char <= "9";
const isAsciiWord = (char: string | undefined): boolean =>
  char !== undefined && ((char >= "a" && char <= "z") || (char >= "A" && char <= "Z") || isDigit(char));

/**
 * 说明文字里混进的短号（「并入T1」「同F3」）换成它指的名字：短号是这次调用里我们自己发的编号，
 * 只换认得的、前后不粘着英文字母数字的；认不得的原样留着。
 */
export function nameHandles(text: string, names: ReadonlyMap<string, string> | undefined): string {
  if (!names || names.size === 0) return text;
  let out = "";
  let i = 0;
  while (i < text.length) {
    const char = text[i]!;
    const letter = char.toUpperCase();
    if ((letter === "T" || letter === "F" || letter === "R" || letter === "I" || letter === "P") && isDigit(text[i + 1]) && !isAsciiWord(text[i - 1])) {
      let end = i + 1;
      while (isDigit(text[end])) end += 1;
      const name = isAsciiWord(text[end]) ? undefined : names.get(`${letter}${text.slice(i + 1, end)}`);
      out += name ? `「${name}」` : text.slice(i, end);
      i = end;
      continue;
    }
    out += char;
    i += 1;
  }
  return out;
}

type Raw = Record<string, unknown>;

/** 从模型输出里取第一个 `{` 到最后一个 `}`，解析成对象。 */
export function extractJsonObject(text: string): Raw | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Raw) : undefined;
  } catch {
    return undefined;
  }
}

const isRecord = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);

/** 原句：模型有时把换行写成字面的反斜杠 n（多转义了一层），换回空白，代码核对时本来就不看空白。 */
export function quoteText(value: unknown): string | undefined {
  const text = str(value);
  return text === undefined ? undefined : str(text.split("\\r").join(" ").split("\\n").join(" ").split("\\t").join(" "));
}

/** 字符串去空白；空串、非字符串 → undefined（数字照转成字符串）。 */
function str(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const CHINESE_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

/** 整数（可负）：数字、数字字符串、单个中文数字（零～十，前面可带负号）。其余 → undefined。 */
function integer(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isInteger(value) ? value : undefined;
  const text = str(value);
  if (text === undefined) return undefined;
  const negative = text.startsWith("-") || text.startsWith("－");
  const body = negative ? text.slice(1).trim() : text;
  if (body in CHINESE_DIGITS) return (negative ? -1 : 1) * (CHINESE_DIGITS[body] as number);
  const parsed = Number(text);
  return Number.isInteger(parsed) ? parsed : undefined;
}

const UNITS: Record<string, TimeOffset["unit"]> = { day: "day", days: "day", d: "day", 天: "day", 日: "day", month: "month", months: "month", 月: "month", 个月: "month", year: "year", years: "year", 年: "year" };
/** 单位比同不同：认得的按天、月、年比（「天」和 day 一样），认不出的按原样比。 */
const unitKey = (raw: unknown): string | undefined => {
  const text = str(raw)?.toLowerCase();
  return text === undefined ? undefined : (UNITS[text] ?? text);
};
/** 相对多少的上限（和核心一样，±一百年）。 */
const MAX_OFFSET = 36500;

/**
 * 相对多少：`{unit, min, max}`；只写一个数（`value` / `days`，或整个就是个数）= 两头一样；unit 缺 = 天。
 * 两头都没有、倒了、超界、单位认不出 → 字符串（原因）。
 */
function offsetOf(value: unknown): TimeOffset | string {
  if (typeof value === "number" || typeof value === "string") {
    const n = integer(value);
    return n === undefined ? "相对多少不是整数" : offsetOf({ min: n, max: n });
  }
  if (!isRecord(value)) return "相对多少写得不对";
  // 按换天规矩各写的那份里又套了一层 offset（照着 start 的写法套的）：拆开，外层写了的单位照留（里层另写了单位就对不上，不收）。
  if (value.offset !== undefined && value.min === undefined && value.max === undefined && value.value === undefined && value.days === undefined) {
    const inner = isRecord(value.offset) ? value.offset : { value: value.offset };
    if (value.unit === undefined) return offsetOf(inner);
    if (inner.unit !== undefined && unitKey(inner.unit) !== unitKey(value.unit)) return "相对多少里外写的单位不一样";
    return offsetOf({ ...inner, unit: value.unit });
  }
  const unitText = str(value.unit)?.toLowerCase();
  const unit = unitText === undefined ? "day" : UNITS[unitText];
  if (!unit) return `单位写成了「${unitText}」，认不出（只认天、月、年）`;
  const single = integer(value.value ?? value.days);
  const min = integer(value.min) ?? single;
  const max = integer(value.max) ?? single;
  if (min === undefined && max === undefined) return "相对多少两头都没写";
  if ([min, max].some((side) => side !== undefined && Math.abs(side) > MAX_OFFSET)) return "相对多少超出了一百年";
  if (min !== undefined && max !== undefined && min > max) return "相对多少的两头倒了";
  return { unit, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
}

/** 一处相对：offset 或 byBoundary（两种换天规矩各一份，只用天）。两样都给了按 byBoundary（更细）。复核星期那步也用。 */
export function relativeOf(raw: Raw): { offset: TimeOffset } | { byBoundary: BoundaryOffsets } | string {
  if (raw.byBoundary !== undefined && raw.byBoundary !== null) {
    const both = isRecord(raw.byBoundary) ? raw.byBoundary : {};
    const midnight = offsetOf(both.midnight);
    const dawn = offsetOf(both.dawn);
    if (typeof midnight === "string" || typeof dawn === "string") return `按换天规矩各写的那两份不对：${typeof midnight === "string" ? midnight : dawn}`;
    if (midnight.unit !== "day" || dawn.unit !== "day") return "按换天规矩各写的只能是天数";
    return { byBoundary: { midnight, dawn } };
  }
  if (raw.offset === undefined || raw.offset === null || raw.offset === "") return "没写相对多少";
  const offset = offsetOf(raw.offset);
  return typeof offset === "string" ? offset : { offset };
}

const FRAMES: Record<string, SegmentInput["frame"]> = {
  past: "past", flashback: "past", memory: "past", recall: "past", 回忆: "past", 倒叙: "past",
  other: "other", dream: "other", imagination: "other", rumor: "other", story: "other", 梦: "other", 想象: "other", 传闻: "other",
};
const NARRATION_WORDS = new Set(["narration", "narrator", "叙述"]);
const CLAIM_WORDS = new Set(["claim", "character", "character_claim", "speech", "人物说的"]);

/** 事实、线索的来源：speaker = 人物说的；source = narration = 叙述直接写的；拿不准不标。 */
function sourceOf(item: Raw): DeclaredSource | undefined {
  const speaker = str(item.speaker);
  const kind = str(item.source)?.toLowerCase();
  // 说话人那栏写的是「叙述」这个格式词（模型把来源填错了栏）：照叙述记，不当成一个叫「叙述」的人说的。
  if (speaker && NARRATION_WORDS.has(speaker.toLowerCase())) return { kind: "narration" };
  if (speaker) return { kind: "character_claim", speaker };
  if (kind && NARRATION_WORDS.has(kind)) return { kind: "narration" };
  // 明说是人物说的、没写是谁：照人物说的记（不改现状、不收线索），说话人空着。
  if (kind && CLAIM_WORDS.has(kind)) return { kind: "character_claim" };
  return undefined;
}

const TRUE_WORDS = new Set(["true", "yes", "y", "1", "是", "对"]);
const FALSE_WORDS = new Set(["false", "no", "n", "0", "否", "不是", "不"]);

export function flag(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  const text = str(value)?.toLowerCase();
  if (text === undefined) return undefined;
  if (TRUE_WORDS.has(text)) return true;
  if (FALSE_WORDS.has(text)) return false;
  return undefined;
}

/** 星期：只认中文写法（0 = 周一 … 6 = 周日）。数字分不清从周日还是周一数，不收。 */
const WEEKDAYS: Record<string, number> = {};
for (const [index, day] of ["一", "二", "三", "四", "五", "六", "日"].entries()) {
  for (const prefix of ["周", "星期", "礼拜"]) WEEKDAYS[`${prefix}${day}`] = index;
}
WEEKDAYS["周天"] = 6;
WEEKDAYS["星期天"] = 6;
WEEKDAYS["礼拜天"] = 6;

const NATURES = new Set(["hard", "state", "event"]);
const THREAD_OPS: Record<string, ThreadInput["op"]> = {
  open: "open", new: "open", introduced: "open", opened: "open",
  advance: "advance", advanced: "advance", progress: "advance", progressed: "advance",
  close: "close", closed: "close", resolved: "close", resolve: "close", done: "close", completed: "close",
};
const THREAD_TYPES: Record<string, NonNullable<ThreadInput["type"]>> = {
  question: "question", lead: "question", mystery: "question", 悬念: "question", 问题: "question",
  intent: "intent", plan: "intent", todo: "intent", 打算: "intent", 待办: "intent",
  goal: "goal", 目标: "goal",
};

/** 「T3」「t3」「 T3 」都认；一条里写了几个（数组，或用顿号 / 逗号 / 空格隔开）就拆开。 */
function handleList(value: unknown): string[] {
  const parts: string[] = [];
  const push = (raw: unknown): void => {
    const text = str(raw);
    if (text === undefined) return;
    let current = "";
    for (const char of text) {
      if (char === "、" || char === "," || char === "，" || char === " " || char === "/" || char === ";" || char === "；") {
        if (current) parts.push(current);
        current = "";
      } else current += char;
    }
    if (current) parts.push(current);
  };
  if (Array.isArray(value)) value.forEach(push);
  else push(value);
  return parts.map((part) => part.toUpperCase());
}

function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) return [value];
  return [];
}

export function parseKeeperOutput(text: string, handles: KeeperHandles): KeeperParseResult | undefined {
  const root = extractJsonObject(text);
  if (!root) return undefined;
  const entries: EntryInput[] = [];
  const drops: KeeperDrop[] = [];
  const adjusted: KeeperDrop[] = [];
  const drop = (where: string, reason: string, name?: string, kind?: EntryKind): void => {
    drops.push({ where, reason, ...(name ? { name } : {}), ...(kind ? { kind } : {}) });
  };
  const named = (value: string | undefined): string | undefined => (value === undefined ? undefined : nameHandles(value, handles.handleNames));

  // —— 梗概 ——
  if (root.summary !== undefined && root.summary !== null) {
    const raw = isRecord(root.summary) ? root.summary : {};
    const summary = named(str(raw.text) ?? str(raw.summary));
    const quote = quoteText(raw.quote);
    // 没附原句的照样交上去（quote 空着）：补摘那一步会请记账员补一句，补不上由核对如实列为没记上。
    if (summary) entries.push({ kind: "summary", review: "auto", text: summary, quote: quote ?? "" } satisfies SummaryInput);
    else drop("summary", "梗概是空的");
  }

  // —— 时间、段 ——
  const time = parseTime(root, drop, adjusted);
  if (time) entries.push(time);

  // —— 出场 ——
  for (const [index, item] of asList(root.presence).entries()) {
    const where = `presence 第 ${index + 1} 条`;
    if (!isRecord(item)) {
      drop(where, "不是对象");
      continue;
    }
    const name = str(item.name);
    const nameUsed = str(item.nameUsed) ?? name;
    const quote = quoteText(item.quote);
    if (!name || !nameUsed) {
      drop(where, "没写名字");
      continue;
    }
    const presence: { -readonly [K in keyof PresenceInput]: PresenceInput[K] } = { kind: "presence", review: "auto", name, nameUsed, quote: quote ?? "" };
    if (flag(item.viewpoint) === true) presence.viewpoint = true;
    if (flag(item.generic) === true && nameUsed !== name) presence.generic = true;
    entries.push(presence);
  }

  // —— 事实 ——
  for (const [index, item] of asList(root.facts).entries()) {
    const where = `facts 第 ${index + 1} 条`;
    if (!isRecord(item)) {
      drop(where, "不是对象");
      continue;
    }
    const factText = named(str(item.text));
    const quote = quoteText(item.quote);
    if (!factText) {
      drop(where, "事实没写内容");
      continue;
    }
    let nature = str(item.nature)?.toLowerCase();
    if (!nature || !NATURES.has(nature)) {
      if (nature) adjusted.push({ where, reason: `nature 写成了「${nature}」，按「发生过的事」记` });
      nature = "event";
    }
    const subject = str(item.subject);
    const attribute = str(item.attribute);
    const value = str(item.value);
    if ((nature === "hard" || nature === "state") && (!subject || !attribute || !value)) {
      adjusted.push({ where, reason: "会变 / 不会变的事实缺主体、方面或值，按「发生过的事」记" });
      nature = "event";
    }
    const fact: { -readonly [K in keyof FactInput]: FactInput[K] } = {
      kind: "fact",
      review: "auto",
      nature: nature as FactInput["nature"],
      text: factText,
      quote: quote ?? "",
    };
    if (subject) fact.subject = subject;
    if (nature !== "event") {
      fact.attribute = attribute;
      fact.value = value;
    }
    const replaces: string[] = [];
    for (const handle of handleList(item.replaces)) {
      const id = handles.factHandles.get(handle);
      if (id) {
        if (!replaces.includes(id)) replaces.push(id);
      } else drop(`${where}.replaces`, "要推翻的那条不在列出的事实里，这一项没记（事实本身照记）");
    }
    if (replaces.length > 0) fact.replaces = replaces;
    const source = sourceOf(item);
    if (source) fact.source = source;
    // 主体是一样东西（P3b）：指哪样（I / N / P 号）。
    if (item.item !== undefined && item.item !== null && item.item !== "") {
      const ref = itemRefOf(item.item, undefined, handles);
      if (ref) fact.item = ref;
      else {
        drop(where, "说的是哪样东西没写对，这条没记", undefined, "fact");
        continue;
      }
    }
    entries.push(fact);
  }

  // —— 线索 ——
  for (const [index, item] of asList(root.threads).entries()) {
    const where = `threads 第 ${index + 1} 条`;
    if (!isRecord(item)) {
      drop(where, "不是对象");
      continue;
    }
    const opText = str(item.op)?.toLowerCase();
    const op = opText ? THREAD_OPS[opText] : undefined;
    const note = named(str(item.note) ?? str(item.title));
    const quote = quoteText(item.quote);
    if (!op) {
      drop(where, opText ? `op 写成了「${opText}」，认不出` : "没写 op（开 / 推进 / 收）");
      continue;
    }
    if (!note) {
      const target = handleList(item.thread).map((handle) => handles.handleNames?.get(handle)).find((name) => name !== undefined);
      drop(where, "没写这一章对它做了什么", target);
      continue;
    }
    if (op === "open") {
      const title = named(str(item.title));
      const typeText = str(item.type);
      const type = typeText ? (THREAD_TYPES[typeText.toLowerCase()] ?? THREAD_TYPES[typeText]) : undefined;
      if (!title) {
        drop(where, "新开的线索没有标题");
        continue;
      }
      if (!type && typeText) adjusted.push({ where, reason: `类型写成了「${typeText}」，按悬念记` });
      // 重定稿沿用上次的编号：只认这次列出的 R 短号，别的写法当新开（核心再按标题兜一次）。
      const reopen = handleList(item.thread).map((handle) => handles.reopenHandles?.get(handle)).find((id) => id !== undefined);
      const source = sourceOf(item);
      entries.push({ kind: "thread", review: "auto", op, type: type ?? "question", title, note, quote: quote ?? "", ...(reopen ? { thread: reopen } : {}), ...(source ? { source } : {}) } satisfies ThreadInput);
      continue;
    }
    const targets = handleList(item.thread);
    if (targets.length === 0) {
      drop(where, op === "close" ? "收口没写收的是哪条线索" : "推进没写推进的是哪条线索");
      continue;
    }
    const seen = new Set<string>();
    const source = sourceOf(item);
    for (const handle of targets) {
      // 短号对不上：原样交下去，checkEntries 会以「前文没有这条线索」如实列出来。
      // R 短号（这一章上次开的）报成推进 / 收口：换成真编号交下去，定稿编排认得出是这章自己开的那条。
      const thread = handles.threadHandles.get(handle) ?? handles.reopenHandles?.get(handle) ?? handle;
      if (seen.has(thread)) continue;
      seen.add(thread);
      entries.push({ kind: "thread", review: "auto", op, thread, note, quote: quote ?? "", ...(source ? { source } : {}) } satisfies ThreadInput);
    }
  }

  // —— 东西（P3b 设计 2.3）——
  parseItems(root, handles, entries, drop, adjusted);

  return { entries, drops, adjusted };
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** 「I3」「n2」「 P1 」：自家短号（字母 + 数字）；别的写法 → undefined。 */
function itemHandle(value: unknown): { readonly letter: "I" | "N" | "P"; readonly handle: string } | undefined {
  const text = str(value)?.toUpperCase();
  if (!text || text.length < 2) return undefined;
  const letter = text[0];
  if (letter !== "I" && letter !== "N" && letter !== "P") return undefined;
  for (const char of text.slice(1)) if (!isDigit(char)) return undefined;
  return { letter, handle: text };
}

/**
 * 指一样东西：`"I3"` 或 `{ "item": "I3", "as": "本章怎么叫它" }`（as 另给时以另给的为准）。I 号照清单换真编号，认不得的原样交下去
 * （核心以「指的东西前文没有」如实拒）；N / P 号是本批标签。写得认不出 → undefined。
 */
function itemRefOf(raw: unknown, as: unknown, handles: KeeperHandles): ItemRefInput | undefined {
  const record = isRecord(raw) ? raw : undefined;
  const parsed = itemHandle(record ? (record.item ?? record.id) : raw);
  if (!parsed) return undefined;
  const mention = str(as) ?? (record ? str(record.as) : undefined);
  const extra = mention ? { mention } : {};
  if (parsed.letter === "I") return { id: handles.itemHandles?.get(parsed.handle) ?? parsed.handle, ...extra };
  return { tag: parsed.handle, ...extra };
}

/** 旧记法关联：F 号换真编号；对不上的那一项不记（条目照记），如实说。 */
function factLinks(raw: Raw, handles: KeeperHandles, where: string, drop: (where: string, reason: string) => void): { replaces?: string[]; overlaps?: string[] } {
  const out: { replaces?: string[]; overlaps?: string[] } = {};
  for (const key of ["replaces", "overlaps"] as const) {
    const ids: string[] = [];
    for (const handle of handleList(raw[key])) {
      const id = handles.factHandles.get(handle);
      if (id) {
        if (!ids.includes(id)) ids.push(id);
      } else drop(`${where}.${key}`, "要对上的那条旧事实不在列出的事实里，这一项没记（这条照记）");
    }
    if (ids.length > 0) out[key] = ids;
  }
  return out;
}

/** 东西的来源：by / source 写叙述或人物说的，写了 speaker 就是人物说的；都没写 → undefined（核心如实不收）。 */
function itemSourceOf(raw: Raw): DeclaredSource | undefined {
  const by = str(raw.by)?.toLowerCase();
  if (by && NARRATION_WORDS.has(by) && !str(raw.speaker)) return { kind: "narration" };
  if (by && CLAIM_WORDS.has(by)) {
    const speaker = str(raw.speaker);
    return { kind: "character_claim", ...(speaker ? { speaker } : {}) };
  }
  return sourceOf(raw);
}

const ITEM_OPS: Record<string, Exclude<ItemInput["op"], "appear">> = { at: "at", move: "move", moved: "move", gone: "gone", census: "census" };
const GONE: Record<string, ItemGone> = { lost: "lost", 丢了: "lost", destroyed: "destroyed", 毁了: "destroyed" };

/** 去处：{person} / {place} / {inside} / "unknown"（也认 {kind, name|text|item} 的写法）。认不出 → 字符串（原因）。 */
function placeOf(raw: unknown, handles: KeeperHandles): ItemPlaceInput | string {
  const text = str(raw)?.toLowerCase();
  if (text === "unknown" || text === "不知道") return { kind: "unknown" };
  if (!isRecord(raw)) return "去处写得认不出";
  const kind = str(raw.kind)?.toLowerCase();
  const person = str(raw.person) ?? (kind === "person" ? str(raw.name) : undefined);
  const place = str(raw.place) ?? (kind === "place" ? str(raw.text) : undefined);
  const inside = raw.inside ?? (kind === "inside" ? raw.item : undefined);
  const unknown = flag(raw.unknown) === true || kind === "unknown";
  const given = [person, place, inside, unknown || undefined].filter((value) => value !== undefined && value !== null && value !== "");
  if (given.length !== 1) return given.length === 0 ? "去处没写" : "去处写了好几种";
  if (person) return { kind: "person", name: person };
  if (place) return { kind: "place", text: place };
  if (unknown) return { kind: "unknown" };
  const ref = itemRefOf(inside, undefined, handles);
  return ref ? { kind: "inside", item: ref } : "装在哪样东西里面没写对";
}

/**
 * newItems → appear（自己的原句、来源；P 号带上次的编号沿用）；items → at / move / gone / census。
 * 结构上认不出的整条丢、记成东西那类（kind: "item"，这章东西账记成没记全）；缺来源、缺 seq 的照样交下去，由核心如实不收。
 */
function parseItems(
  root: Raw,
  handles: KeeperHandles,
  entries: EntryInput[],
  drop: (where: string, reason: string, name?: string, kind?: EntryKind) => void,
  adjusted: KeeperDrop[],
): void {
  for (const [index, raw] of asList(root.newItems).entries()) {
    const where = `newItems 第 ${index + 1} 条`;
    if (!isRecord(raw)) {
      drop(where, "不是对象", undefined, "item");
      continue;
    }
    const tag = itemHandle(raw.tag);
    const name = str(raw.name);
    if (!tag || tag.letter === "I" || !name) {
      drop(where, !name ? "新东西没写名字" : "新东西的号要写成 N1、P1 这样", name, "item");
      continue;
    }
    const reuse = tag.letter === "P" ? handles.reopenItemHandles?.get(tag.handle) : undefined;
    if (tag.letter === "P" && !reuse) adjusted.push({ where, reason: `${tag.handle} 不在上次新记的东西里，按新的记` });
    const source = itemSourceOf(raw);
    entries.push({
      kind: "item",
      review: "auto",
      op: "appear",
      tag: tag.handle,
      name,
      quote: quoteText(raw.quote) ?? "",
      ...(reuse ? { reuse } : {}),
      ...(source ? { source } : {}),
    } satisfies ItemInput);
  }
  for (const [index, raw] of asList(root.items).entries()) {
    const where = `items 第 ${index + 1} 条`;
    if (!isRecord(raw)) {
      drop(where, "不是对象", undefined, "item");
      continue;
    }
    const opText = str(raw.op)?.toLowerCase();
    const op = opText ? ITEM_OPS[opText] : undefined;
    const item = itemRefOf(raw.item, raw.as, handles);
    const name = item ? handleName(item, handles) : undefined;
    if (!op || !item) {
      drop(where, !op ? (opText ? `op 写成了「${opText}」，认不出（只认 at、move、gone、census）` : "没写 op") : "没写对是哪样东西", name, "item");
      continue;
    }
    const entry: Mutable<ItemInput> = { kind: "item", review: "auto", op, item, quote: quoteText(raw.quote) ?? "" };
    const seq = integer(raw.seq);
    if (seq !== undefined && seq >= 1) entry.seq = seq;
    const source = itemSourceOf(raw);
    if (source) entry.source = source;
    const note = str(raw.note);
    if (note) entry.note = nameHandles(note, handles.handleNames);
    let broken: string | undefined;
    for (const key of ["to", "from"] as const) {
      if (raw[key] === undefined || raw[key] === null || raw[key] === "") continue;
      const place = placeOf(raw[key], handles);
      if (typeof place === "string") broken ??= `${key === "to" ? "去处" : "从哪来"}：${place}`;
      else entry[key] = place;
    }
    if (op === "gone") {
      const gone = GONE[str(raw.gone)?.toLowerCase() ?? ""];
      if (gone) entry.gone = gone;
      else broken ??= "没写是丢了（lost）还是毁了（destroyed）";
    }
    if (op === "census") {
      const members: CensusMemberInput[] = [];
      for (const [at, member] of asList(raw.members).entries()) {
        const ref = itemRefOf(member, undefined, handles);
        if (!ref) {
          broken ??= `清点第 ${at + 1} 样没写对是哪样`;
          continue;
        }
        members.push({ ...ref, ...(isRecord(member) ? factLinks(member, handles, `${where}.members 第 ${at + 1} 样`, drop) : {}) } as CensusMemberInput);
      }
      entry.members = members;
      const complete = flag(raw.complete);
      if (complete !== undefined) entry.complete = complete;
    } else Object.assign(entry, factLinks(raw, handles, where, drop));
    if (broken) {
      drop(where, `${broken}，这条没记`, name, "item");
      continue;
    }
    entries.push(entry);
  }
}

/** 短号指的那样东西叫什么（I / P 号认得才有；N 号看本批 newItems）。 */
function handleName(ref: ItemRefInput, handles: KeeperHandles): string | undefined {
  if (ref.mention) return ref.mention;
  if ("tag" in ref) return handles.handleNames?.get(ref.tag);
  for (const [handle, id] of handles.itemHandles ?? []) if (id === ref.id) return handles.handleNames?.get(handle);
  return undefined;
}

/**
 * 本章结尾：整章同一天（sameDay）或逐次换天（dayChanges）。第一遍记账、追问结尾（ledger-keeper）都走这一处。
 * 换天有一次写坏了 → 换天全不记、章末不知道（少记一次换天，后面每章都错一天）；又说同一天又列了换天 → 两样都不记。
 */
export function parseChapterEnd(raw: Record<string, unknown>, adjusted: KeeperDrop[]): Pick<TimeInput, "sameDay" | "dayChanges"> {
  const sameDay = flag(raw.sameDay);
  const changes: Mutable<NonNullable<TimeInput["dayChanges"]>[number]>[] = [];
  let changesBroken: string | undefined;
  for (const [index, item] of asList(raw.dayChanges).entries()) {
    if (!isRecord(item)) {
      changesBroken ??= `第 ${index + 1} 次换天不是对象`;
      continue;
    }
    const relative = relativeOf(item);
    if (typeof relative === "string") {
      changesBroken ??= `第 ${index + 1} 次换天${relative}`;
      continue;
    }
    const days = "offset" in relative ? relative.offset : undefined;
    if (days && (days.unit !== "day" || days.min === undefined || days.min < 1)) {
      changesBroken ??= `第 ${index + 1} 次换天没写成「至少过了一天」`;
      continue;
    }
    const quote = quoteText(item.quote);
    changes.push({ ...relative, ...(quote ? { quote } : { quote: "" }) });
  }
  if (changesBroken) {
    adjusted.push({ where: "time.dayChanges", reason: `${changesBroken}，换天都没记，章末是哪天不知道` });
    return {};
  }
  if (sameDay === true && changes.length > 0) {
    adjusted.push({ where: "time", reason: "又说整章同一天、又列了换天，两样都没记，章末是哪天不知道" });
    return {};
  }
  if (changes.length > 0) return { dayChanges: changes };
  return sameDay === true ? { sameDay: true } : {};
}

/**
 * 时间（设计第 4 节）：start、sameDay、dayChanges、weekday、timeOfDay 在 time 里；segments 在顶层（写进 time 里的也认）。
 * 原句没附的照样交上去（空串），等补摘；结构上自相矛盾的按能确定的那一半记、如实说：
 *  - start 的相对多少写坏了 → 本章开头按说不出（unknown）记；
 *  - 换天有一次写坏了 → 换天全不记、章末不知道（少记一次换天，后面每章都错一天）；又说同一天又列了换天 → 两样都不记；
 *  - 段写坏了 → 那段不记（如实说，这段里的事按当下记了）；
 *  - 没写 start、也没有盖住全章的段，却写了同一天 / 换天 / 星期 → 本章开头按说不出记。
 */
function parseTime(root: Raw, drop: (where: string, reason: string) => void, adjusted: KeeperDrop[]): TimeInput | undefined {
  const raw = isRecord(root.time) ? root.time : undefined;
  const segmentsRaw = root.segments ?? raw?.segments;
  const segments: SegmentInput[] = [];
  for (const [index, item] of asList(segmentsRaw).entries()) {
    const where = `segments 第 ${index + 1} 段`;
    if (!isRecord(item)) {
      drop(where, "不是对象");
      continue;
    }
    const frameText = str(item.frame)?.toLowerCase();
    const frame = frameText ? FRAMES[frameText] : undefined;
    const firstQuote = quoteText(item.firstQuote);
    const lastQuote = quoteText(item.lastQuote) ?? firstQuote;
    if (!frame) {
      drop(where, frameText ? `frame 写成了「${frameText}」，认不出（只认 past、other），这段没记，段里的事按当下记了` : "没写是回忆还是梦这类，这段没记，段里的事按当下记了");
      continue;
    }
    const segment: Mutable<SegmentInput> = { frame, firstQuote: firstQuote ?? "", lastQuote: lastQuote ?? "" };
    const whenText = str(item.when)?.toLowerCase();
    if (frame === "past" && whenText === "unknown") segment.when = "unknown";
    else if (frame === "past" && isRecord(item.when)) {
      const when = relativeOf(item.when);
      if (typeof when === "string") adjusted.push({ where, reason: `这段是什么时候没写对（${when}），按说不出记` });
      segment.when = typeof when === "string" ? "unknown" : when;
    } else if (frame === "other" && item.when !== undefined && item.when !== null && item.when !== "") {
      adjusted.push({ where, reason: "梦、想象、传闻这类段不上时间线，写的时间没记" });
    }
    segments.push(segment);
  }
  if (!raw) {
    if (segments.length === 0) return undefined;
    return { kind: "time", review: "auto", segments };
  }

  const time: Mutable<TimeInput> = { kind: "time", review: "auto" };
  // start 那几样直接写在 time 里、没套 start：照 start 收。
  const startRaw = raw.start ?? (raw.offset !== undefined || raw.byBoundary !== undefined ? { offset: raw.offset, byBoundary: raw.byBoundary, basis: raw.basis, quote: raw.quote } : undefined);
  const startText = str(startRaw)?.toLowerCase();
  if (startText === "unknown") time.start = "unknown";
  else if (isRecord(startRaw)) {
    const start = startRaw;
    const relative = relativeOf(start);
    const basis = str(start.basis)?.toLowerCase() === "text" ? "text" : "judged";
    if (typeof relative === "string") {
      adjusted.push({ where: "time.start", reason: `本章开头离上一章多久没写对（${relative}），按说不出记` });
      time.start = "unknown";
    } else time.start = { ...relative, basis, quote: quoteText(start.quote) ?? "" };
  } else if (startRaw !== undefined && startRaw !== null && startRaw !== "") {
    adjusted.push({ where: "time.start", reason: "本章开头离上一章多久写得认不出，按说不出记" });
    time.start = "unknown";
  }

  Object.assign(time, parseChapterEnd(raw, adjusted));

  const weekdayText = str(raw.weekday);
  if (weekdayText !== undefined) {
    if (weekdayText in WEEKDAYS) time.weekday = WEEKDAYS[weekdayText];
    else drop("time.weekday", `星期写成了「${weekdayText}」，认不出（只认「周二」这类写法）`);
  }
  const timeOfDay = str(raw.timeOfDay);
  if (timeOfDay) time.timeOfDay = timeOfDay;
  if (segments.length > 0) time.segments = segments;

  const present = time.start !== undefined || time.sameDay !== undefined || time.dayChanges !== undefined || time.weekday !== undefined || time.timeOfDay !== undefined;
  if (!present && segments.length === 0) {
    drop("time", "时间里什么都没写");
    return undefined;
  }
  if (present && time.start === undefined) {
    adjusted.push({ where: "time.start", reason: "没写本章开头离上一章多久，按说不出记" });
    time.start = "unknown";
  }
  return time;
}
