import type { ChapterWorkspaceData } from "./types.js";

export const mockWorkspaceData: ChapterWorkspaceData = {
  projectName: "旧城区无线电",
  currentChapter: { id: "ch-003", chapterNumber: 3, title: "地下车库信号", status: "current" },
  chapters: [
    { id: "ch-001", chapterNumber: 1, title: "午夜频率", status: "committed" },
    { id: "ch-002", chapterNumber: 2, title: "废弃避难所", status: "committed" },
    { id: "ch-003", chapterNumber: 3, title: "地下车库信号", status: "current" },
    { id: "ch-004", chapterNumber: 4, title: "地下二层的回响", status: "draft" },
    { id: "ch-005", chapterNumber: 5, title: "失真的广播坐标", status: "planned" },
    { id: "ch-006", chapterNumber: 6, title: "消防通道里的脚印", status: "planned" },
    { id: "ch-007", chapterNumber: 7, title: "避难所门后的名单", status: "planned" },
    { id: "ch-008", chapterNumber: 8, title: "旧铜哨的回声", status: "planned" },
  ],
  flowStatus: "idle",
};
