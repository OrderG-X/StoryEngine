/**
 * 「另外几版」卡（写作版本 P2a 片 2D）：AI 一次写几版时，落选的几版（选优换上了一版）、作者要自己挑的几版（「AI 另写几版」，
 * 一版都没换上）都留成了候选，放在这张卡上。点「点开看」在稿纸上并排打开，挑一版「用这版」交 draft.adopt 换进工作稿
 * （进对话一轮，先存档、可撤销）。
 */
import type { DraftVersionsCardData } from "../../../type-defs/workspace.js";
import { useBookStore } from "../../../stores/bookStore.js";
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
  useUiStore.getState().setDraftCandidates(data.versions.map((version) => ({ ...version, chapter: data.chapter, projectPath })));
  return null;
}

export function DraftVersionsCard({ data, busy }: { readonly data: DraftVersionsCardData; readonly busy: boolean }) {
  const open = () => {
    const blocked = openDraftVersions(data);
    if (blocked) useNavigationStore.getState().showToast(blocked);
  };
  return (
    <div className="se-dir-card" role="group" aria-label={`第 ${data.chapter} 章的${data.pick ? "几版" : "另外几版"}`}>
      <div className="se-dir-h">第 {data.chapter} 章 · {data.pick ? `写了 ${data.versions.length} 版，挑一版` : `另外 ${data.versions.length} 版`}</div>
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
