/**
 * 输入框「@ 引用」（2026-10-07 改版）：打 @ 弹出角色 / 地点 / 章节，选中插入「@名字 」。
 * 只是帮你把名字打准（AI 按名字理解上下文），不引入新的数据通道。纯函数，便于单测。
 */
import type { ChapterNavItem } from "../../../type-defs/workspace.js";
import { chapterBareTitle } from "../v2Utils.js";

export interface MentionCandidate {
  readonly label: string;
  readonly kind: "角色" | "地点" | "章节";
}

/** 光标在末尾时，末尾的「@xxx」就是正在打的引用；返回 @ 后面的查询词，没在打就返回 null。 */
export function activeMentionQuery(text: string): string | null {
  // 不猜白名单：切句
  const match = /(?:^|[\s，。、；：！？,.;:!?（(「“"'])@([^\s@，。、；：！？,.;:!?]{0,12})$/u.exec(text);
  return match ? match[1] ?? "" : null;
}

/** 把末尾正在打的「@xxx」替换成「@label 」。 */
export function insertMention(text: string, label: string): string {
  // 不猜白名单：切句
  return text.replace(/@([^\s@，。、；：！？,.;:!?]{0,12})$/u, `@${label} `);
}

export function buildMentionCandidates(input: {
  readonly query: string;
  readonly characters: readonly string[];
  readonly locations: readonly string[];
  readonly chapters: readonly ChapterNavItem[];
}): MentionCandidate[] {
  const q = input.query.trim().toLowerCase();
  const seen = new Set<string>();
  const out: MentionCandidate[] = [];
  const push = (label: string, kind: MentionCandidate["kind"]) => {
    const clean = label.trim();
    if (!clean || seen.has(clean)) return;
    if (q && !clean.toLowerCase().includes(q)) return;
    seen.add(clean);
    out.push({ label: clean, kind });
  };
  input.characters.forEach((name) => push(name, "角色"));
  input.locations.forEach((name) => push(name, "地点"));
  [...input.chapters]
    .filter((ch) => ch.status !== "planned")
    .sort((a, b) => b.chapterNumber - a.chapterNumber)
    .slice(0, q ? 60 : 3)
    .forEach((ch) => {
      const title = chapterBareTitle(ch.title ?? "");
      push(title ? `第${ch.chapterNumber}章·${title}` : `第${ch.chapterNumber}章`, "章节");
    });
  return out.slice(0, 8);
}
