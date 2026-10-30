/**
 * 故事地图（重构 P6，草图 ③）：取代原来的「时间线」列表。
 *
 *  - 一行一章：章号、故事第几天（星期 / 时段，按旧账推的标「约」，整章回忆、梦的标出来）、这章讲了什么；
 *    隔了几天、往回接了几天在两行之间标出来。
 *  - 一列一个人：这章出场画一个点，视角人物画空心圈；点一下回写作台那一章、滚到他出场那句（老书导入的章没记原句，只打开那章）。
 *  - 人多时先看出场最多的 8 个，点「全部 N 人」再展开。
 *  - 节奏：每章一根条（每千字推进几条线索，竖线是全书平常），可能拖 / 赶的章打个记号，上面列出原因，点了滚到那一行。
 * 数据直接是新核心投影（定稿时记账员记的），不猜。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchStoryMap, type PaceChapter, type PaceFlag, type PaceReport, type StoryMap as MapData, type StoryMapChapter } from "../../../api/storyMapClient.js";
import { paceNote, paceRange, paceReason } from "../../../lib/pace-text.js";
import { Avatar, PageHead, Skeleton } from "./bibleVisual.js";

/** 先露出场最多的几个人。 */
const CAST_VISIBLE = 8;
const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"] as const;

export function dayLabel(row: StoryMapChapter): string {
  if (row.ledgerShort === "pending") return "账待记";
  if (row.presentLine === false) return "不在当下";
  return row.days ?? (row.ledgerShort === "partial" ? "账没记全" : "不知道");
}

export function dayDetail(row: StoryMapChapter): string {
  const weekday = row.weekday === undefined ? "" : `${WEEKDAYS[row.weekday] ?? ""}${row.weekdayDerived ? "（推）" : ""}`;
  return [weekday, row.timeOfDay ?? "", ...row.segments].filter(Boolean).join(" · ");
}

/** 节奏条最长画到平常的几倍。 */
const PACE_BAR_CAP = 3;
/** 上面先列几处原因（多了点「全部 N 处」再展开）。 */
const PACE_NOTES_VISIBLE = 4;
/** 点了原因、那一行亮多久。 */
const PACE_FLASH_MS = 1800;

/** 节奏格的悬停说明：字数、推进几条；被标了就带上原因。 */
export function paceCellTitle(row: PaceChapter, flags: readonly PaceFlag[]): string {
  const counts = [`${row.words.toLocaleString("zh-CN")} 字`, `推进 ${row.advanced}`, `收 ${row.closed}`];
  if (row.opened > 0) counts.push(`新开 ${row.opened}`);
  const lines = [counts.join(" · ")];
  if (row.density === undefined) lines.push("字太少、或前面还没有线索可推，不算");
  for (const flag of flags) lines.push(`可能${flag.kind === "drag" ? "拖" : "赶"}：${paceReason(flag)}`);
  return lines.join("\n");
}

/** 节奏条长度（%）：按全书平常算，平常在三分之一处。 */
export function paceBarWidth(row: PaceChapter, report: PaceReport): number {
  if (row.density === undefined || !report.typical) return 0;
  return Math.round((Math.min(row.density / report.typical.density, PACE_BAR_CAP) / PACE_BAR_CAP) * 100);
}

const lastMaps = new Map<string, MapData>();

export function StoryMap({ projectPath, busy, chapterTitles, onJump, onOpenChapter }: {
  readonly projectPath: string;
  /** 有动作在跑：跑完重读一次（定稿后地图跟着变）。 */
  readonly busy: boolean;
  /** 章号 → 章名（工作台章节列表里的）。 */
  readonly chapterTitles: ReadonlyMap<number, string>;
  readonly onJump?: (chapter: number, quote: string) => void;
  readonly onOpenChapter?: (chapter: number) => void;
}) {
  const [map, setMap] = useState<MapData | null>(() => lastMaps.get(projectPath) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [showAllCast, setShowAllCast] = useState(false);
  const [reloadSeq, setReloadSeq] = useState(0);
  const reload = useCallback(() => setReloadSeq((seq) => seq + 1), []);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [flashChapter, setFlashChapter] = useState<number | null>(null);
  useEffect(() => {
    if (flashChapter === null) return undefined;
    const timer = window.setTimeout(() => setFlashChapter(null), PACE_FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [flashChapter]);
  const showRow = (chapter: number) => {
    scrollRef.current?.querySelector(`tr[data-chapter="${chapter}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    setFlashChapter(chapter);
  };

  useEffect(() => {
    if (busy || !projectPath) return undefined;
    const controller = new AbortController();
    void fetchStoryMap(projectPath, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok) {
        lastMaps.set(projectPath, result.map);
        setMap(result.map);
        setError(null);
      } else {
        setError(result.error);
      }
    });
    return () => controller.abort();
  }, [projectPath, busy, reloadSeq]);

  const cast = useMemo(() => (map ? (showAllCast ? map.cast : map.cast.slice(0, CAST_VISIBLE)) : []), [map, showAllCast]);
  const pace = map?.pace;
  const paceOf = useMemo(() => new Map((pace?.chapters ?? []).map((row) => [row.chapter, row])), [pace]);
  const flagsOf = useMemo(() => {
    const byChapter = new Map<number, PaceFlag[]>();
    for (const flag of pace?.flags ?? []) {
      for (let chapter = flag.from; chapter <= flag.to; chapter += 1) byChapter.set(chapter, [...(byChapter.get(chapter) ?? []), flag]);
    }
    return byChapter;
  }, [pace]);
  const quoteOf = useMemo(() => {
    const quotes = new Map<string, string>();
    for (const member of map?.cast ?? []) for (const item of member.appearances) quotes.set(`${member.name}\u0000${item.chapter}`, item.quote);
    return quotes;
  }, [map]);

  if (!map) {
    return (
      <section className="se-sm" aria-label="故事地图">
        <PageHead title="故事地图" />
        {error ? (
          <p className="se-sm-error">{error} <button type="button" className="se-sm-link" onClick={reload}>再读一次</button></p>
        ) : <Skeleton />}
      </section>
    );
  }

  return (
    <section className="se-sm" aria-label="故事地图">
      <PageHead
        title="故事地图"
        sub={map.chapters.length === 0 ? "还没有定稿的章：定稿时记账员会把每章第几天、谁出场记在这里。" : "一行一章，一列一人。点圆点回到他出场那句。"}
        stats={[{ value: map.chapters.length, label: "章" }, { value: map.lastDay ?? 0, label: "故事日" }, { value: map.cast.length, label: "人出场" }]}
      />
      {error ? <p className="se-sm-error">{error} <button type="button" className="se-sm-link" onClick={reload}>再读一次</button></p> : null}
      {map.chapters.length > 0 ? (
        <>
          <div className="se-sm-legend">
            <span aria-hidden="true"><i className="se-sm-dot" /> 出场</span>
            <span aria-hidden="true"><i className="se-sm-dot is-pov" /> 视角</span>
            {map.cast.length > CAST_VISIBLE ? (
              <button type="button" className="se-sm-link" onClick={() => setShowAllCast((all) => !all)}>
                {showAllCast ? `只看出场最多的 ${CAST_VISIBLE} 人` : `全部 ${map.cast.length} 人`}
              </button>
            ) : null}
          </div>
          {pace ? <PaceNotes report={pace} onShow={showRow} /> : null}
          <div className="se-sm-scroll" ref={scrollRef}>
            <table className="se-sm-table">
              <thead>
                <tr>
                  <th scope="col" className="se-sm-ch">章</th>
                  <th scope="col" className="se-sm-day">故事日</th>
                  <th scope="col" className="se-sm-what">这章</th>
                  {pace ? <th scope="col" className="se-sm-pace" title="每千字推进几条线索（收一条算两条），竖线是全书平常">节奏</th> : null}
                  {cast.map((member) => (
                    <th key={member.name} scope="col" className="se-sm-who" title={member.aliases.length > 0 ? `也叫：${member.aliases.join("、")}` : member.name}>
                      <Avatar name={member.name} kind="character" />
                      <span>{member.name}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {map.chapters.map((row) => {
                  const { gap, unsure } = row;
                  const title = chapterTitles.get(row.chapter);
                  return [
                    gap ? (
                      <tr key={`gap-${row.chapter}`} className="se-sm-gap">
                        <td colSpan={(pace ? 4 : 3) + cast.length}><span>{gap}</span></td>
                      </tr>
                    ) : null,
                    <tr key={row.chapter} data-chapter={row.chapter} className={flashChapter === row.chapter ? "is-flash" : undefined}>
                      <th scope="row" className="se-sm-ch">
                        {onOpenChapter ? (
                          <button type="button" className="se-sm-chbtn" onClick={() => onOpenChapter(row.chapter)}>第 {row.chapter} 章</button>
                        ) : <span>第 {row.chapter} 章</span>}
                        {title ? <span className="se-sm-title">{title}</span> : null}
                      </th>
                      <td className="se-sm-day">
                        <span>{dayLabel(row)}{unsure ? <em className="se-sm-unsure" title={unsure}>约</em> : null}</span>
                        {dayDetail(row) ? <small>{dayDetail(row)}</small> : null}
                      </td>
                      <td className="se-sm-what">{row.summary ? <span title={row.summary}>{row.summary}</span> : <span className="se-sm-faint">—</span>}</td>
                      {pace ? <PaceCell row={paceOf.get(row.chapter)} report={pace} flags={flagsOf.get(row.chapter) ?? []} /> : null}
                      {cast.map((member) => {
                        if (!row.present.includes(member.name)) return <td key={member.name} className="se-sm-cell" />;
                        const quote = quoteOf.get(`${member.name}\u0000${row.chapter}`);
                        const pov = row.viewpoint === member.name;
                        const label = `${member.name}，第 ${row.chapter} 章${pov ? "（视角）" : ""}出场`;
                        const dotClass = `se-sm-dot${pov ? " is-pov" : ""}`;
                        // 有原句：回稿纸滚到这句；老书导入的章没记原句：只打开那一章。
                        const onClick = quote && onJump ? () => onJump(row.chapter, quote) : onOpenChapter ? () => onOpenChapter(row.chapter) : undefined;
                        const title = quote ? `「${quote}」` : "这章没记他出场那句，点开看这一章";
                        return (
                          <td key={member.name} className="se-sm-cell">
                            {onClick ? (
                              <button type="button" className={dotClass} aria-label={label} title={title} onClick={onClick} />
                            ) : <i className={dotClass} aria-label={label} title={quote ? title : undefined} />}
                          </td>
                        );
                      })}
                    </tr>,
                  ];
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}

function PaceCell({ row, report, flags }: { readonly row: PaceChapter | undefined; readonly report: PaceReport; readonly flags: readonly PaceFlag[] }) {
  if (!row) return <td className="se-sm-pace"><span className="se-sm-faint">—</span></td>;
  const width = paceBarWidth(row, report);
  return (
    <td className="se-sm-pace" title={paceCellTitle(row, flags)}>
      <span className="se-sm-pacecell">
        {row.density === undefined || !report.typical ? <span className="se-sm-faint">—</span> : (
          <span className="se-sm-pacebar" aria-hidden="true"><i className={row.pace ? `is-${row.pace}` : ""} style={{ width: `${width}%` }} /></span>
        )}
        {row.pace ? <em className={`se-sm-pacetag is-${row.pace}`}>{row.pace === "slow" ? "拖" : "赶"}</em> : null}
      </span>
    </td>
  );
}

/** 表格上面那几句：哪几章可能拖 / 赶、为什么；点了滚到那一行。 */
function PaceNotes({ report, onShow }: { readonly report: PaceReport; readonly onShow: (chapter: number) => void }) {
  const [showAll, setShowAll] = useState(false);
  if (!report.typical) {
    return <p className="se-sm-pacenote se-sm-faint">节奏：能比较的定稿章还少（或账里记的线索推进太少），先不下结论。</p>;
  }
  if (report.flags.length === 0) return <p className="se-sm-pacenote se-sm-faint">节奏：没看出明显拖或赶的章。</p>;
  return (
    <div className="se-sm-pacelist" aria-label="节奏">
      <b>节奏</b>
      <ul>
        {(showAll ? report.flags : report.flags.slice(0, PACE_NOTES_VISIBLE)).map((flag) => (
          <li key={`${flag.reason}-${flag.from}`}>
            <button type="button" onClick={() => onShow(flag.from)} title={paceNote(flag)}>
              <em className={`se-sm-pacetag is-${flag.kind === "drag" ? "slow" : "fast"}`}>{flag.kind === "drag" ? "拖" : "赶"}</em>
              <span className="se-sm-pacech">{paceRange(flag)}</span>
              <span className="se-sm-pacewhy">{paceReason(flag)}</span>
            </button>
          </li>
        ))}
        {report.flags.length > PACE_NOTES_VISIBLE ? (
          <li>
            <button type="button" className="se-sm-link" onClick={() => setShowAll((all) => !all)}>
              {showAll ? "收起" : `全部 ${report.flags.length} 处`}
            </button>
          </li>
        ) : null}
      </ul>
    </div>
  );
}
