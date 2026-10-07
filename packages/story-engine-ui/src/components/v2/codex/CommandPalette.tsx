/**
 * CommandPalette —— ⌘K / Ctrl+K 搜索与命令面板（2026-10-07 改版）。
 *
 * 一个输入框搜三类：章节（章名 / 章号）、设定（角色名 + 设定本各类条目）、命令（切视图、主题、专注、写下一章…）。
 * ↑↓ 选、回车执行、Esc 关。纯导航与「给 AI 发一句话」，不直连引擎（守铁律②：写类动作仍经对话）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChapterNavItem } from "../../../type-defs/workspace.js";
import { chapterBareTitle } from "../v2Utils.js";
import { searchLibraryIndex, type LibrarySearchSource } from "./librarySearch.js";
import { IconArrowRight, IconBook, IconFile, IconSearch, IconUser } from "./icons.js";

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
  readonly kind: "chapter" | "character" | "setting" | "command";
  readonly label: string;
  readonly hint: string;
  readonly disabled?: boolean;
  readonly run: () => void;
}

interface PaletteGroup {
  readonly title: string;
  readonly items: readonly PaletteItem[];
}

/** 从角色卡 JSON 串里取名字与身份；坏串跳过（不把 JSON 原文露给用户）。 */
export function parsePaletteCharacters(items: readonly string[]): PaletteCharacter[] {
  const out: PaletteCharacter[] = [];
  for (const item of items) {
    try {
      const obj = JSON.parse(item) as { name?: unknown; role?: unknown };
      const name = typeof obj.name === "string" ? obj.name.trim() : "";
      if (!name || out.some((c) => c.name === name)) continue;
      out.push({ name, role: typeof obj.role === "string" ? obj.role.trim() : "" });
    } catch { /* 非 JSON 条目不是角色卡 */ }
  }
  return out;
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
  readonly onPickSetting: (cat: string) => void;
}): PaletteGroup[] {
  const q = input.query.trim().toLowerCase();
  const digits = q.replace(/[^0-9]/gu, "");
  const groups: PaletteGroup[] = [];

  const chapters = [...input.chapters]
    .filter((ch) => ch.status !== "planned" || !q)
    .filter((ch) => !q
      || chapterBareTitle(ch.title ?? "").toLowerCase().includes(q)
      || (digits !== "" && String(ch.chapterNumber) === digits))
    .sort((a, b) => b.chapterNumber - a.chapterNumber)
    .slice(0, q ? 8 : 5)
    .map<PaletteItem>((ch) => ({
      key: `ch:${ch.id}`,
      kind: "chapter",
      label: `第 ${ch.chapterNumber} 章 · ${chapterBareTitle(ch.title ?? "") || "未命名"}`,
      hint: ch.status === "committed" ? "已定稿" : ch.status === "planned" ? "还没写" : "工作稿",
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
      hint: c.role || "角色",
      run: () => input.onPickCharacter(c.name),
    }));
  if (characters.length) groups.push({ title: "角色", items: characters });

  if (q) {
    const settings = searchLibraryIndex(input.librarySources, input.query)
      .filter((hit) => hit.cat !== "chars")
      .slice(0, 5)
      .map<PaletteItem>((hit, i) => ({
        key: `set:${hit.cat}:${i}`,
        kind: "setting",
        label: hit.snippet,
        hint: hit.catLabel,
        run: () => input.onPickSetting(hit.cat),
      }));
    if (settings.length) groups.push({ title: "设定", items: settings });
  }

  const commands = input.commands
    .filter((c) => !q || c.label.toLowerCase().includes(q) || c.hint.toLowerCase().includes(q))
    .map<PaletteItem>((c) => ({ key: `cmd:${c.id}`, kind: "command", label: c.label, hint: c.hint, disabled: c.disabled, run: c.run }));
  if (commands.length) groups.push({ title: "命令", items: commands });

  return groups;
}

const KIND_ICON = {
  chapter: IconFile,
  character: IconUser,
  setting: IconBook,
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
  readonly onPickSetting: (cat: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const groups = useMemo(() => buildPaletteGroups({ ...props, query }), [props, query]);
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
      <div className="se-scrim" aria-hidden="true" onClick={props.onClose} />
      <div className="se-palette" role="dialog" aria-modal="true" aria-label="搜索与命令">
        <label className="se-pal-in">
          <IconSearch size={18} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            placeholder="搜章节、角色、设定，或输入命令…"
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
                    <Icon size={16} />
                    <span className="se-pal-label">{item.label}</span>
                    <span className="se-pal-hint">{item.hint}</span>
                  </button>
                );
              })}
            </div>
          ))}
          {flat.length === 0 ? <div className="se-pal-empty">没有找到「{query.trim()}」</div> : null}
        </div>
        <div className="se-pal-foot"><span>↑↓ 选择</span><span>↵ 打开</span><span>esc 关闭</span></div>
      </div>
    </>
  );
}
