/**
 * 把 StateOverview 折成一段中性、题材无关的自然语言摘要，供 agent 回答用户、
 * 也供工具 output 的 summary 字段。措辞不注入任何题材假设（铁律：引擎题材中立）。
 * 设定本的内容（故事设定、卡上写的、关系）不在这里展开，要看走 read_foundation（重构 P9）。
 */
import type { StateOverview } from "../book/state-overview.js";

export function summarizeStateOverview(overview: StateOverview): string {
  const lines: string[] = [];
  const chapter = overview.project.currentChapter;
  lines.push(
    `《${overview.project.title}》${overview.project.genre ? `（${overview.project.genre}）` : ""}` +
      `当前进度：${chapter ? `第 ${chapter} 章` : "尚未开始正式章节"}。`,
  );

  const protagonist = overview.characters.protagonist;
  const others = overview.characters.knownCharacters
    .filter((c) => c.name && c.name !== protagonist)
    .map((c) => c.name);
  if (protagonist || others.length > 0) {
    const parts: string[] = [];
    if (protagonist) parts.push(`主角 ${protagonist}`);
    if (others.length > 0) parts.push(`其他人物 ${others.slice(0, 8).join("、")}${others.length > 8 ? " 等" : ""}`);
    lines.push(`人物：${parts.join("；")}。`);
  } else {
    lines.push("人物：设定本里还没有人物，账里也没记过。");
  }

  const setting = overview.setting;
  const cards = setting.cards;
  lines.push(
    `设定本：人物卡 ${cards.characters} 张、地点 ${cards.places}、物品 ${cards.items}、其他设定 ${cards.lore}；` +
      `故事设定写了 ${setting.storyFields} 栏` +
      (setting.uncarded > 0 ? `；账里还有 ${setting.uncarded} 个没建卡` : "") +
      "（细看用 read_foundation）。",
  );

  // 主线目标计数 = active + touched（与 activeItems 的存活语义一致）：目标被声明推进过就转 touched、
  // 长期不动才 stale——只数 active 会在长跑里恒报 0（r8 真机：main_arc 第 100 章刚推进过，面板却报 0 条）。
  lines.push(
    `进展跟踪：活跃伏笔 ${overview.hooks.activeCount} 条、开放线索 ${overview.threads.open} 条、` +
      `主线目标 ${overview.arcGoals.activeCount + overview.arcGoals.touchedCount} 条。`,
  );

  const lastEvent = overview.storyStatus.lastTimelineEvent;
  if (lastEvent) {
    lines.push(`最近时间线：${lastEvent}`);
  }

  return lines.join("\n");
}
