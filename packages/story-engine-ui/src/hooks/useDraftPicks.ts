/**
 * 挑 AI 稿（写作版本 P2a 片 2D）：稿纸提示条「换成 AI 这版 / 不要了」、「另外几版」并排面板「用这版」、稿纸底栏「AI 另写几版」，
 * 都交操作、进对话一轮（draft.adopt / draft.discard / draft.change write 作者自己挑），操作卡跟着走，做完按盘上重读稿纸。
 * 换上前先存作者没存的字，带作者眼前那份的版本号：存完之后稿子又变了就不换（服务端核、如实说）。
 */
import { newCandidateAction, newDraftAction, type AgentUserAction } from "../api/agentChatClient.js";
import { flushDraftSave, type PaperDecisionResult } from "../drafts/draftSync.js";
import { isPaperCommitted } from "../drafts/useDraftPreview.js";
import { useDraftStore } from "../stores/draftStore.js";
import { useNavigationStore } from "../stores/navigationStore.js";
import { useUiStore, type DraftCandidate } from "../stores/uiStore.js";

type SendUserAction = (action: AgentUserAction, options?: { readonly echo?: string }) => Promise<void>;

/** 「AI 另写几版」一次写几版。 */
const REROLL_VERSIONS = 2;

/** 先存掉作者手上的字，拿眼前那份的版本号；存不上、撞了版本（眼前的和盘上的不是一份）就不交。 */
async function savedBaseVersion(): Promise<{ readonly ok: true; readonly baseVersion: string | null } | { readonly ok: false; readonly error: string }> {
  const flushed = await flushDraftSave();
  if (!flushed.ok) return { ok: false, error: `你手上的字还没存上（${flushed.error}），没换。` };
  const paper = useDraftStore.getState();
  const cause = paper.incoming?.cause;
  if (cause === "conflict" || cause === "update") return { ok: false, error: "稿纸上方有一条「稿子在别处改过」的提示，先选好用哪一版再来。" };
  return { ok: true, baseVersion: paper.baseVersion };
}

export function useDraftPicks({ sendUserAction }: { readonly sendUserAction: SendUserAction }) {
  /** 稿纸提示条上那份 AI 稿：换上 / 不要了。 */
  const decidePending = async (decision: "adopt" | "discard"): Promise<PaperDecisionResult> => {
    const paper = useDraftStore.getState();
    const pending = paper.incoming?.cause === "candidate" ? paper.incoming.pending : undefined;
    if (!pending || pending.kind !== "candidate") return { ok: true };
    const pick = { chapter: paper.chapter, candidateId: pending.id, sha: pending.sha };
    if (decision === "discard") {
      await sendUserAction(newCandidateAction("draft.discard", pick), { echo: `第 ${pick.chapter} 章 AI 写好的那版不要了` });
      return { ok: true };
    }
    const saved = await savedBaseVersion();
    if (!saved.ok) return saved;
    // 存的时候撞了版本、提示换成了别的：作者看到的不是这份了。
    if (useDraftStore.getState().incoming?.pending?.id !== pending.id) return { ok: false, error: "稿子刚才存的时候撞了版本，先看一眼上面那条提示。" };
    await sendUserAction(newCandidateAction("draft.adopt", { ...pick, baseVersion: saved.baseVersion }), { echo: `第 ${pick.chapter} 章换成 AI 写好的那版` });
    return { ok: true };
  };

  /** 「另外几版」并排面板上点「用这版」。 */
  const adoptVersion = async (candidate: DraftCandidate): Promise<void> => {
    const toast = useNavigationStore.getState().showToast;
    const paper = useDraftStore.getState();
    if (candidate.projectPath !== useNavigationStore.getState().projectPath || candidate.chapter !== paper.chapter) {
      toast(`先打开第 ${candidate.chapter} 章。`);
      return;
    }
    const saved = await savedBaseVersion();
    if (!saved.ok) {
      toast(saved.error, 4200);
      return;
    }
    useUiStore.getState().setDraftCandidates(null);
    await sendUserAction(
      newCandidateAction("draft.adopt", { chapter: candidate.chapter, candidateId: candidate.candidateId, sha: candidate.sha, baseVersion: saved.baseVersion }),
      { echo: `第 ${candidate.chapter} 章换成第 ${candidate.index} 版` },
    );
  };

  /** 稿纸底栏「AI 另写几版」：另写两版摆给作者挑，作者的稿子不动。 */
  const rerollVersions = async (): Promise<void> => {
    const toast = useNavigationStore.getState().showToast;
    const paper = useDraftStore.getState();
    if (!paper.loaded || paper.chapter <= 0) {
      toast("请先打开一章。");
      return;
    }
    if (isPaperCommitted()) {
      toast("本章已定稿，正文只读；要另写请在对话里说重写。");
      return;
    }
    await sendUserAction(newDraftAction("write", { chapter: paper.chapter, candidates: REROLL_VERSIONS, pick: "author" }), {
      echo: `第 ${paper.chapter} 章另写 ${REROLL_VERSIONS} 版给我挑`,
    });
  };

  return { decidePending, adoptVersion, rerollVersions } as const;
}
