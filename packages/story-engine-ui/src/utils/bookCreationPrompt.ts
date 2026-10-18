/** 新建空书进写作台时，AI 指挥台的开书专用开场白（开书语气，非章节 idle 语气）。 */
export function bookCreationPromptText(): string {
  return "新书已经建好啦。想写个什么样的故事？先跟我说说主角和大概的世界吧——想到哪说到哪，我边听边帮你把人物和设定搭起来，随时能撤。";
}

/** 导入已写的书后的开场白（P8）。 */
export function bookImportPromptText(chapters: number): string {
  return `导进来了 ${chapters} 章，都算定稿。记账员正从第 1 章读起、一章一章记账（进度在下面），记完就能核账、定稿，接着写第 ${chapters + 1} 章。这期间你可以先自己写。`;
}
