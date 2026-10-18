/**
 * 把 StateOverview 折成一段中性、题材无关的自然语言摘要，供 agent 回答用户、
 * 也供工具 output 的 summary 字段。措辞不注入任何题材假设（铁律：引擎题材中立）。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { StateOverview } from "../book/state-overview.js";

export interface StateOverviewSummaryExtras {
  /**
   * 调用处从 story/world-bible.json 读出的势力目标。StateOverview 的 worldBible 只带势力**名字**、丢了 goal，
   * 所以要在调用处（read-state-overview 工具）补一道 readFactionGoals 读出来传进来，让聊天摘要能说出势力想干嘛。
   */
  readonly factions?: readonly { readonly name: string; readonly goal?: string }[];
}

const TRUST_LABEL: Readonly<Record<string, string>> = { low: "低", medium: "中", high: "高" };

export function summarizeStateOverview(overview: StateOverview, extras?: StateOverviewSummaryExtras): string {
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
    if (others.length > 0) parts.push(`其他角色 ${others.slice(0, 8).join("、")}`);
    lines.push(`角色：${parts.join("；")}（共 ${overview.characterBible.characterCount} 个角色卡）。`);
  } else {
    lines.push("角色：暂无已建角色卡。");
  }

  // 关系：从 characterMatrix 带出配角与主角的关系（之前摘要只列名字、关系/信任度一字不提）。
  const relationshipLines = buildRelationshipLines(overview);
  if (relationshipLines.length > 0) {
    lines.push(`关系：${relationshipLines.join("；")}。`);
  }

  // 世界设定：优先带出 world-bible 里写好的真实设定要点（之前只读 world/core.json 的默认 premise，
  // 把真正的世界观漏了，导致摘要看着空/通用）。没有真实设定时才退回 premise。
  const bible = overview.worldBible;
  const bibleFacts = bible.available
    ? Array.from(new Set([...bible.keyRules, ...bible.fixedFacts].map((s) => s.trim()).filter(Boolean)))
    : [];
  if (bibleFacts.length > 0) {
    lines.push(`世界设定：${bibleFacts.slice(0, 6).join("；")}。`);
  } else if (overview.world.summary) {
    lines.push(`世界设定：${overview.world.summary}`);
  }
  const factionLine = buildFactionLine(overview, extras);
  if (factionLine) lines.push(factionLine);
  if (overview.world.activeLocations.length > 0) {
    lines.push(`活跃地点：${overview.world.activeLocations.slice(0, 6).join("、")}。`);
  }

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

  if (!overview.storyFoundation.available && overview.storyFoundation.missingFiles.length > 0) {
    lines.push(`资料完整度提醒：缺少 ${overview.storyFoundation.missingFiles.join("、")}。`);
  }

  return lines.join("\n");
}

/** 从 characterMatrix 取「配角—主角」关系行（name=关系（信任X）），最多 6 条防摘要膨胀。 */
function buildRelationshipLines(overview: StateOverview): string[] {
  const matrix = overview.characterMatrix;
  if (!matrix.available || matrix.characters.length === 0) return [];
  const protagonistName = overview.characters.protagonist;
  const out: string[] = [];
  for (const character of matrix.characters) {
    const name = character.name?.trim();
    if (!name || name === protagonistName) continue;
    const relation = character.relationshipToProtagonist?.trim();
    if (!relation) continue;
    const trust = character.trustLevel && TRUST_LABEL[character.trustLevel] ? `（信任${TRUST_LABEL[character.trustLevel]}）` : "";
    out.push(`${name}=${relation}${trust}`);
    if (out.length >= 6) break;
  }
  return out;
}

/** 关键势力行：有 extras.factions（带 goal）就带出目标，否则退回 worldBible 的只名字。 */
function buildFactionLine(overview: StateOverview, extras?: StateOverviewSummaryExtras): string | null {
  const withGoals = (extras?.factions ?? []).filter((faction) => faction.name && faction.name.trim());
  if (withGoals.length > 0) {
    const rendered = withGoals.slice(0, 6).map((faction) =>
      faction.goal && faction.goal.trim() ? `${faction.name.trim()}（目标：${faction.goal.trim()}）` : faction.name.trim(),
    );
    return `关键势力：${rendered.join("、")}。`;
  }
  const bible = overview.worldBible;
  if (bible.available && bible.keyFactions.length > 0) {
    return `关键势力：${bible.keyFactions.slice(0, 6).join("、")}。`;
  }
  return null;
}

/**
 * 读 story/world-bible.json 的势力目标（StateOverview 只带名字、丢了 goal）。供 read-state-overview 工具
 * 在调用 summarizeStateOverview 时作为 extras 传入，让聊天摘要能说出势力想干嘛。缺文件/解析失败回空数组（不抛）。
 */
export async function readFactionGoals(projectDir: string): Promise<{ readonly name: string; readonly goal?: string }[]> {
  try {
    const raw = await readFile(join(projectDir, "story", "world-bible.json"), "utf-8");
    const bible = JSON.parse(raw) as { readonly factions?: unknown };
    const factions = Array.isArray(bible.factions) ? bible.factions : [];
    const out: { readonly name: string; readonly goal?: string }[] = [];
    for (const faction of factions) {
      if (typeof faction === "string") {
        const name = faction.trim();
        if (name) out.push({ name });
        continue;
      }
      if (faction && typeof faction === "object") {
        const rawName = (faction as { readonly name?: unknown }).name;
        const name = typeof rawName === "string" ? rawName.trim() : "";
        if (!name) continue;
        const rawGoal = (faction as { readonly goal?: unknown }).goal;
        const goal = typeof rawGoal === "string" && rawGoal.trim() ? rawGoal.trim() : undefined;
        out.push(goal ? { name, goal } : { name });
      }
    }
    return out;
  } catch {
    return [];
  }
}
