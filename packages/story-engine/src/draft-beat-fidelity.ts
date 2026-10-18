/**
 * draft-beat-fidelity — 出稿后「本章必须命中要点」的确定性保真软警告。
 *
 * 背景（Codex 复测额外发现）：出稿管线只有一句话 chapterGoal、且出稿后无任何一步核对用户要的 beat 写没写，
 * 首稿会静默跑偏（「第三块砖」→「第三层杂志架」、「债权池A-17」→数字串）。非技术用户看不出，长篇无声烂掉。
 *
 * 设计（题材中立、零 LLM、只软警告不阻塞）：
 *   - 只检 beat 里的【具体锚点】——① 标识符/编号码（含字母+数字，如 A-17）；② 数字+量词+名物（如 第三块砖 的「砖」）。
 *   - 锚点缺失 → 该 beat 记 missing + 一条 warning（交给上层让 agent 诚实回报、由用户决定改不改）。
 *   - 纯结果/可改写 beat（无具体锚点，如「周衡会先倒霉」）跳过不检——宁可漏报，不误杀正常改写（favor 低误报）。
 *
 * 精度（对抗性审查·13 agent 后加固）：
 *   - 标识符按【token 集合精确匹配】，不再把整章拼成一个 alnum 串做 substring——否则 A-170 会吞掉 A-17、
 *     「A区…第17号」跨 token 拼出假 a17（漏报真遗漏）。
 *   - 全角字母数字先折半（Ａ－１７ == A-17），治某些模型输出全角导致的误报/漏检。
 *   - 量词表覆盖常见可数量词（只/位/名/座/册/幅…）；名物抓量词后 1–2 个汉字更具体（木箱/钥匙），尾随虚词截断。
 *   - 已知局限：单字通用名物（砖/门/页…）仍用整章 includes，可能因别处出现而漏报；这是廉价确定性检查的固有上限，
 *     刻意不收紧（收紧会误杀正常改写、违背 favor 低误报）。标识符/多字名物路径才是主力。
 *
 * 说话人归属核对（Codex retest4）：beat「乔蔓语气冷淡，"别碰药柜左边那排。"」无标识符/量词名物锚点，原本被整条跳过——
 * 草稿里台词逐字命中、但说话人被写成了别人，agent 仍报「全部命中」（看起来通过、其实没真核对说话人）。
 * 新增第三类锚点：beat 含「具名角色+归属动词/语气词+引号台词」结构时，核对草稿里这句台词的每处出现，说话人是否
 * 真是指定角色。台词压根没写→现有缺失语义；台词命中但归属结构模糊（转述/回忆引用、代词指代）→ 跳过不报
 * （favor 低误报，同上面的设计哲学）。
 *
 * 说话人识别·分句主语（Codex retest5 修订）：V1 曾用「说话人紧邻归属动词」抽取，真机两种常见句式直接漏判甚至
 * 抓错——①「X盯着Y说，"…"」：归属动词紧邻的是宾语 Y（被盯的人），真说话人是分句起头的主语 X；
 * ②「X[一长段动作描写]，语气冷淡，"…"」：说话人和归属词之间常隔着大段动作描写，不紧邻。改为：分句边界
 * （上一个 。！？\n 或字符串开头）到引号前为一个分句，说话人 = 分句【起头】的具名角色（取最短可行长度 2/3/4
 * 字，避免贪婪吞掉后面的动作描写），归属动词/语气词只需在主语之后、引号之前的某处出现，不要求紧邻。
 * 仍只认「说话人在引号之前」语序；反序「『……』X说。」是已知局限，留给下一轮真机撞到再扩。
 */

export interface BeatFidelityIssue {
  readonly severity: "warning";
  readonly type: "missing_required_beat" | "speaker_misattribution";
  readonly beat: string;
  readonly message: string;
}

export interface BeatFidelityReport {
  readonly passed: boolean;
  /** 含具体锚点、确实被检查过的 beat（无锚点的不在此列）。 */
  readonly checkedBeats: readonly string[];
  readonly missingBeats: readonly string[];
  readonly issues: readonly BeatFidelityIssue[];
}

// 通用量词（题材中立，不含任何作品专名）。数字/序数 + 量词 + 名物首字 = 一个可核对的具体物锚点。
const QUANTIFIERS = "块层张枚个本支条道扇把件粒颗根片面段封页杯辆台部只位名座栋幢幅册卷瓶双对批匹头艘架具串箱包袋盒罐桶份笔起宗桩间处盏堵束枝盘";
const QUANTIFIER_NOUN = new RegExp(
  `(?:第)?[一二三四五六七八九十百千两零0-9０-９]+\\s*[${QUANTIFIERS}]\\s*([\\u4e00-\\u9fa5]{1,2})`,
  "gu",
);
// 名物 2 字时，若第 2 字是虚词/方位/助词，截回 1 字（避免抓到「砖被」「箱里」这种非名词尾）。
const NOUN_TRAILING_STOP = /[的了着过被里上下中内外前后旁边们就都也还又再很太地得]/u;
// 字母数字 token（含连字符），用于抽标识符/编号码（A-17 / 3F / B2 …）。
const ALNUM_TOKEN = /[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9]|[A-Za-z0-9]/g;

/** 全角字母/数字/标点（U+FF01–FF5E）折成半角，使 Ａ－１７ 与 A-17 等价。 */
function foldWidth(value: string): string {
  return value.replace(/[！-～]/gu, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
}

/** 文本里的【标识符 token】集合：同时含字母与数字的 token（A-17 / B2 …），各自折半+归一成纯小写字母数字。 */
function identifierTokens(text: string): Set<string> {
  const set = new Set<string>();
  for (const match of foldWidth(text).matchAll(ALNUM_TOKEN)) {
    const token = match[0];
    if (/[A-Za-z]/u.test(token) && /\d/u.test(token)) {
      const norm = token.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (norm) set.add(norm);
    }
  }
  return set;
}

/** 名物锚点：beat 里「数字+量词+名物」结构中量词后那 1–2 个汉字（第三个木箱 → 木箱；第三块砖 → 砖）。 */
function nounAnchors(beat: string): readonly string[] {
  const out: string[] = [];
  for (const match of foldWidth(beat).matchAll(QUANTIFIER_NOUN)) {
    let noun = match[1] ?? "";
    if (noun.length === 2 && NOUN_TRAILING_STOP.test(noun[1] ?? "")) noun = noun[0] ?? "";
    if (noun) out.push(noun);
  }
  return out;
}

// 说话人归属方言：与 commit-plan-builder.ts 的 isDialogueAttributionSentence 同一套（说/问/喊/叫/低声/冷笑/嘟囔 +
// (的)?声音/语气/嗓音/声线），各自维护一份——两个模块职责不同（一个选事件摘要句、一个核对台词归属），不为共享
// 一段正则增加跨模块耦合。修饰语 {0,8} 排除所有引号/句末标点，避免吞进引号本身。
const ATTRIBUTION_TAIL =
  "(?:说|问|喊|叫|低声(?:说|道)?|冷笑(?:着)?(?:说)?|嘟囔|(?:的)?(?:声音|语气|嗓音|声线)[^，。！？：“”\"「『』」]{0,8})";
// 「分句内某处含归属动词/语气词、以 [，：]+引号 收尾」——主语提取后用来验证剩余文本。
const CLAUSE_ENDS_WITH_ATTRIBUTION = new RegExp(`^[\\s\\S]*${ATTRIBUTION_TAIL}[，：]\\s*$`, "u");
// 分句边界：句号/问号/感叹号/换行（不含逗号——「X动作，归属词，"…"」这种多逗号长句要整段当一个分句看）。
const CLAUSE_BOUNDARY = /[。！？\n]/u;
const CLAUSE_LOOKBACK = 60;
// 代词/泛指不当作可核对的具名说话人（「他语气冷淡」无法判断「他」是不是指定角色）。
const SPEAKER_PRONOUNS = new Set(["他们", "她们", "它们", "对方", "众人", "两人", "二人", "大家"]);

/**
 * 从「引号开引号字符之前」回抽出当前分句（分句边界——上一个 。！？\n 或窗口起点——到引号前，不含引号本身）。
 * 限定 60 字回看窗口，避免跨入与对白无关的更早内容。
 */
function clauseBeforeQuoteMark(text: string, quoteMarkIndex: number): string {
  const windowStart = Math.max(0, quoteMarkIndex - CLAUSE_LOOKBACK);
  const window = text.slice(windowStart, quoteMarkIndex);
  for (let i = window.length - 1; i >= 0; i -= 1) {
    if (CLAUSE_BOUNDARY.test(window[i] ?? "")) return window.slice(i + 1);
  }
  return window;
}

/**
 * 说话人 = 分句【起头】的具名角色（不是紧邻归属动词的那个——Codex retest5：「X盯着Y说」型，Y 紧邻"说"却不是
 * 说话人，X 才是）；归属动词/语气词只需在主语之后、引号之前的某处出现，不要求紧邻（「X站在哪，做了什么，
 * 语气冷淡，"…"」型——主语和归属词间常隔着大段动作描写）。取最短可行主语长度（2 字优先于 3/4 字），避免
 * 贪婪吞掉主语后面的动作描写词。抽不到/是代词 → undefined（不可核对，模糊跳过）。
 */
function extractSpeakerFromClause(clauseText: string): string | undefined {
  for (const len of [2, 3, 4]) {
    if (clauseText.length < len) break;
    const candidate = clauseText.slice(0, len);
    if (!/^[一-龥]+$/u.test(candidate)) continue;
    const rest = clauseText.slice(len);
    if (CLAUSE_ENDS_WITH_ATTRIBUTION.test(rest)) {
      return SPEAKER_PRONOUNS.has(candidate) ? undefined : candidate;
    }
  }
  return undefined;
}

/** beat 若是「具名角色+归属动词/语气词+引号台词」结构（分句主语版），抽出 (说话人, 台词)；抽不到→undefined（不可核对，走原有 ids/nouns 逻辑）。 */
function extractBeatSpeakerQuote(beat: string): { readonly speaker: string; readonly quote: string } | undefined {
  const openMatch = /[“"「『]/u.exec(beat);
  if (!openMatch || openMatch.index === undefined) return undefined;
  const quoteMarkIdx = openMatch.index;
  const speaker = extractSpeakerFromClause(clauseBeforeQuoteMark(beat, quoteMarkIdx));
  if (!speaker) return undefined;
  const contentMatch = /[“"「『]([^”"」』]{2,60})[”"」』]/u.exec(beat.slice(quoteMarkIdx));
  const quote = contentMatch?.[1]?.trim();
  if (!quote) return undefined;
  return { speaker, quote };
}

/** 草稿里 quote 的每次出现 → 该处反向抽出的说话人（分句主语版）；抽不出清晰归属结构（转述/回忆引用/代词）的处 = undefined（模糊）。 */
function speakersForQuoteOccurrences(draft: string, quote: string): readonly (string | undefined)[] {
  const speakers: (string | undefined)[] = [];
  let from = 0;
  while (true) {
    const idx = draft.indexOf(quote, from);
    if (idx === -1) break;
    from = idx + quote.length;
    const quoteMarkIdx = idx - 1; // 内容紧邻在开引号字符之后
    speakers.push(quoteMarkIdx >= 0 ? extractSpeakerFromClause(clauseBeforeQuoteMark(draft, quoteMarkIdx)) : undefined);
  }
  return speakers;
}

export function checkDraftBeatFidelity(input: {
  readonly draftContent: string;
  readonly mustHitBeats: readonly string[];
}): BeatFidelityReport {
  const draft = input.draftContent;
  const draftIds = identifierTokens(draft);
  const checkedBeats: string[] = [];
  const missingBeats: string[] = [];
  const issues: BeatFidelityIssue[] = [];

  for (const rawBeat of input.mustHitBeats) {
    const beat = rawBeat.trim();
    if (!beat) continue;

    const speakerQuote = extractBeatSpeakerQuote(beat);
    if (speakerQuote) {
      checkedBeats.push(beat);
      const occurrences = speakersForQuoteOccurrences(draft, speakerQuote.quote);
      if (occurrences.length === 0) {
        // 台词压根没写进草稿 → 沿用现有「漏写」语义。
        missingBeats.push(beat);
        issues.push({
          severity: "warning",
          type: "missing_required_beat",
          beat,
          message: `首稿可能漏写或改写了要点「${beat}」，请核对是否要改稿补回。`,
        });
        continue;
      }
      if (!occurrences.includes(speakerQuote.speaker)) {
        const clearOther = occurrences.find((s): s is string => s !== undefined && s !== speakerQuote.speaker);
        if (clearOther) {
          missingBeats.push(beat);
          issues.push({
            severity: "warning",
            type: "speaker_misattribution",
            beat,
            message: `要点「${beat}」里的台词写进了正文，但说话人被写成了「${clearOther}」而不是「${speakerQuote.speaker}」，请核对。`,
          });
        }
        // 否则：台词在，但每处都抽不出清晰说话人（转述/回忆引用等模糊结构）→ 跳过不报，favor 低误报。
      }
      continue;
    }

    const ids = [...identifierTokens(beat)];
    const nouns = nounAnchors(beat);
    if (ids.length === 0 && nouns.length === 0) continue; // 无具体锚点 = 不可确定性核对 → 跳过
    checkedBeats.push(beat);
    const idMissing = ids.some((anchor) => !draftIds.has(anchor));
    const nounMissing = nouns.some((noun) => !draft.includes(noun));
    if (idMissing || nounMissing) {
      missingBeats.push(beat);
      issues.push({
        severity: "warning",
        type: "missing_required_beat",
        beat,
        message: `首稿可能漏写或改写了要点「${beat}」，请核对是否要改稿补回。`,
      });
    }
  }

  return { passed: missingBeats.length === 0, checkedBeats, missingBeats, issues };
}
