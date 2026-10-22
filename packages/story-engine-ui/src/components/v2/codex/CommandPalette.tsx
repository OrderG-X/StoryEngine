/**
 * CommandPalette —— ⌘K / Ctrl+K 搜索与命令面板（2026-10-07 改版）。
 *
 * 一个输入框搜四类：章节（章名 / 章号）、设定（人物名 + 设定本各类条目）、正文（全书按字面找，服务端搜）、
 * 命令（切视图、主题、专注、写下一章…）。
 * ↑↓ 选、回车执行、Esc 关。纯导航与「给 AI 发一句话」，不直连引擎（守铁律②：写类动作仍经对话）。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ChapterNavItem } from "../../../type-defs/workspace.js";
import { chapterBareTitle, chapterDisplayTitle } from "../v2Utils.js";
import { searchLibraryIndex, type LibrarySearchSource } from "./librarySearch.js";
import { Avatar } from "./bibleVisual.js";
import { IconArrowRight, IconBook, IconFile, IconSearch, IconUser } from "./icons.js";
import type { BookSearchResult, BookTextSearch } from "../../../api/bookSearchClient.js";
import type { PresenceHandle } from "../../../hooks/usePresence.js";

export interface PaletteCommand {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly disabled?: boolean;
  readonly run: () => void;
}

export interface PaletteCharacter {
  readonly name: string;
  readonly role: string;
}

interface PaletteItem {
  readonly key: string;
  readonly kind: "chapter" | "character" | "setting" | "text" | "command";
  readonly label: string;
  readonly hint: string;
  readonly disabled?: boolean;
  readonly run: () => void;
}

interface PaletteGroup {
  readonly title: string;
  readonly items: readonly PaletteItem[];
}

/** 组装分组结果：空查询给「最近章节 + 角色 + 命令」，有查询按三类各自过滤。 */
export function buildPaletteGroups(input: {
  readonly query: string;
  readonly chapters: readonly ChapterNavItem[];
  readonly characters: readonly PaletteCharacter[];
  readonly librarySources: readonly LibrarySearchSource[];
  readonly commands: readonly PaletteCommand[];
  readonly onPickChapter: (id: string) => void;
  readonly onPickCharacter: (name: string) => void;
  readonly onPickSetting: (cat: string, focus?: string) => void;
  /** 全书搜正文的结果（就是这次查询的）；没有就不出「正文」组。 */
  readonly text?: BookTextSearch;
  readonly onPickText?: (chapter: number, quote: string) => void;
}): PaletteGroup[] {
  const q = input.query.trim().toLowerCase();
  const digits = q.replace(/[^0-9]/gu, "");
  const groups: PaletteGroup[] = [];

  const chapters = [...input.chapters]
    .filter((ch) => ch.status !== "planned")
    .filter((ch) => !q
      || chapterBareTitle(ch.title ?? "").toLowerCase().includes(q)
      || (digits !== "" && String(ch.chapterNumber) === digits))
    // 章号正好对上的排最前（输「8」先给第 8 章，不是章名里带 8 的第 118 章）
    .sort((a, b) => Number(digits !== "" && String(b.chapterNumber) === digits) - Number(digits !== "" && String(a.chapterNumber) === digits)
      || b.chapterNumber - a.chapterNumber)
    .slice(0, q ? 8 : 5)
    .map<PaletteItem>((ch) => ({
      key: `ch:${ch.id}`,
      kind: "chapter",
      label: `第 ${ch.chapterNumber} 章 · ${chapterDisplayTitle(ch.title ?? "") || "未命名"}`,
      hint: ch.status === "committed" || (ch.status === "current" && ch.hasCommittedChapter) ? "已定稿" : "工作稿",
      run: () => input.onPickChapter(ch.id),
    }));
  if (chapters.length) groups.push({ title: "章节", items: chapters });

  const characters = input.characters
    .filter((c) => !q || c.name.toLowerCase().includes(q))
    .slice(0, 6)
    .map<PaletteItem>((c) => ({
      key: `char:${c.name}`,
      kind: "character",
      label: c.name,
      hint: c.role || "人物",
      run: () => input.onPickCharacter(c.name),
    }));
  if (characters.length) groups.push({ title: "人物", items: characters });

  if (q) {
    const settings = searchLibraryIndex(input.librarySources, input.query)
      // 人物名字已经在「人物」组里了；卡上别的字（身份、来历……）命中照样列进来，点了展开那张卡。
      .filter((hit) => hit.cat !== "chars" || !characters.some((item) => item.label === hit.focus))
      .slice(0, 5)
      .map<PaletteItem>((hit, i) => ({
        key: `set:${hit.cat}:${i}`,
        kind: "setting",
        label: hit.snippet,
        hint: hit.catLabel,
        run: () => input.onPickSetting(hit.cat, hit.focus),
      }));
    if (settings.length) groups.push({ title: "设定", items: settings });
  }

  if (q && input.text && input.text.hits.length > 0) {
    const { hits, chapters, occurrences } = input.text;
    const onPickText = input.onPickText;
    groups.push({
      title: chapters > hits.length ? `正文 · ${chapters} 章出现 ${occurrences} 次，先列前 ${hits.length} 章` : `正文 · ${chapters} 章出现 ${occurrences} 次`,
      items: hits.map<PaletteItem>((hit) => ({
        key: `text:${hit.chapter}`,
        kind: "text",
        label: hit.snippet,
        hint: `第 ${hit.chapter} 章${hit.count > 1 ? ` · ${hit.count} 处` : ""}`,
        disabled: !onPickText,
        run: () => onPickText?.(hit.chapter, hit.quote),
      })),
    });
  }

  const commands = input.commands
    .filter((c) => !q || c.label.toLowerCase().includes(q) || c.hint.toLowerCase().includes(q))
    .map<PaletteItem>((c) => ({ key: `cmd:${c.id}`, kind: "command", label: c.label, hint: c.hint, disabled: c.disabled, run: c.run }));
  if (commands.length) groups.push({ title: "命令", items: commands });

  return groups;
}

/** 正文片段里把搜的字标出来（按字面、英文不分大小写，和服务端同口径）。 */
export function markQuery(label: string, rawQuery: string): ReactNode[] {
  const query = rawQuery.trim();
  if (!query) return [label];
  const lowLabel = label.toLowerCase();
  const lowQuery = query.toLowerCase();
  const sameLength = lowLabel.length === label.length && lowQuery.length === query.length;
  const hay = sameLength ? lowLabel : label;
  const needle = sameLength ? lowQuery : query;
  const parts: ReactNode[] = [];
  let from = 0;
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, from)) {
    if (at > from) parts.push(label.slice(from, at));
    parts.push(<mark key={at}>{label.slice(at, at + needle.length)}</mark>);
    from = at + needle.length;
  }
  if (from < label.length) parts.push(label.slice(from));
  return parts;
}

const KIND_ICON = {
  chapter: IconFile,
  character: IconUser,
  setting: IconBook,
  text: IconSearch,
  command: IconArrowRight,
} as const;

export function CommandPalette(props: {
  readonly onClose: () => void;
  readonly chapters: readonly ChapterNavItem[];
  readonly characters: readonly PaletteCharacter[];
  readonly librarySources: readonly LibrarySearchSource[];
  readonly commands: readonly PaletteCommand[];
  readonly onPickChapter: (id: string) => void;
  readonly onPickCharacter: (name: string) => void;
  readonly onPickSetting: (cat: string, focus?: string) => void;
  /** 全书搜正文（没开书就不给）。 */
  readonly searchText?: (query: string, signal: AbortSignal) => Promise<BookSearchResult>;
  readonly onPickText?: (chapter: number, quote: string) => void;
  /** 关的时候播退场（usePresence）。 */
  readonly presence?: PresenceHandle;
}) {
  const [query, setQuery] = useState("");
  const [textSearch, setTextSearch] = useState<{ readonly query: string; readonly result: BookSearchResult | null } | null>(null);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const searchText = props.searchText;
  // 正文是服务端搜：停手 200ms 再搜，换了字就丢掉上一次的。
  useEffect(() => {
    const q = query.trim();
    if (!searchText || !q) {
      setTextSearch(null);
      return undefined;
    }
    setTextSearch({ query: q, result: null });
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void searchText(q, controller.signal).then((result) => {
        if (!controller.signal.aborted) setTextSearch({ query: q, result });
      });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, searchText]);
  const textResult = textSearch && textSearch.query === query.trim() ? textSearch.result : null;
  const text = textResult?.ok ? textResult : undefined;
  const textPending = Boolean(textSearch && textSearch.query === query.trim() && textSearch.result === null);
  const textError = textResult && !textResult.ok ? textResult.error : null;
  const groups = useMemo(() => buildPaletteGroups({ ...props, query, ...(text ? { text } : {}) }), [props, query, text]);
  const flat = groups.flatMap((g) => g.items);
  const activeIndex = flat.length ? Math.min(active, flat.length - 1) : -1;

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-pal-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const runItem = (item: PaletteItem | undefined) => {
    if (!item || item.disabled) return;
    props.onClose();
    item.run();
  };

  let counter = -1;
  return (
    <>
      <div className="se-scrim" aria-hidden="true" onClick={props.onClose} data-closing={props.presence?.closing || undefined} />
      <div ref={props.presence?.ref} data-closing={props.presence?.closing || undefined} className="se-palette" role="dialog" aria-modal="true" aria-label="搜索与命令">
        <label className="se-pal-in">
          <IconSearch size={18} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            placeholder="搜章节、正文、角色、设定，或输入命令…"
            aria-label="搜索"
            aria-controls="se-pal-list"
            aria-activedescendant={activeIndex >= 0 ? `se-pal-item-${activeIndex}` : undefined}
            onChange={(event) => { setQuery(event.target.value); setActive(0); }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                if (!flat.length) return;
                const step = event.key === "ArrowDown" ? 1 : -1;
                setActive((activeIndex + step + flat.length) % flat.length);
              } else if (event.key === "Enter") {
                event.preventDefault();
                if (event.nativeEvent.isComposing) return;
                runItem(flat[activeIndex]);
              } else if (event.key === "Escape") {
                event.preventDefault();
                props.onClose();
              }
            }}
          />
          <kbd>esc</kbd>
        </label>
        <div className="se-pal-res" id="se-pal-list" role="listbox" ref={listRef}>
          {groups.map((group) => (
            <div key={group.title} role="group" aria-label={group.title}>
              <div className="se-pal-g">{group.title}</div>
              {group.items.map((item) => {
                counter += 1;
                const index = counter;
                const Icon = KIND_ICON[item.kind];
                return (
                  <button
                    key={item.key}
                    id={`se-pal-item-${index}`}
                    data-pal-index={index}
                    className={`se-pal-it${index === activeIndex ? " on" : ""}`}
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex}
                    disabled={item.disabled}
                    onMouseMove={() => { if (index !== activeIndex) setActive(index); }}
                    onClick={() => runItem(item)}
                  >
                    {/* 人物带设定本同款头像（名字第一个字、按名字定色），一眼对上 */}
                    {item.kind === "character" ? <Avatar name={item.label} kind="character" /> : <Icon size={16} />}
                    <span className="se-pal-label">{item.kind === "text" ? markQuery(item.label, query) : item.label}</span>
                    <span className="se-pal-hint">{item.hint}</span>
                  </button>
                );
              })}
            </div>
          ))}
          {textError ? <div className="se-pal-empty">{textError}</div> : null}
          {flat.length === 0 && !textError
            ? <div className="se-pal-empty">{textPending ? "正在搜正文…" : `没有找到「${query.trim()}」`}</div>
            : null}
        </div>
        <div className="se-pal-foot"><span>↑↓ 选择</span><span>↵ 打开</span><span>esc 关闭</span></div>
      </div>
    </>
  );
}
