/**
 * 作者在设定本里直接改了设定（重构 P9）：重读开书概况、刷新工作区（主角、待处理、书架简介跟着变）。
 * 读不到不报错：设定本自己已经重读了，概况下次刷新会跟上。
 */
import { fetchStateOverview } from "../api/client.js";
import { useNavigationStore } from "../stores/navigationStore.js";
import { applyOverviewToWorkspace } from "./applyOverview.js";

export async function refreshOverviewNow(projectPath: string): Promise<void> {
  try {
    const overview = await fetchStateOverview({ projectPath, maxTimelineEvents: 8 });
    if (useNavigationStore.getState().projectPath === projectPath) applyOverviewToWorkspace(overview);
  } catch {
    /* 见上 */
  }
}
