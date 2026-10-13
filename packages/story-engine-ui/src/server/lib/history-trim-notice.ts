/**
 * 「这次只带上最近 12 条对话…」提示的进程内一次登记（2026-10-14 编辑部 R7.7，报告 4.6）。
 *
 * 十章真机试写：历史超过 12 条后**每回合**都弹这条 status note，从第 3 章起每回合都在——
 * 作者看不懂也烦（记忆条才用了 2～8%）。R7.7 口径：同一会话只提示一次。
 * 「会话」在服务端能拿到的最稳标识是书目录（projectDir，一本书的对话会话都在它名下）：
 * 进程内 Set 登记，发过一次就不再发。纯内存、无依赖；服务重启后最多再提示一次，可接受。
 * 模式对齐 brain/waiting-registry（进程内登记表），不走盘、不进会话文件。
 */

const noticedProjects = new Set<string>();

/** 该书要不要发这条提示：第一次问返回 true 并登记，之后一律 false。路径归一（realpath 由调用方决定，这里只做字面去重）。 */
export function shouldSendHistoryTrimNoticeOnce(projectDir: string): boolean {
  const key = projectDir.trim();
  if (!key || noticedProjects.has(key)) return false;
  noticedProjects.add(key);
  return true;
}

/** 测试专用：清空登记（避免用例间串味）。 */
export function resetHistoryTrimNoticesForTests(): void {
  noticedProjects.clear();
}
