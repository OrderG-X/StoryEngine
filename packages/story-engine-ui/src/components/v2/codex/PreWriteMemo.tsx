/**
 * 稿纸顶上的「写前备忘」：动笔写一章前看一眼——上一章停在第几天、谁在场，该接哪些线索，最近几章变了什么。
 * 长篇实跑（《镖路》50 章）：核账抓到的错很多是作者忘了前文（天数、谁在哪、东西在谁手上），写之前提醒比写完再查省事。
 *
 * 平时收成一行（和定稿章的「本章梗概」同一个位置）；点开列全，线索和状态点了回原句。
 * 全是账里记的结构（GET /api/pre-write-memo），不读正文、不猜；前面一章都没定稿就不显示。
 */
import { useEffect, useState } from "react";
import { fetchPreWriteMemo, type PreWriteMemo as Memo, type PreWritePrevious, type PreWriteThread } from "../../../api/preWriteMemoClient.js";

const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"] as const;
/** 收起那行最多列几个在场的人。 */
const BRIEF_NAMES = 3;

/** 作者展开过就一直展开（换章也是），收起同理：一次会话里记着。 */
let rememberedOpen = false;

/** 「第 11 天傍晚」「第 3～5 天」；天数是估的就说是估的；这章账待记 / 天数不知道就照说。 */
export function dayText(time: PreWritePrevious["time"]): string {
  if (time.ledgerPending) return "账待记";
  if (time.day === undefined || time.dayEnd === undefined) return "哪天不知道";
  const days = time.dayEnd > time.day ? `第 ${time.day}～${time.dayEnd} 天` : `第 ${time.day} 天${time.timeOfDay ?? ""}`;
  return time.basis === "estimated" || time.basis === "missing" ? `${days}（估的）` : days;
}

/** 收起时那一行：接第几章、停在哪天、谁在场、该接几条线索。 */
export function briefLine(memo: Memo & { readonly previous: PreWritePrevious }): string {
  const { previous } = memo;
  const names = previous.present.length > BRIEF_NAMES
    ? `${previous.present.slice(0, BRIEF_NAMES).join("、")}等 ${previous.present.length} 人`
    : previous.present.join("、");
  const parts = [`接第 ${previous.chapter} 章`, dayText(previous.time)];
  if (names) parts.push(names);
  if (memo.threads.length > 0) parts.push(`${memo.threads.length} 条线索该接`);
  return parts.join(" · ");
}

export function threadTag(thread: PreWriteThread): string {
  if (thread.reason === "previous") return thread.previousOp === "open" ? "上章埋下" : "上章推进";
  if (thread.reason === "stale") return `停了 ${thread.idle} 章`;
  return "大伏笔";
}

export function PreWriteMemo({ projectPath, chapter, refreshKey, busy, onJump }: {
  readonly projectPath: string | undefined;
  readonly chapter: number;
  /** 变了就重读（开书概况每次刷新都换新对象：定稿、撤销、改账之后）。 */
  readonly refreshKey: unknown;
  /** 写作操作进行中先不重读（账在变），沿用手上那份。 */
  readonly busy: boolean;
  readonly onJump?: (chapter: number, quote: string) => void;
}) {
  const [memo, setMemo] = useState<Memo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(rememberedOpen);

  // 换书、换章先清掉，别把上一章的备忘挂在这一章上。
  useEffect(() => {
    setMemo(null);
    setError(null);
  }, [projectPath, chapter]);

  useEffect(() => {
    if (busy || !projectPath || chapter < 2) return undefined;
    const controller = new AbortController();
    void fetchPreWriteMemo(projectPath, chapter, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok) {
        setMemo(result.memo);
        setError(null);
      } else {
        setError(result.error);
      }
    });
    return () => controller.abort();
  }, [projectPath, chapter, refreshKey, busy]);

  const toggle = () => {
    rememberedOpen = !open;
    setOpen(!open);
  };

  if (error && !memo) {
    return (
      <div className="cd-memo is-error" role="status">
        <b>写前备忘</b>
        <span>{error}</span>
      </div>
    );
  }
  if (!memo?.previous || memo.chapter !== chapter) return null;
  const { previous } = memo;
  const jump = (target: number, quote: string | undefined) => (quote && onJump ? () => onJump(target, quote) : undefined);

  return (
    <div className={`cd-memo${open ? " is-open" : ""}`}>
      <button type="button" className="cd-memo-head" aria-expanded={open} onClick={toggle} title={open ? "收起" : "点开看全"}>
        <b>写前备忘</b>
        <span>{briefLine({ ...memo, previous })}</span>
      </button>
      {open ? (
        <div className="cd-memo-body">
          <section aria-label="上一章">
            <h4>上一章</h4>
            <p>
              第 {previous.chapter} 章 · {dayText(previous.time)}
              {previous.time.weekday !== undefined ? ` · ${WEEKDAYS[previous.time.weekday]}` : ""}
            </p>
            {previous.present.length > 0 ? (
              <p>在场：{previous.present.map((name) => (name === previous.viewpoint ? `${name}（视角）` : name)).join("、")}</p>
            ) : null}
            {previous.summary ? <p className="cd-memo-summary">{previous.summary}</p> : null}
          </section>
          {memo.threads.length > 0 ? (
            <section className="cd-memo-threads" aria-label="该接的线索">
              <h4>该接的线索</h4>
              <ul>
                {memo.threads.map((thread) => {
                  const onClick = jump(thread.last.chapter, thread.last.quote);
                  return (
                    <li key={thread.id}>
                      <button type="button" disabled={!onClick} onClick={onClick} title={`${thread.title}\n第 ${thread.last.chapter} 章：${thread.last.note}`}>
                        <span className="cd-memo-text">{thread.title}</span>
                        <em className={thread.reason === "stale" ? "is-warn" : ""}>{threadTag(thread)}</em>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {memo.moreThreads > 0 ? <p className="cd-memo-more">另有 {memo.moreThreads} 条开着</p> : null}
            </section>
          ) : null}
          {memo.changes.length > 0 ? (
            <section aria-label="最近变了">
              <h4>最近变了</h4>
              <ul>
                {memo.changes.map((change, index) => {
                  const onClick = jump(change.chapter, change.quote);
                  return (
                    <li key={`${change.chapter}-${index}`}>
                      <button type="button" disabled={!onClick} onClick={onClick} title={change.quote ? `第 ${change.chapter} 章：${change.quote}` : ""}>
                        <span className="cd-memo-text">{change.subject} · {change.attribute}：{change.value}</span>
                        <em>第 {change.chapter} 章</em>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
