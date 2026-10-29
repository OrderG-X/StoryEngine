/**
 * 伏笔看板（重构 P6，草图 ④）：取代原来的「伏笔线索」两桶列表。
 *
 *  - 四列：刚埋下 / 在推进 / 停太久 / 已收口，直接是新核心投影里的四种状态（不猜）。
 *  - 点一张卡：展开它的经过（第几章埋、推进、收，各一句话 + 原句）；点原句回写作台那一章、滚到这句。
 *  - 卡上两件事直接点：【这条收了】、调分量（大伏笔 / 普通 / 小线索）。交一次直接改账（ledger.change），
 *    服务端记作者裁定、改前存档可撤销，结果照常进对话——和对 AI 说「把这条收了」记的是同一种裁定。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { newLedgerAction, type AgentUserAction } from "../../../api/agentChatClient.js";
import { fetchThreadBoard, type ThreadBoard as Board, type ThreadBoardItem } from "../../../api/storyThreadsClient.js";
import { PageHead, Skeleton } from "./bibleVisual.js";

type Status = ThreadBoardItem["status"];
type Weight = ThreadBoardItem["weight"];

const COLUMNS: readonly { readonly status: Status; readonly title: string; readonly hint: string }[] = [
  { status: "open", title: "刚埋下", hint: "埋了还没再动" },
  { status: "active", title: "在推进", hint: "后面章节接着写了" },
  { status: "stale", title: "停太久", hint: "好几章没动，别忘了" },
  { status: "closed", title: "已收口", hint: "" },
];

/** 已收口那列先露几条（越写越长），其余点开。 */
const CLOSED_VISIBLE = 12;

const TYPE_LABELS: Record<ThreadBoardItem["type"], string> = { question: "疑问", intent: "打算", goal: "目标" };
const OP_LABELS: Record<ThreadBoardItem["touches"][number]["op"], string> = { open: "埋下", advance: "推进", close: "收口" };
const WEIGHT_LABELS: Record<Weight, string> = { major: "大伏笔", normal: "普通", minor: "小线索" };

export function threadMeta(thread: ThreadBoardItem): string {
  if (thread.status === "closed") {
    const by = thread.closedBy === "author" ? "（你收的）" : "";
    return thread.closedAt !== undefined && thread.closedAt !== thread.openedAt
      ? `第 ${thread.openedAt} 章埋 · 第 ${thread.closedAt} 章收${by}`
      : `第 ${thread.openedAt} 章埋下即收${by}`;
  }
  if (thread.status === "stale") return `停了 ${thread.idle} 章没动`;
  if (thread.status === "active") return `第 ${thread.openedAt} 章埋 · 第 ${thread.lastTouchedAt} 章推进`;
  return `第 ${thread.openedAt} 章埋下`;
}

/** 收掉 / 调分量：直接改账（ledger.change，作者档、改前存档可撤销），和对 AI 说「把这条收了」再点「确认改账」记的是同一种裁定。 */
export function closeThreadAction(thread: ThreadBoardItem, upTo: number): AgentUserAction {
  return newLedgerAction([{ op: "resolve", id: thread.id, chapter: Math.max(1, upTo), title: thread.title }]);
}

export function weighThreadAction(thread: ThreadBoardItem, weight: Weight): AgentUserAction {
  return newLedgerAction([{ op: "importance", id: thread.id, importance: weight, title: thread.title }]);
}

function ThreadCard({ thread, open, onToggle, busy, upTo, onJump, onAction }: {
  readonly thread: ThreadBoardItem;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly busy: boolean;
  readonly upTo: number;
  readonly onJump?: (chapter: number, quote: string) => void;
  readonly onAction?: (action: AgentUserAction) => void;
}) {
  return (
    <li className={`se-tb-card${open ? " is-open" : ""}${thread.weight === "major" ? " is-major" : ""}`}>
      <button type="button" className="se-tb-head" aria-expanded={open} onClick={onToggle}>
        <span className="se-tb-tags">
          <span className="se-tb-type">{TYPE_LABELS[thread.type]}</span>
          {thread.weight !== "normal" ? <span className={`se-tb-weight is-${thread.weight}`}>{WEIGHT_LABELS[thread.weight]}</span> : null}
        </span>
        <span className="se-tb-title">{thread.title}</span>
        <span className="se-tb-meta">{threadMeta(thread)}</span>
      </button>
      {open ? (
        <div className="se-tb-body">
          <ol className="se-tb-touches" aria-label="经过">
            {thread.touches.map((touch, index) => (
              <li key={`${touch.chapter}-${index}`}>
                <span className="se-tb-when">第 {touch.chapter} 章 · {OP_LABELS[touch.op]}</span>
                {/* 埋下那笔的一句话常常就是标题，一样就不再写一遍。 */}
                {touch.note !== thread.title ? <span className="se-tb-note">{touch.note}</span> : null}
                {touch.quote ? (
                  onJump ? (
                    <button type="button" className="se-tb-quote serif" title="回稿纸看这句" onClick={() => onJump(touch.chapter, touch.quote!)}>
                      「{touch.quote}」
                    </button>
                  ) : <span className="se-tb-quote serif">「{touch.quote}」</span>
                ) : null}
              </li>
            ))}
          </ol>
          {thread.status !== "closed" && onAction ? (
            <div className="se-tb-actions">
              <button type="button" className="se-tb-close" disabled={busy || upTo < 1} onClick={() => onAction(closeThreadAction(thread, upTo))}>这条收了</button>
              <div className="se-tb-seg" role="group" aria-label="分量">
                {(["major", "normal", "minor"] as const).map((weight) => (
                  <button
                    key={weight}
                    type="button"
                    aria-pressed={thread.weight === weight}
                    className={thread.weight === weight ? "on" : ""}
                    disabled={busy || thread.weight === weight}
                    onClick={() => onAction(weighThreadAction(thread, weight))}
                  >
                    {WEIGHT_LABELS[weight]}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** 上次读到的看板（按书）：切回来先显示它、后台再读，不闪「正在读」。 */
const lastBoards = new Map<string, Board>();

export function ThreadBoard({ projectPath, busy, onJump, onAction }: {
  readonly projectPath: string;
  /** 有动作在跑：按钮先不让点；跑完重读一次（收掉 / 调分量之后看板跟着变）。 */
  readonly busy: boolean;
  readonly onJump?: (chapter: number, quote: string) => void;
  readonly onAction?: (action: AgentUserAction) => void;
}) {
  const [board, setBoard] = useState<Board | null>(() => lastBoards.get(projectPath) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [showAllClosed, setShowAllClosed] = useState(false);
  const [reloadSeq, setReloadSeq] = useState(0);
  const reload = useCallback(() => setReloadSeq((seq) => seq + 1), []);

  useEffect(() => {
    if (busy || !projectPath) return undefined;
    const controller = new AbortController();
    void fetchThreadBoard(projectPath, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok) {
        lastBoards.set(projectPath, result.board);
        setBoard(result.board);
        setError(null);
      } else {
        setError(result.error);
      }
    });
    return () => controller.abort();
  }, [projectPath, busy, reloadSeq]);

  const columns = useMemo(() => COLUMNS.map((column) => ({
    ...column,
    threads: board?.threads.filter((thread) => thread.status === column.status) ?? [],
  })), [board]);

  if (!board) {
    return (
      <section className="se-tb" aria-label="伏笔与线索">
        <PageHead title="伏笔与线索" />
        {error ? (
          <p className="se-tb-error">{error} <button type="button" className="se-tb-retry" onClick={reload}>再读一次</button></p>
        ) : <Skeleton label="正在读线索…" />}
      </section>
    );
  }

  const openCount = board.threads.filter((thread) => thread.status !== "closed").length;
  const staleCount = columns.find((column) => column.status === "stale")?.threads.length ?? 0;
  const closedCount = board.threads.length - openCount;

  return (
    <section className="se-tb" aria-label="伏笔与线索">
      <PageHead
        title="伏笔与线索"
        sub={board.threads.length === 0 ? "还没有线索：定稿时记账员会把埋下的伏笔记在这里。" : `算到第 ${board.upTo} 章。点一条看经过，点原句回稿纸。`}
        stats={[{ value: openCount, label: "开着" }, { value: staleCount, label: "停太久" }, { value: closedCount, label: "已收" }]}
      />
      {error ? <p className="se-tb-error">{error} <button type="button" className="se-tb-retry" onClick={reload}>再读一次</button></p> : null}
      {board.threads.length > 0 ? (
        <div className="se-tb-cols">
          {columns.map((column) => {
            const shown = column.status === "closed" && !showAllClosed ? column.threads.slice(0, CLOSED_VISIBLE) : column.threads;
            return (
              <section key={column.status} className={`se-tb-col is-${column.status}`} aria-label={`${column.title} ${column.threads.length} 条`}>
                <h3 className="se-tb-col-h">
                  <span>{column.title}</span>
                  <b>{column.threads.length}</b>
                </h3>
                {column.hint ? <p className="se-tb-col-hint">{column.hint}</p> : null}
                {column.threads.length === 0 ? <p className="se-tb-none">没有</p> : (
                  <ul className="se-tb-list">
                    {shown.map((thread) => (
                      <ThreadCard
                        key={thread.id}
                        thread={thread}
                        open={openId === thread.id}
                        onToggle={() => setOpenId((current) => (current === thread.id ? null : thread.id))}
                        busy={busy}
                        upTo={board.upTo}
                        {...(onJump ? { onJump } : {})}
                        {...(onAction ? { onAction } : {})}
                      />
                    ))}
                  </ul>
                )}
                {column.status === "closed" && column.threads.length > CLOSED_VISIBLE ? (
                  <button type="button" className="se-tb-more" onClick={() => setShowAllClosed((all) => !all)}>
                    {showAllClosed ? "收起" : `还有 ${column.threads.length - CLOSED_VISIBLE} 条`}
                  </button>
                ) : null}
              </section>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
