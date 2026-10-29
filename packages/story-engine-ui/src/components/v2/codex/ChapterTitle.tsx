/**
 * 写作台顶上的章名（重构 P6 第 7 步：作者手写的章也能起名）。
 *
 * 点一下章名就地改：回车 / 点别处存，Esc 不改。没定稿的改工作稿的章名，跟正文一起自动保存；
 * 已定稿的由外面交给服务端改定稿的章名（可撤销）。以前只能在正文第一行打「# 章名」，作者不会知道。
 */
import { useEffect, useRef, useState } from "react";
import { chapterBareTitle, chapterHeading } from "../v2Utils.js";

export function ChapterTitle({ chapterNumber, title, editable, onRename }: {
  readonly chapterNumber: number;
  readonly title: string;
  /** 章名能改（工作稿能编辑，或这一章已定稿、没在出稿）。 */
  readonly editable: boolean;
  readonly onRename: (title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const bare = chapterBareTitle(title);

  useEffect(() => {
    if (!editable) setEditing(false);
  }, [editable]);
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  if (!editable) return <strong className="cd-chapter">{chapterHeading(chapterNumber, title)}</strong>;
  if (!editing) {
    return (
      <button
        type="button"
        className="cd-chapter cd-chapter-edit"
        title="点一下改章名"
        onClick={() => { setValue(bare); setEditing(true); }}
      >
        {chapterHeading(chapterNumber, title)}
      </button>
    );
  }
  const save = () => {
    setEditing(false);
    // 清空也是改（写作版本 P1 第 14 轮复核 AB2）：工作稿去掉章名；已定稿的章名不能空，服务端如实说没改。
    const next = value.trim();
    if (next !== bare) onRename(next);
  };
  return (
    <span className="cd-chapter cd-chapter-input">
      第{chapterNumber}章 ·
      <input
        ref={inputRef}
        aria-label="章名"
        placeholder="起个章名"
        value={value}
        maxLength={40}
        onChange={(event) => setValue(event.target.value)}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            save();
          } else if (event.key === "Escape") {
            event.preventDefault();
            setEditing(false);
          }
        }}
      />
    </span>
  );
}
