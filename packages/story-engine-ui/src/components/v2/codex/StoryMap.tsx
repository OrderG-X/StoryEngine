/**
 * 故事地图（重构 P6，草图 ③）：取代原来的「时间线」列表。
 *
 *  - 一行一章：章号、故事第几天（星期 / 时段，估的标「估」）、这章讲了什么；隔了几天在两行之间标出来。
 *  - 一列一个人：这章出场画一个点，视角人物画空心圈；点一下回写作台那一章、滚到他出场那句（老书导入的章没记原句，只打开那章）。
 *  - 人多时先看出场最多的 8 个，点「全部 N 人」再展开。
 * 数据直接是新核心投影（定稿时记账员记的），不猜。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchStoryMap, type StoryMap as MapData, type StoryMapChapter } from "../../../api/storyMapClient.js";
import { Avatar, PageHead, Skeleton } from "./bibleVisual.js";

/** 先露出场最多的几个人。 */
const CAST_VISIBLE = 8;
const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"] as const;
const UNSURE_BASIS: Partial<Record<StoryMapChapter["basis"], string>> = {
  estimated: "估计的",
  missing: "这章没记时间，按上一章 +1 天算的",
};

export function dayLabel(row: StoryMapChapter): string {
  return row.dayEnd > row.day ? `第 ${row.day}～${row.dayEnd} 天` : `第 ${row.day} 天`;
}

export function dayDetail(row: StoryMapChapter): string {
  const weekday = row.weekday === undefined ? "" : `${WEEKDAYS[row.weekday] ?? ""}${row.weekdayDerived ? "（推）" : ""}`;
  return [weekday, row.timeOfDay ?? ""].filter(Boolean).join(" · ");
}

/** 上一章结束到这章开头过了几天（≥2 才标，隔天、同一天不标）。 */
export function daysPassed(previous: StoryMapChapter | undefined, row: StoryMapChapter): number {
  if (!previous) return 0;
  const passed = row.day - previous.dayEnd;
  return passed >= 2 ? passed : 0;
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

  const last = map.chapters.at(-1);
  return (
    <section className="se-sm" aria-label="故事地图">
      <PageHead
        title="故事地图"
        sub={map.chapters.length === 0 ? "还没有定稿的章：定稿时记账员会把每章第几天、谁出场记在这里。" : "一行一章，一列一人。点圆点回到他出场那句。"}
        stats={[{ value: map.chapters.length, label: "章" }, { value: map.chapters.length > 0 ? last?.dayEnd ?? 1 : 0, label: "故事日" }, { value: map.cast.length, label: "人出场" }]}
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
          <div className="se-sm-scroll">
            <table className="se-sm-table">
              <thead>
                <tr>
                  <th scope="col" className="se-sm-ch">章</th>
                  <th scope="col" className="se-sm-day">故事日</th>
                  <th scope="col" className="se-sm-what">这章</th>
                  {cast.map((member) => (
                    <th key={member.name} scope="col" className="se-sm-who" title={member.aliases.length > 0 ? `也叫：${member.aliases.join("、")}` : member.name}>
                      <Avatar name={member.name} kind="character" />
                      <span>{member.name}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {map.chapters.map((row, index) => {
                  const passed = daysPassed(map.chapters[index - 1], row);
                  const unsure = UNSURE_BASIS[row.basis];
                  const title = chapterTitles.get(row.chapter);
                  return [
                    passed > 0 ? (
                      <tr key={`gap-${row.chapter}`} className="se-sm-gap">
                        <td colSpan={3 + cast.length}><span>过了 {passed} 天</span></td>
                      </tr>
                    ) : null,
                    <tr key={row.chapter}>
                      <th scope="row" className="se-sm-ch">
                        {onOpenChapter ? (
                          <button type="button" className="se-sm-chbtn" onClick={() => onOpenChapter(row.chapter)}>第 {row.chapter} 章</button>
                        ) : <span>第 {row.chapter} 章</span>}
                        {title ? <span className="se-sm-title">{title}</span> : null}
                      </th>
                      <td className="se-sm-day">
                        <span>{dayLabel(row)}{unsure ? <em className="se-sm-unsure" title={unsure}>估</em> : null}</span>
                        {dayDetail(row) ? <small>{dayDetail(row)}</small> : null}
                      </td>
                      <td className="se-sm-what">{row.summary ? <span title={row.summary}>{row.summary}</span> : <span className="se-sm-faint">—</span>}</td>
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
