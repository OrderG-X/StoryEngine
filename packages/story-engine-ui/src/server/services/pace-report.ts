/**
 * 节奏诊断（服务端取数）：投影 + 每章定稿正文的字数 → 核心 paceReport。故事地图和对话 AI 共用。
 * 字数和书架、写作台同一口径（countTextWords：只数汉字，去标题）；读路径不写盘、不拿锁。
 */
import { paceReport, readChapterPaper, type BookProjection, type PaceReport } from "@actalk/story-core";
import { countTextWords } from "../../utils/textUtils.js";

export async function readPaceReport(projectDir: string, projection: Pick<BookProjection, "chapters" | "threads">): Promise<PaceReport> {
  const words = new Map<number, number>();
  for (const view of projection.chapters) {
    const paper = await readChapterPaper(projectDir, view.chapter);
    words.set(view.chapter, paper.committed ? countTextWords(paper.committed.body) : 0);
  }
  return paceReport(projection, words);
}
