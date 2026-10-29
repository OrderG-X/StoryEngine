/**
 * 已有各章章名（2026-10-14 编辑部 R7.7·报告 5：拟标题防重名，第 7、9 章都叫「铁丝」）。写手拿它避重名；
 * AI 换上稿子前按同样的读法再读一遍，名单变了就不换（写作版本 P1b 第 5 轮复核 S8，见 material-reads）。
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** 最多带多少章的已有章名（长书只看最近的，防上下文膨胀）。 */
const MAX_EXISTING_CHAPTER_TITLES = 60;

const padChapter = (chapter: number): string => String(chapter).padStart(4, "0");

/**
 * 定稿章（chapters/000N.md）+ 工作稿（drafts/fast/chapter-NNNN.md），取章号最大的最近 MAX_EXISTING_CHAPTER_TITLES 章、
 * 不含 except 这章（重写本章时不能把自己的章名当「重名」）。定稿章名优先（正稿为准），只有工作稿的章用工作稿章名；
 * 读不出章名的章跳过。纯读盘、题材中立。
 */
export async function readChapterTitles(
  projectDir: string,
  except: number,
): Promise<readonly { chapter: number; title: string }[]> {
  const chapters = new Set<number>();
  const [committedFiles, draftFiles] = await Promise.all([
    readdir(join(projectDir, "chapters")).catch(() => [] as string[]),
    readdir(join(projectDir, "drafts", "fast")).catch(() => [] as string[]),
  ]);
  for (const file of committedFiles) {
    const chapter = Number(/^(\d{4})\.md$/u.exec(file)?.[1]);
    if (Number.isInteger(chapter) && chapter > 0) chapters.add(chapter);
  }
  for (const file of draftFiles) {
    const chapter = Number(/^chapter-(\d{4})\.md$/u.exec(file)?.[1]);
    if (Number.isInteger(chapter) && chapter > 0) chapters.add(chapter);
  }
  const recent = [...chapters]
    .filter((chapter) => chapter !== except)
    .sort((a, b) => b - a)
    .slice(0, MAX_EXISTING_CHAPTER_TITLES);
  const withTitles = await Promise.all(recent.map(async (chapter) => {
    const [committedTitle, draftTitle] = await Promise.all([
      extractMarkdownTitle(await readFile(join(projectDir, "chapters", `${padChapter(chapter)}.md`), "utf-8").catch(() => undefined)),
      extractMarkdownTitle(await readFile(join(projectDir, "drafts", "fast", `chapter-${padChapter(chapter)}.md`), "utf-8").catch(() => undefined)),
    ]);
    const title = committedTitle ?? draftTitle;
    return title ? { chapter, title } : undefined;
  }));
  return withTitles
    .filter((item): item is { chapter: number; title: string } => item !== undefined)
    .sort((a, b) => a.chapter - b.chapter);
}

/** 章节文件第一行 # 标题里的章名；没有是 undefined。 */
export function extractMarkdownTitle(content: string | undefined): string | undefined {
  const line = content?.split(/\r?\n/u).find((item) => item.trim().startsWith("#"))?.trim();
  if (!line) return undefined;
  return line.replace(/^#+\s*/u, "").trim() || undefined;
}
