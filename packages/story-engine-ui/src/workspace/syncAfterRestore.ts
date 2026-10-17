/**
 * 盘上整本书回到了某个存档（撤销到此、操作历史里恢复、AI 撤销上一步）之后：原地重读，不整页刷新（重构 P5）。
 *
 * 原来这里只能整页重载——稿子有好几份（编辑器内存、chapter-workspace JSON、草稿文件），不重载就会有旧稿被
 * 自动保存写回去、把撤销抹掉。现在稿纸只有一个主人且存稿带版本号，旧字写不回去，重读这一章就够了：
 * 滚动位置、输入框里没发的字都还在。
 */
import { fetchStateOverview } from "../api/client.js";
import { refreshPaper } from "../drafts/draftSync.js";
import { useDraftStore } from "../stores/draftStore.js";
import { useNavigationStore } from "../stores/navigationStore.js";
import { useWorkspaceStore } from "../stores/workspaceStore.js";
import { applyOverviewToWorkspace, flowStatusForPaper } from "./applyOverview.js";

export async function syncWorkspaceAfterRestore(projectPath: string): Promise<void> {
  const overview = await fetchStateOverview({ projectPath, maxTimelineEvents: 8 });
  if (useNavigationStore.getState().projectPath !== projectPath) return;
  // 作者自己点的撤销 / 恢复：盘上那版直接换上。
  await refreshPaper({ force: true });
  if (useNavigationStore.getState().projectPath !== projectPath) return;
  // 撤销前挂着的审稿、改写预览、候选稿都对不上新稿了，清掉。
  useWorkspaceStore.getState().resetTransientWorkspaceState();
  applyOverviewToWorkspace(overview, { flowStatus: flowStatusForPaper(useDraftStore.getState()) });
}
