#!/usr/bin/env node
/**
 * 新旧对比：在一本书的副本上导入老账，算新投影，再和老数据逐项比，输出 Markdown。
 * 每处差异写清差在哪、为什么；说不出原因的单独列一节。
 *
 * 用法（先 pnpm build）：
 *   node packages/story-core/tools/compare-import.mjs <书目录副本> [输出.md]
 * 只在副本上跑：会往书目录里写 ledger/。
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bookImport, projectBook, runCommand, DEFAULT_STALE_AFTER } from "../dist/index.js";

const [bookDir, outPath] = process.argv.slice(2);
if (!bookDir) {
  console.error("用法：node compare-import.mjs <书目录副本> [输出.md]");
  process.exit(2);
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(join(bookDir, path), "utf-8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

const imported = await runCommand(bookDir, bookImport, {}, { caller: "author", idempotencyKey: `compare-${Date.now()}` });
if (!imported.ok && imported.code !== "already_imported") {
  console.error(`导入没成：${imported.code} ${imported.message}`);
  process.exit(1);
}
const view = await projectBook(bookDir);
const lines = [];
const unexplained = [];
const push = (line) => lines.push(line);

push(`# 新旧对比：${bookDir.split("/").filter(Boolean).at(-1)}`);
push("");
push(`- 生成：${new Date().toISOString()}`);
push(`- 导入：${imported.ok ? JSON.stringify(imported.result.counts) : "这本书之前已经导入过"}`);
if (imported.ok) push(`- 跳过 ${imported.result.skipped.length} 条，调整 ${imported.result.adjusted.length} 条`);
push("");

// —— 事实 ——
const oldFacts = (await readJson("story/fact-ledger.json"))?.facts ?? [];
const oldValid = oldFacts.filter((fact) => fact.supersededByChapter === undefined).length;
const newCurrent = view.facts.filter((fact) => fact.status === "current").length;
push("## 事实");
push("");
push(`| | 老账 | 新投影 |`);
push(`|---|---|---|`);
push(`| 总条数 | ${oldFacts.length} | ${view.facts.length} |`);
push(`| 有效 | ${oldValid} | ${newCurrent} |`);
push(`| 作废 | ${oldFacts.length - oldValid} | ${view.facts.filter((fact) => fact.status !== "current").length} |`);
push("");
const newById = new Map(view.facts.map((fact) => [fact.id, fact]));
for (const fact of oldFacts) {
  const next = newById.get(fact.id);
  if (!next) {
    unexplained.push(`事实 ${fact.id}（第 ${fact.chapter} 章）在新投影里没有`);
    continue;
  }
  const oldDead = fact.supersededByChapter !== undefined;
  const newDead = next.status !== "current";
  if (oldDead !== newDead) unexplained.push(`事实 ${fact.id}：老账${oldDead ? "作废" : "有效"}，新投影${newDead ? "作废" : "有效"}`);
  else if (oldDead && fact.supersededByChapter !== next.supersededAt) {
    unexplained.push(`事实 ${fact.id}：老账第 ${fact.supersededByChapter} 章作废，新投影第 ${next.supersededAt} 章`);
  }
}
push(`逐条对：${oldFacts.length - unexplained.length} / ${oldFacts.length} 条有效性和作废章一致。`);
push("");

// —— 线索 ——
const oldThreads = [
  ...((await readJson("story/threads.json"))?.threads ?? []).map((thread) => ({ ...thread, from: "threads", closed: thread.status === "done" || thread.status === "stale" })),
  ...((await readJson("story/hooks.json"))?.hooks ?? []).map((hook) => ({ ...hook, from: "hooks", closed: hook.status === "resolved" || hook.status === "abandoned" })),
  ...((await readJson("story/arc-goals.json"))?.goals ?? []).map((goal) => ({ ...goal, from: "arc-goals", closed: goal.status === "completed" || goal.status === "stale" })),
];
const newThreads = new Map(view.threads.map((thread) => [thread.id, thread]));
const threadRows = [];
let threadSame = 0;
for (const thread of oldThreads) {
  const next = newThreads.get(thread.id);
  if (!next) {
    unexplained.push(`线索「${thread.title}」在新投影里没有`);
    continue;
  }
  const newClosed = next.status === "closed";
  if (thread.closed !== newClosed) {
    unexplained.push(`线索「${thread.title}」：老账${thread.closed ? "已收" : "未收"}，新投影${newClosed ? "已收" : "未收"}`);
    continue;
  }
  if (thread.status === "stale") {
    threadRows.push(`| ${thread.title} | stale | ${next.status} | 老账 stale = 不再追踪（清理掉、并掉、过期、搁置），导入成在第 ${next.closedAt} 章收掉 |`);
  } else if (thread.status !== "stale" && !thread.closed && next.status === "stale") {
    threadRows.push(`| ${thread.title} | ${thread.status} | stale | 新投影 ${DEFAULT_STALE_AFTER} 章没动就提醒（只提醒、不关）；最近一次在第 ${next.lastTouchedAt} 章 |`);
  } else {
    threadSame += 1;
  }
}
push("## 线索");
push("");
push(`老账 ${oldThreads.length} 条，新投影 ${view.threads.length} 条；开 / 收一致 ${oldThreads.length - unexplained.filter((line) => line.startsWith("线索")).length} 条，状态完全一致 ${threadSame} 条。`);
push("");
if (threadRows.length > 0) {
  push("| 线索 | 老状态 | 新状态 | 为什么 |");
  push("|---|---|---|---|");
  for (const row of threadRows) push(row);
  push("");
}

// —— 天数 ——
const calendar = await readJson("time/calendar.json");
const last = view.chapters.at(-1);
push("## 天数");
push("");
const basisCount = view.chapters.reduce((map, chapter) => ((map[chapter.dayBasis] = (map[chapter.dayBasis] ?? 0) + 1), map), {});
push(`- 新投影每章天数的依据：${JSON.stringify(basisCount)}`);
if ((await readJson("story/timeline.json")) === undefined) push("- 老书没有 story/timeline.json：照老代码的办法从章纲天数推（章纲写了天数的记 judged，没写的按上一章 +1 记 estimated）");
if (calendar?.currentStoryDay !== undefined && last) {
  const same = calendar.currentStoryDay === last.dayEnd;
  push(`- 最后一章：老日历第 ${calendar.currentStoryDay} 天，新投影第 ${last.dayEnd} 天${same ? "，一致" : ""}`);
  if (!same) {
    const reason = basisCount.missing === view.chapters.length
      ? "老书没有逐章时间线，新投影全按 +1 估；老日历的天数来自旧引擎的 calendar 更新"
      : undefined;
    if (reason) push(`  - 为什么：${reason}`);
    else unexplained.push(`最后一章天数：老日历 ${calendar.currentStoryDay}，新投影 ${last.dayEnd}`);
  }
}
const oldTimeline = (await readJson("story/timeline.json"))?.entries ?? [];
for (const entry of oldTimeline) {
  const chapter = view.chapters.find((item) => item.chapter === entry.chapter);
  if (chapter && chapter.day !== entry.day) unexplained.push(`第 ${entry.chapter} 章天数：老时间线第 ${entry.day} 天，新投影第 ${chapter.day} 天`);
}
if (oldTimeline.length > 0) push(`- 老时间线 ${oldTimeline.length} 章逐章对照（不一致的见最后一节）`);
push("");

// —— 出场 ——
const events = (await readJson("timeline/events.json")) ?? [];
const eventList = Array.isArray(events) ? events : events.events ?? [];
const nameOf = new Map();
for (const character of (await readJson("story/character-bible.json"))?.characters ?? []) nameOf.set(character.id, character.name);
push("## 出场人物");
push("");
let castSame = 0;
for (const event of eventList) {
  const oldNames = new Set((event.participants ?? []).map((id) => nameOf.get(id) ?? id));
  const chapter = view.chapters.find((item) => item.chapter === event.chapter);
  const newNames = new Set(chapter?.present ?? []);
  const missing = [...oldNames].filter((name) => !newNames.has(name));
  const extra = [...newNames].filter((name) => !oldNames.has(name));
  if (missing.length === 0 && extra.length === 0) castSame += 1;
  else if (missing.length > 0) unexplained.push(`第 ${event.chapter} 章出场：新投影少了 ${missing.join("、")}`);
  else push(`- 第 ${event.chapter} 章新投影多了 ${extra.join("、")}：来自人物表的出场记录或别称表`);
}
push(`- ${castSame} / ${eventList.length} 章出场名单一致`);
push("");

// —— 悬空 ——
push("## 悬空引用和矛盾");
push("");
push(`- 悬空 ${view.dangling.length} 条，矛盾 ${view.conflicts.length} 条`);
for (const item of view.dangling) unexplained.push(`悬空：${item.kind} ${item.ref}（第 ${item.chapter ?? "?"} 章）`);
push("");

push("## 说不出原因");
push("");
if (unexplained.length === 0) push("（无）");
for (const line of unexplained) push(`- ${line}`);
push("");

const markdown = `${lines.join("\n")}\n`;
if (outPath) await writeFile(outPath, markdown);
else process.stdout.write(markdown);
