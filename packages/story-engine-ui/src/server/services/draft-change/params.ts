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
  readonly selectedHookIds?: readonly string[];
  readonly maxTimelineEvents?: number;
  readonly contextTokenBudget?: number;
  /** write：作者要几版里挑（只认 2、3）；接着写只出一版。 */
  readonly candidates?: 2 | 3;
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
  const selectedHookIds = texts(raw.selectedHookIds);
  const maxTimelineEvents = positiveInteger(raw.maxTimelineEvents);
  const contextTokenBudget = positiveInteger(raw.contextTokenBudget);
  const candidates = writing && (raw.candidates === 2 || raw.candidates === 3) ? raw.candidates : undefined;
  return {
    mode: mode as DraftChangeMode,
    params: {
      chapter,
      ...(direction ? { direction } : {}),
      ...(mustHitBeats ? { mustHitBeats } : {}),
      ...(length !== undefined ? { length } : {}),
      ...(selectedCharacters ? { selectedCharacters } : {}),
      ...(selectedHookIds ? { selectedHookIds } : {}),
      ...(maxTimelineEvents !== undefined ? { maxTimelineEvents } : {}),
      ...(contextTokenBudget !== undefined ? { contextTokenBudget } : {}),
      ...(candidates !== undefined ? { candidates } : {}),
      ...(raw.autoDeAi === false ? { autoDeAi: false as const } : {}),
      ...(raw.thenPreview === true ? { thenPreview: true as const } : {}),
      ...(writing && raw.rewrite === true ? { rewrite: true as const } : {}),
      ...(raw.allowWriteAhead === true ? { allowWriteAhead: true as const } : {}),
    },
  };
}

/** 这次出几版（接着写只出一版）。 */
export const versionCount = (mode: DraftChangeMode, params: DraftChangeParams): number =>
  mode === "write" ? params.candidates ?? 1 : 1;
