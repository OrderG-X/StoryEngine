/**
 * 后台补读的提交口（写作版本 P2a 4.5）：专员（编辑部，第 4 层）读前文读不全时要把补读交给执行器的 background.backfill（服务层，第 5 层），
 * 不能直接引上层；这里只放登记口，服务层开机时登记处理函数（`services/operations/recipes/index.ts`）。没登记（单测）就什么都不做。
 * 去重、盖掉停着的、跑完再看一眼都在处理函数里。
 */

export interface ReaderBackfillRequest {
  /** 要补的角色 id（按先后补）；缺省三个专员都补。 */
  readonly roles?: readonly string[];
  /** 补到第几章（超过已定稿的按已定稿的算）。 */
  readonly upTo: number;
}

type BackfillHandler = (bookDir: string, request: ReaderBackfillRequest) => Promise<unknown>;

let handler: BackfillHandler | undefined;

export function setReaderBackfillHandler(next: BackfillHandler | undefined): void {
  handler = next;
}

/** 交一次后台补读，等交上（开书路由要在建概况前交上，概况才带得上「在读」）。交不上只记一笔，不抛。 */
export async function submitReaderBackfill(bookDir: string, request: ReaderBackfillRequest): Promise<void> {
  if (!handler) return;
  await handler(bookDir, request).catch((error: unknown) => {
    console.warn("[backfill] 后台补读没交上（下次开书、定稿再交）", error);
  });
}

/** 交一次后台补读，不等。 */
export function requestReaderBackfill(bookDir: string, request: ReaderBackfillRequest): void {
  void submitReaderBackfill(bookDir, request);
}

/* ------------------------------------------------------------------ */
/*  background.backfill 的参数和步骤号（执行器的配方和进度行共用）            */
/* ------------------------------------------------------------------ */

export const BACKFILL_KIND = "background.backfill" as const;

/** 一个角色这次补哪几章（受理时冻结）：第 from～to 章。 */
export interface BackfillRange {
  readonly role: string;
  readonly from: number;
  readonly to: number;
}

export interface BackfillParams {
  readonly ranges: readonly BackfillRange[];
}

const positiveInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;

/** 记录里的参数读回来；形状不对是 undefined。 */
export function readBackfillParams(value: unknown): BackfillParams | undefined {
  const ranges = (value as { ranges?: unknown } | null)?.ranges;
  if (!Array.isArray(ranges)) return undefined;
  const parsed: BackfillRange[] = [];
  for (const range of ranges as unknown[]) {
    const { role, from, to } = (range ?? {}) as Partial<BackfillRange>;
    if (typeof role !== "string" || !/^[a-z][a-z0-9-]*$/u.test(role) || !positiveInt(from) || !positiveInt(to) || from > to) return undefined;
    parsed.push({ role, from, to });
  }
  return { ranges: parsed };
}

/** 步骤号：一章一步 `<角色>:<章>`；卷笔记到了这一步的上限，同一章再分一步 `<角色>:<章>:<第几段>`。 */
export const backfillStepId = (role: string, chapter: number, part = 1): string => (part > 1 ? `${role}:${chapter}:${part}` : `${role}:${chapter}`);

export function parseBackfillStep(stepId: string | undefined): { readonly role: string; readonly chapter: number } | undefined {
  const matched = stepId ? /^([a-z][a-z0-9-]*):(\d+)(?::\d+)?$/u.exec(stepId) : null;
  return matched ? { role: matched[1]!, chapter: Number(matched[2]) } : undefined;
}
