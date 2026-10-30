/**
 * draft.change 的参数（写作版本 P2a 3.1、第七节）：对话 AI 的 change_draft、按钮「写这一章 / 重写 / 接着往下写」、
 * 下一步选项里的写稿动作交的都是这一份。受理时归一一次存进记录，接着做时照记录里的读回。
 * 模型可能传的退化输入（空串、空数组、0、"False"）在对话工具那一层已经宽进；这里只认归一好的形状，多的字段丢掉。
 */
export const DRAFT_CHANGE_KIND = "draft.change" as const;

export type DraftChangeMode = "write" | "continue";

const MODES: readonly DraftChangeMode[] = ["write", "continue"];

export interface DraftChangeParams {
  readonly chapter: number;
  /** 作者这章的方向（原话：对话里核过原句、按钮带来的、稿纸上挑中的走法并进来的）；没有就按故事现状往下推。 */
  readonly direction?: string;
  /** 作者点名必须写到的要点（原话，逐条）。 */
  readonly mustHitBeats?: readonly string[];
  /** write：整章目标字数；continue：这次接着写多少字。没有就按写作规则。 */
  readonly length?: number;
  readonly selectedCharacters?: readonly string[];
  readonly maxTimelineEvents?: number;
  readonly contextTokenBudget?: number;
  /** write：一次写几版（只认 2、3）；接着写只出一版。 */
  readonly candidates?: 2 | 3;
  /**
   * write：几版作者自己挑（「AI 另写几版」）：每版都留成候选、一版都不换上，不去味、不核账（作者换上之后要核照常核）。
   * 没说几版就写 2 版。不带它 = 选优换上一版，落选的也留成候选。
   */
  readonly pick?: "author";
  /** 检出机器腔只标注、不自动去味。 */
  readonly autoDeAi?: false;
  /** 作者要写完就出定稿预览。 */
  readonly thenPreview?: true;
  /** write：作者点了「重写这一章」（这章有稿、已定稿也整章重写）。 */
  readonly rewrite?: true;
  /** 前一章没定稿、作者知情后仍要先写这一章。 */
  readonly allowWriteAhead?: true;
}

const positiveInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);

const texts = (value: unknown): readonly string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const items = value.map(text).filter((item): item is string => item !== undefined);
  return items.length > 0 ? items : undefined;
};

/** 交来的（或记录里存的）参数读回来；章号不对、模式不认识是 undefined。接着写不带多版、重写。 */
export function readDraftChangeParams(mode: unknown, value: unknown): { readonly mode: DraftChangeMode; readonly params: DraftChangeParams } | undefined {
  if (!MODES.includes(mode as DraftChangeMode)) return undefined;
  const raw = (value ?? {}) as Record<string, unknown>;
  const chapter = positiveInteger(raw.chapter);
  if (chapter === undefined) return undefined;
  const writing = mode === "write";
  const direction = text(raw.direction);
  const mustHitBeats = texts(raw.mustHitBeats);
  const length = positiveInteger(raw.length);
  const selectedCharacters = texts(raw.selectedCharacters);
  const maxTimelineEvents = positiveInteger(raw.maxTimelineEvents);
  const contextTokenBudget = positiveInteger(raw.contextTokenBudget);
  const pick = writing && raw.pick === "author" ? "author" as const : undefined;
  const candidates = writing && (raw.candidates === 2 || raw.candidates === 3) ? raw.candidates : pick ? 2 as const : undefined;
  return {
    mode: mode as DraftChangeMode,
    params: {
      chapter,
      ...(direction ? { direction } : {}),
      ...(mustHitBeats ? { mustHitBeats } : {}),
      ...(length !== undefined ? { length } : {}),
      ...(selectedCharacters ? { selectedCharacters } : {}),
      ...(maxTimelineEvents !== undefined ? { maxTimelineEvents } : {}),
      ...(contextTokenBudget !== undefined ? { contextTokenBudget } : {}),
      ...(candidates !== undefined ? { candidates } : {}),
      ...(pick ? { pick } : {}),
      ...(raw.autoDeAi === false ? { autoDeAi: false as const } : {}),
      // 作者自己挑的一版都不换上：没有写完就出的定稿预览。
      ...(raw.thenPreview === true && !pick ? { thenPreview: true as const } : {}),
      ...(writing && raw.rewrite === true ? { rewrite: true as const } : {}),
      ...(raw.allowWriteAhead === true ? { allowWriteAhead: true as const } : {}),
    },
  };
}

/** 这次出几版（接着写只出一版）。 */
export const versionCount = (mode: DraftChangeMode, params: DraftChangeParams): number =>
  mode === "write" ? params.candidates ?? 1 : 1;

/* ------------------------------------------------------------------ */
/*  改稿：revise / fix / deai（写作版本 P2a 片 2C）                         */
/* ------------------------------------------------------------------ */

/** 改已有的工作稿：对话 / 选中文字改写一段（revise）、核账卡改对不上的句子（fix）、AI 味卡改机器腔（deai）。 */
export type DraftEditMode = "revise" | "fix" | "deai";

export const DRAFT_EDIT_MODES: readonly DraftEditMode[] = ["revise", "fix", "deai"];

export const isDraftEditMode = (mode: unknown): mode is DraftEditMode => DRAFT_EDIT_MODES.includes(mode as DraftEditMode);

/** 一次最多改几处、一处的原句和改法最多多长（核账卡一次最多交 12 处；AI 味卡一章挑出来的通常不到 20 句；对话里改稿一次几段）。 */
export const EDIT_MAX_FIXES = 12;
export const EDIT_MAX_REVISIONS = 6;
export const EDIT_MAX_VIOLATIONS = 30;
export const EDIT_MAX_TEXT = 800;

/** 改一段：要改的原文（逐字取自工作稿、只出现一次）+ 往哪改（或作者点名的确切新文本）。 */
export interface DraftReviseEdit {
  readonly targetText: string;
  /** 往哪改；给了 replacementText 可以没有。 */
  readonly revisionGoal?: string;
  /** 作者点名的确切新文本：原样换上，不调模型。 */
  readonly replacementText?: string;
}

export interface DraftReviseParams {
  readonly chapter: number;
  /** 这次要改的几段（一条作者消息只交一次：要改几处都放这里，按先后在同一份稿上改）。 */
  readonly edits: readonly DraftReviseEdit[];
  /** 按去机器腔的手法改。 */
  readonly style?: "deai";
  /** 改好先给作者看、作者点了「换上」才换（选中文字改写）。 */
  readonly preview?: true;
}

export interface DraftFixParams {
  readonly chapter: number;
  /** 核账引的原句 + 要改成什么样。 */
  readonly fixes: readonly { readonly targetText: string; readonly revisionGoal: string }[];
}

export interface DraftDeaiParams {
  readonly chapter: number;
  /** 查 AI 味挑出来的句子（原句 + 为什么 + 改的方向）。 */
  readonly violations: readonly { readonly id: string; readonly text: string; readonly reason: string; readonly severity: "high" | "medium" | "low"; readonly suggestedFix?: string }[];
}

export type DraftEditParams =
  | ({ readonly mode: "revise" } & DraftReviseParams)
  | ({ readonly mode: "fix" } & DraftFixParams)
  | ({ readonly mode: "deai" } & DraftDeaiParams);

const boundedText = (value: unknown): string | undefined => {
  const read = text(value);
  return read !== undefined && read.length <= EDIT_MAX_TEXT ? read : undefined;
};

/** 原文照原样（不去两头空白），空的、超长的不认。 */
const verbatim = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() && value.length <= EDIT_MAX_TEXT ? value : undefined;

const SEVERITIES = ["high", "medium", "low"] as const;

/** 交来的（或记录里存的）改稿参数读回来；章号、要改的原文缺了，超了上限是 undefined。 */
export function readDraftEditParams(mode: unknown, value: unknown): DraftEditParams | undefined {
  if (!isDraftEditMode(mode)) return undefined;
  const raw = (value ?? {}) as Record<string, unknown>;
  const chapter = positiveInteger(raw.chapter);
  if (chapter === undefined) return undefined;
  if (mode === "revise") {
    if (!Array.isArray(raw.edits) || raw.edits.length === 0 || raw.edits.length > EDIT_MAX_REVISIONS) return undefined;
    const edits = raw.edits.map((item): DraftReviseEdit | undefined => {
      const edit = (item ?? {}) as Record<string, unknown>;
      // 要改的原文、确切新文本照原样（空白也是原文的一部分），只去掉两头空白判空、量长短。
      const targetText = verbatim(edit.targetText);
      if (targetText === undefined) return undefined;
      const revisionGoal = boundedText(edit.revisionGoal);
      const replacementText = verbatim(edit.replacementText);
      return { targetText, ...(revisionGoal ? { revisionGoal } : {}), ...(replacementText ? { replacementText } : {}) };
    });
    if (edits.some((edit) => edit === undefined)) return undefined;
    return {
      mode,
      chapter,
      edits: edits as readonly DraftReviseEdit[],
      ...(raw.style === "deai" ? { style: "deai" as const } : {}),
      ...(raw.preview === true ? { preview: true as const } : {}),
    };
  }
  if (mode === "fix") {
    if (!Array.isArray(raw.fixes) || raw.fixes.length === 0 || raw.fixes.length > EDIT_MAX_FIXES) return undefined;
    const fixes = raw.fixes.map((item) => {
      const fix = (item ?? {}) as Record<string, unknown>;
      const targetText = boundedText(fix.targetText);
      const revisionGoal = boundedText(fix.revisionGoal);
      return targetText && revisionGoal ? { targetText, revisionGoal } : undefined;
    });
    if (fixes.some((fix) => fix === undefined)) return undefined;
    return { mode, chapter, fixes: fixes as DraftFixParams["fixes"] };
  }
  if (!Array.isArray(raw.violations) || raw.violations.length === 0 || raw.violations.length > EDIT_MAX_VIOLATIONS) return undefined;
  const violations = raw.violations.map((item, index) => {
    const violation = (item ?? {}) as Record<string, unknown>;
    const sentence = boundedText(violation.text);
    if (!sentence) return undefined;
    const severity = SEVERITIES.find((level) => level === violation.severity) ?? "medium";
    const suggestedFix = boundedText(violation.suggestedFix);
    return {
      id: text(violation.id) ?? `v${index + 1}`,
      text: sentence,
      reason: boundedText(violation.reason) ?? "",
      severity,
      ...(suggestedFix ? { suggestedFix } : {}),
    };
  });
  if (violations.some((violation) => violation === undefined)) return undefined;
  return { mode, chapter, violations: violations as DraftDeaiParams["violations"] };
}

/* ------------------------------------------------------------------ */
/*  作者挑 AI 稿：换上 / 不要了（写作版本 P2a 片 2D）                         */
/* ------------------------------------------------------------------ */

/** 换上 / 不要一份 AI 稿（稿纸提示条、「另外几版」卡上作者点的）：只认按钮交。 */
export const DRAFT_ADOPT_KIND = "draft.adopt" as const;
export const DRAFT_DISCARD_KIND = "draft.discard" as const;
export type CandidateDecisionKind = typeof DRAFT_ADOPT_KIND | typeof DRAFT_DISCARD_KIND;

export const isCandidateDecisionKind = (kind: unknown): kind is CandidateDecisionKind => kind === DRAFT_ADOPT_KIND || kind === DRAFT_DISCARD_KIND;

export interface CandidateDecisionParams {
  readonly chapter: number;
  readonly candidateId: string;
  /** 作者看到的那一份的指纹（章名 + 正文）。 */
  readonly sha: string;
  /** 换上：作者眼前那份工作稿的版本（这一章原来没有工作稿是 null）。不要了不带。 */
  readonly baseVersion?: string | null;
}

const CANDIDATE_ID = /^[0-9a-z-]{8,80}$/u;
const SHA = /^[0-9a-f]{64}$/u;

/** 交来的（或记录里存的）参数读回来；号、指纹不对，换上没带底版号是 undefined。 */
export function readCandidateDecisionParams(kind: CandidateDecisionKind, value: unknown): CandidateDecisionParams | undefined {
  const raw = (value ?? {}) as Record<string, unknown>;
  const chapter = positiveInteger(raw.chapter);
  const candidateId = typeof raw.candidateId === "string" && CANDIDATE_ID.test(raw.candidateId) ? raw.candidateId : undefined;
  const sha = typeof raw.sha === "string" && SHA.test(raw.sha) ? raw.sha : undefined;
  if (chapter === undefined || !candidateId || !sha) return undefined;
  if (kind === DRAFT_DISCARD_KIND) return { chapter, candidateId, sha };
  const baseVersion = raw.baseVersion === null ? null : typeof raw.baseVersion === "string" && raw.baseVersion.trim() && raw.baseVersion.length <= 200 ? raw.baseVersion.trim() : undefined;
  return baseVersion === undefined ? undefined : { chapter, candidateId, sha, baseVersion };
}
