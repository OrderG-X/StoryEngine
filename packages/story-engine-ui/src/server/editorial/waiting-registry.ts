/**
 * 进程内「谁在等哪个角色读完」的登记表（2026-10-13 编辑部 R6.1，新发现 1）。
 *
 * R5.2 把 waiting 写进 progress.json，但后台补读（startReaderCatchUp）和当场补笔记（五个专员入口）
 * 都写这份文件：后台那边不认识 waiting，一落盘就把「在等」标注抹掉——复验见过一次进度行短暂丢标注，就是这个。
 * R6.1 起 waiting 只活在进程内：ensureReaderWindow 拿到 waitingAs 就在进锁前登记、finally 里注销，
 * readReadersCatchUpStatus 读进度时把登记合进去（那个角色在读才带 waiting）。文件不再记 waiting，
 * 两边各写各的 reading/done，谁也抹不掉谁。自己补（当场补笔记）和等别人补（排在后台补读后面）
 * 显示一个样，作者不用分清。
 * 纯内存、无依赖：reader-window（登记）和 catch-up（合并）都能 import，不成环。
 */

/** 同一本书、同一角色可能同时被多个动作等（核账 / 审纲都在核账员上）：都记着，显示时并到一句。 */
const waitingActions = new Map<string, Set<string>>();

const keyOf = (root: string, roleId: string): string => `${root}\u0000${roleId}`;

/** 进锁前登记：root＋角色 → 动作名（核账 / 拟纲 / 记账）。同一动作等两次只记一份。 */
export function registerReaderWaiting(root: string, roleId: string, action: string): void {
  const key = keyOf(root, roleId);
  const actions = waitingActions.get(key) ?? new Set<string>();
  actions.add(action);
  waitingActions.set(key, actions);
}

/** finally 里注销：只撤自己那个动作；还有别的动作在等就留着。 */
export function unregisterReaderWaiting(root: string, roleId: string, action: string): void {
  const key = keyOf(root, roleId);
  const actions = waitingActions.get(key);
  if (!actions) return;
  actions.delete(action);
  if (actions.size === 0) waitingActions.delete(key);
}

/** 现在有哪些动作在等这个角色读完（合并进进度行用）。 */
export function readerWaitingActions(root: string, roleId: string): string[] {
  return [...waitingActions.get(keyOf(root, roleId)) ?? []];
}
