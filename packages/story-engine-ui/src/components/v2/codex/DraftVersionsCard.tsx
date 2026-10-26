/**
 * 「另外几版」卡：AI 一次写几版时，挑中的那版进了工作稿，落选的几版放在这张卡上。
 * 点「点开看」在稿纸上并排打开（和「再来一版」同一个面板），挑一版「用这版」换进工作稿（先存档、可撤销）。
 */
import type { DraftVersionsCardData } from "../../../type-defs/workspace.js";
import { useBookStore } from "../../../stores/bookStore.js";
import { useChatStore } from "../../../stores/chatStore.js";
import { useNavigationStore } from "../../../stores/navigationStore.js";
import { useUiStore } from "../../../stores/uiStore.js";
import { isPaperCommitted } from "../../../drafts/useDraftPreview.js";
import { countTextWords } from "../../../utils/textUtils.js";

/** 把这张卡的几版摆上稿纸；摆不了时返回给作者的那句话。 */
export function openDraftVersions(data: DraftVersionsCardData): string | null {
  const projectPath = useNavigationStore.getState().projectPath ?? "";
  const chapter = useBookStore.getState().workspace.currentChapter.chapterNumber;
  if (!projectPath) return "请先打开本地项目。";
  if (chapter !== data.chapter) return `先打开第 ${data.chapter} 章。`;
  if (isPaperCommitted()) return `第 ${data.chapter} 章已定稿，换不了。`;
  const originTarget = { projectPath, chapter, sessionId: useChatStore.getState().activeSessionId, operationId: `draft-versions-${chapter}` };
  useUiStore.getState().setDraftCandidates(data.versions.map((version) => ({
    // 只换正文：不带标题行，写稿时沿用盘上的章名（作者可能改过）。
    content: version.body,
    version: version.index,
    originTarget,
  })));
  return null;
}

export function DraftVersionsCard({ data, busy }: { readonly data: DraftVersionsCardData; readonly busy: boolean }) {
  const open = () => {
    const blocked = openDraftVersions(data);
    if (blocked) useNavigationStore.getState().showToast(blocked);
  };
  return (
    <div className="se-dir-card" role="group" aria-label={`第 ${data.chapter} 章的另外几版`}>
      <div className="se-dir-h">第 {data.chapter} 章 · 另外 {data.versions.length} 版</div>
      <ul>
        {data.versions.map((version) => (
          <li key={version.index}><span>第 {version.index} 版 · {countTextWords(version.body).toLocaleString()} 字</span></li>
        ))}
      </ul>
      <div className="se-dir-f">
        <button type="button" className="chip" disabled={busy} onClick={open}>点开看</button>
      </div>
    </div>
  );
}
