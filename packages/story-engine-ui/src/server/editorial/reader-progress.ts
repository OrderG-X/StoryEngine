/**
 * 当场补笔记的进度和「动作在等它读完」的标注（2026-10-13 编辑部 R5.2；R6.1 改成登记表；写作版本 P2a 起不落盘）。
 *
 * 后台补读的进度从操作记录出（background.backfill 的冻结范围 + 当前步骤，见 catch-up.ts 的 readReadersCatchUpStatus）；
 * 这里只记核账 / 拟纲 / 记账当场补笔记（ensureReaderWindow 的三个回调）读到哪了——只在这个进程里跑，进程没了它也没了，
 * 所以只放内存（原来的 agents/<角色>/progress.json 删了：后台补读和当场补读各写各的、互相抹，进程被杀还留着 reading:true）。
 * 「（核账在等它读完）」那截在 waiting-registry.ts，读进度时一起合进去。
 */

/** 进度行里角色 id → 叫法（和前端 READER_ROLE_LABELS 同一张表）。 */
export const READER_ROLE_LABELS: Readonly<Record<string, string>> = {
  checker: "核账员",
  ledger: "记账员",
  planner: "章纲员",
};

/** 当场补笔记读到哪了：done = 已有笔记的章数，total = 这次要读到第几章。 */
export interface InPlaceProgress {
  readonly done: number;
  readonly total: number;
}

const inPlace = new Map<string, InPlaceProgress>();
const progressKey = (root: string, roleId: string): string => `${root}\u0000${roleId}`;

/** 这个角色这会儿有没有在当场补笔记（有就是读到哪了）。 */
export function readInPlaceProgress(root: string, roleId: string): InPlaceProgress | undefined {
  return inPlace.get(progressKey(root, roleId));
}

// ---------------------------------------------------------------------------
// 等读回执（R5.2 必做 2）：动作等过补读，回执加一句「这次先等 X 读完第 a～b 章再 Y」
// ---------------------------------------------------------------------------

/** 一次当场等读的事实：补了第 from～to 章笔记、花了 ms 毫秒。 */
export interface ReaderWaited {
  readonly from: number;
  readonly to: number;
  readonly ms: number;
}

/** 等读那一句：如「这次先等核账员读完第 51～58 章再核」（用时不报，2026-10-22 减字）。action 是句尾动词（再核 / 再拟纲 / 再记账）。 */
export function describeReaderWait(roleId: string, waited: ReaderWaited, action: string): string {
  const label = READER_ROLE_LABELS[roleId] ?? roleId;
  const span = waited.from >= waited.to ? `第 ${waited.from} 章` : `第 ${waited.from}～${waited.to} 章`;
  return `这次先等${label}读完${span}再${action}`;
}

// ---------------------------------------------------------------------------
// 当场补笔记的进度（只在内存）
// ---------------------------------------------------------------------------

/**
 * 给 ensureReaderWindow 的三个回调（onCatchUpBegin / onProgress / onCatchUpEnd）：当场补读开始、每写完一章、结束（含失败）
 * 各记一次读到哪了（只在内存）。界面进度行走 R4.3 的轮询；「（核账在等它读完）」那截由 readReadersCatchUpStatus 从等读登记表合进来。
 */
export function readerWaitingHandlers(root: string, roleId: string, upTo: number): {
  readonly onCatchUpBegin: (done: number) => Promise<void>;
  readonly onProgress: (chapter: number) => Promise<void>;
  readonly onCatchUpEnd: (done: number) => Promise<void>;
} {
  const key = progressKey(root, roleId);
  return {
    onCatchUpBegin: async (done) => { inPlace.set(key, { done, total: upTo }); },
    onProgress: async (chapter) => { inPlace.set(key, { done: chapter, total: upTo }); },
    onCatchUpEnd: async () => { inPlace.delete(key); },
  };
}
