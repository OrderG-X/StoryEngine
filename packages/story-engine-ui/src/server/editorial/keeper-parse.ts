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
import type { EntryInput, FactInput, PresenceInput, SummaryInput, ThreadInput, TimeInput } from "@actalk/story-core";

export interface KeeperDrop {
  /** 哪一类、第几条（从 1 起），如「facts 第 3 条」。 */
  readonly where: string;
  readonly reason: string;
}

export interface KeeperParseResult {
  readonly entries: readonly EntryInput[];
  /** 丢掉的条目或字段，带原因（预览里如实给作者看）。 */
  readonly drops: readonly KeeperDrop[];
  /** 改动过的条目（比如缺字段的事实降为「发生过的事」），带原因。 */
  readonly adjusted: readonly KeeperDrop[];
  /** 本章中间换了天时，记账员摘的那句换天的原句（还没核对：由 runLedgerKeeper 拿正文核）。 */
  readonly dayChangeQuote?: string;
}

export interface KeeperHandles {
  readonly threadHandles: ReadonlyMap<string, string>;
  readonly factHandles: ReadonlyMap<string, string>;
  /** 短号 → 给作者看的名字（线索标题、事实内容）：模型在说明里写了「归入T1」，换成名字再进清单。 */
  readonly handleNames?: ReadonlyMap<string, string>;
  /** 重定稿：「R2」→ 这一章上次定稿时开的线索真编号（本章还在开，就沿用编号，后文的推进才接得上）。 */
  readonly reopenHandles?: ReadonlyMap<string, string>;
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
    if ((letter === "T" || letter === "F" || letter === "R") && isDigit(text[i + 1]) && !isAsciiWord(text[i - 1])) {
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

/** 非负整数：数字、数字字符串、单个中文数字（零～十）。其余 → undefined。 */
function count(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isInteger(value) && value >= 0 ? value : undefined;
  const text = str(value);
  if (text === undefined) return undefined;
  if (text in CHINESE_DIGITS) return CHINESE_DIGITS[text];
  const parsed = Number(text);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

const TRUE_WORDS = new Set(["true", "yes", "y", "1", "是", "对"]);
const FALSE_WORDS = new Set(["false", "no", "n", "0", "否", "不是", "不"]);

function flag(value: unknown): boolean | undefined {
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
  const drop = (where: string, reason: string): void => {
    drops.push({ where, reason });
  };
  const named = (value: string | undefined): string | undefined => (value === undefined ? undefined : nameHandles(value, handles.handleNames));
  let dayChangeQuote: string | undefined;

  // —— 梗概 ——
  if (root.summary !== undefined && root.summary !== null) {
    const raw = isRecord(root.summary) ? root.summary : {};
    const summary = named(str(raw.text) ?? str(raw.summary));
    const quote = quoteText(raw.quote);
    // 没附原句的照样交上去（quote 空着）：补摘那一步会请记账员补一句，补不上由核对如实列为没记上。
    if (summary) entries.push({ kind: "summary", review: "auto", text: summary, quote: quote ?? "" } satisfies SummaryInput);
    else drop("summary", "梗概是空的");
  }

  // —— 时间 ——
  if (isRecord(root.time)) {
    const raw = root.time;
    const quote = quoteText(raw.quote);
    const basisText = str(raw.basis)?.toLowerCase();
    // 模型只能交正文明写 / 读前后文判断两种；写了别的（author、estimated）一律按判断记。
    const basis: TimeInput["basis"] = basisText === "text" ? "text" : "judged";
    const time: { -readonly [K in keyof TimeInput]: TimeInput[K] } = { kind: "time", review: "auto", basis };
    const days = count(raw.daysSincePrevious);
    if (days !== undefined) time.daysSincePrevious = days;
    else if (raw.daysSincePrevious !== undefined && raw.daysSincePrevious !== null && raw.daysSincePrevious !== "") drop("time.daysSincePrevious", "隔几天不是非负整数");
    const inChapter = count(raw.daysInChapter);
    if (inChapter !== undefined && inChapter > 0) {
      time.daysInChapter = inChapter;
      dayChangeQuote = quoteText(raw.dayChangeQuote);
    }
    const weekdayText = str(raw.weekday);
    if (weekdayText !== undefined) {
      if (weekdayText in WEEKDAYS) time.weekday = WEEKDAYS[weekdayText];
      else drop("time.weekday", `星期写成了「${weekdayText}」，认不出（只认「周二」这类写法）`);
    }
    const timeOfDay = str(raw.timeOfDay);
    if (timeOfDay) time.timeOfDay = timeOfDay;
    // 没附原句的照样交上去，等补摘（见梗概那条）。
    time.quote = quote ?? "";
    if (time.daysSincePrevious === undefined && time.weekday === undefined && time.timeOfDay === undefined && time.daysInChapter === undefined) {
      drop("time", "时间里什么都没写");
    } else entries.push(time);
  }

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
      drop(where, "没写这一章对它做了什么");
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
      entries.push({ kind: "thread", review: "auto", op, type: type ?? "question", title, note, quote: quote ?? "", ...(reopen ? { thread: reopen } : {}) } satisfies ThreadInput);
      continue;
    }
    const targets = handleList(item.thread);
    if (targets.length === 0) {
      drop(where, op === "close" ? "收口没写收的是哪条线索" : "推进没写推进的是哪条线索");
      continue;
    }
    const seen = new Set<string>();
    for (const handle of targets) {
      // 短号对不上：原样交下去，checkEntries 会以「前文没有这条线索」如实列出来。
      const thread = handles.threadHandles.get(handle) ?? handle;
      if (seen.has(thread)) continue;
      seen.add(thread);
      entries.push({ kind: "thread", review: "auto", op, thread, note, quote: quote ?? "" } satisfies ThreadInput);
    }
  }

  return { entries, drops, adjusted, ...(dayChangeQuote ? { dayChangeQuote } : {}) };
}
