/**
 * 设定本「这章改了什么」（重构 P6 第 6 步：定稿后设定本标出本章改了什么）。
 *
 *  - 一章一页：故事第几天、这章讲了什么、第一次出场的人、线索（新埋下 / 推进 / 收口）、记下的事（顶掉了哪条旧说法）。
 *  - 有原句的点一下回写作台那一章、滚到那句。‹ › 翻上一章 / 下一章（只翻定稿了的章）。
 *  - 刚定稿完顶栏「设定本」亮小点，点进来先到这一页、看的就是刚定的那章。
 * 数据直接是新核心投影（定稿时记账员记的），不猜。
 */
import { useCallback, useEffect, useState } from "react";
import { fetchChapterChanges, type ChapterChangeThread, type ChapterChanges as Changes } from "../../../api/chapterChangesClient.js";
import { chapterBareTitle } from "../v2Utils.js";
import { Avatar, PageHead, Sec, Skeleton } from "./bibleVisual.js";

const THREAD_OP: Record<ChapterChangeThread["op"], string> = { open: "新埋下", advance: "推进", close: "收口" };
/** 每组先露这么多条，多的点「再看 N 条」。 */
const GROUP_VISIBLE = 6;

/** 展开记在「哪一章展开了」上：翻到别的章自然收起。不用 effect 重置——effect 晚一拍会把刚点的展开冲掉。 */
function useFold<T>(items: readonly T[], resetKey: number): { readonly shown: readonly T[]; readonly more: number; readonly open: () => void } {
  const [openKey, setOpenKey] = useState<number | null>(null);
  const all = openKey === resetKey;
  return { shown: all ? items : items.slice(0, GROUP_VISIBLE), more: all ? 0 : Math.max(0, items.length - GROUP_VISIBLE), open: () => setOpenKey(resetKey) };
}

function More({ count, onClick }: { readonly count: number; readonly onClick: () => void }) {
  return count > 0 ? <button type="button" className="se-sm-link se-cc-more" onClick={onClick}>再看 {count} 条</button> : null;
}

function Quote({ chapter, quote, onJump }: { readonly chapter: number; readonly quote: string; readonly onJump?: (chapter: number, quote: string) => void }) {
  return onJump ? (
    <button type="button" className="se-tb-quote serif" title="回稿纸看这句" onClick={() => onJump(chapter, quote)}>「{quote}」</button>
  ) : <span className="se-tb-quote serif">「{quote}」</span>;
}

export function ChapterChanges({ projectPath, chapter: initialChapter, busy, chapterTitles, onJump }: {
  readonly projectPath: string;
  /** 先看哪一章（刚定稿的那章 / 当前章）；不给＝最近定稿的那章。 */
  readonly chapter?: number;
  /** 有动作在跑：跑完重读一次。 */
  readonly busy: boolean;
  readonly chapterTitles: ReadonlyMap<number, string>;
  readonly onJump?: (chapter: number, quote: string) => void;
}) {
  const [chapter, setChapter] = useState<number | undefined>(initialChapter);
  const [changes, setChanges] = useState<Changes | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadSeq, setReloadSeq] = useState(0);
  const reload = useCallback(() => setReloadSeq((seq) => seq + 1), []);

  useEffect(() => setChapter(initialChapter), [initialChapter]);
  useEffect(() => {
    if (busy || !projectPath) return undefined;
    const controller = new AbortController();
    void fetchChapterChanges(projectPath, chapter, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok) {
        setChanges(result.changes);
        setError(null);
      } else {
        setChanges(null);
        setError(result.error);
      }
    });
    return () => controller.abort();
  }, [projectPath, chapter, busy, reloadSeq]);

  const threadFold = useFold(changes?.threads ?? [], changes?.chapter ?? 0);
  const factFold = useFold(changes?.facts ?? [], changes?.chapter ?? 0);

  if (!changes) {
    return (
      <section className="se-sm se-cc" aria-label="这章改了什么">
        <PageHead title="这章改了什么" />
        {error ? (
          <p className="se-sm-error">{error} <button type="button" className="se-sm-link" onClick={reload}>再读一次</button></p>
        ) : <Skeleton />}
      </section>
    );
  }

  const index = changes.chapters.indexOf(changes.chapter);
  const prev = index > 0 ? changes.chapters[index - 1] : undefined;
  const next = index >= 0 && index < changes.chapters.length - 1 ? changes.chapters[index + 1] : undefined;
  // 章名表里有的带「第N章 ·」前缀（工作稿刚定稿那章），只取章名。
  const title = chapterBareTitle(chapterTitles.get(changes.chapter) ?? "");
  const day = changes.day === undefined || changes.dayEnd === undefined
    ? "哪天不知道"
    : changes.dayEnd > changes.day ? `故事第 ${changes.day}～${changes.dayEnd} 天` : `故事第 ${changes.day} 天`;
  const nothing = !changes.ledgerPending && changes.newCast.length === 0 && changes.threads.length === 0 && changes.facts.length === 0;
  return (
    <section className="se-sm se-cc" aria-label="这章改了什么">
      <PageHead
        kicker="设定本 · 这章改了什么"
        title={`第 ${changes.chapter} 章${title ? ` · ${title}` : ""} 改了什么`}
        sub={`${day}${changes.summary ? ` · ${changes.summary}` : ""}`}
        aside={prev !== undefined || next !== undefined ? (
          <nav className="se-cc-nav" aria-label="翻章">
            {prev !== undefined ? <button type="button" className="se-cc-turn" onClick={() => setChapter(prev)}>‹ 第 {prev} 章</button> : null}
            {next !== undefined ? <button type="button" className="se-cc-turn" onClick={() => setChapter(next)}>第 {next} 章 ›</button> : null}
          </nav>
        ) : undefined}
      />
      {changes.ledgerPending ? <p className="se-bk-blank">这章的账还没记上。</p> : null}
      {nothing ? <p className="se-bk-blank">这章定稿时没记下新的人、线索和事。</p> : null}
      {changes.newCast.length > 0 ? (
        <div className="se-cc-block is-cast">
          <Sec title="第一次出场" count={changes.newCast.length} />
          <ul className="se-cc-list">
            {changes.newCast.map((member) => (
              <li key={member.name}>
                <span className="se-cc-who"><Avatar name={member.name} kind="character" />{member.name}</span>
                {member.quote ? <Quote chapter={changes.chapter} quote={member.quote} {...(onJump ? { onJump } : {})} /> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {changes.threads.length > 0 ? (
        <div className="se-cc-block">
          <Sec title="线索" count={changes.threads.length} />
          <ul className="se-cc-list">
            {threadFold.shown.map((thread, i) => (
              <li key={`${thread.op}-${thread.title}-${i}`}>
                <span className={`se-cc-op is-${thread.op}`}>{THREAD_OP[thread.op]}</span>
                <span className="se-cc-text"><b>{thread.title}</b>{thread.note ? `：${thread.note}` : ""}</span>
                {thread.quote ? <Quote chapter={changes.chapter} quote={thread.quote} {...(onJump ? { onJump } : {})} /> : null}
              </li>
            ))}
          </ul>
          <More count={threadFold.more} onClick={threadFold.open} />
        </div>
      ) : null}
      {changes.facts.length > 0 ? (
        <div className="se-cc-block">
          <Sec title="记下的事" count={changes.facts.length} />
          <ul className="se-cc-list">
            {factFold.shown.map((fact, i) => (
              <li key={`${fact.text}-${i}`} className={fact.later ? "is-later" : ""}>
                <span className="se-cc-text">
                  {fact.text}
                  {fact.auto ? <em className="se-cc-tag" title="记账员定稿时自动记的，你没逐条看过">自动记的</em> : null}
                  {fact.later ? <em className="se-cc-tag is-warn">{fact.later === "retracted" ? "后来撤了" : "后来改了"}</em> : null}
                </span>
                {fact.replaces ? <span className="se-cc-was">原来：{fact.replaces}</span> : null}
                {fact.quote ? <Quote chapter={changes.chapter} quote={fact.quote} {...(onJump ? { onJump } : {})} /> : null}
              </li>
            ))}
          </ul>
          <More count={factFold.more} onClick={factFold.open} />
        </div>
      ) : null}
    </section>
  );
}
