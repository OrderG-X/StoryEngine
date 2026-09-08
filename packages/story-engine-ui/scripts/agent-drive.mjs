// 真实写作驱动器（模型无关接缝防御·真 agent 冒烟）。
//
// 为什么存在：函数单测喂干净合成输入，测不出「模型实际会传什么」（空串/空数组/0/原始 id/
// "False"/凭空多塞字段）。退化输入 bug 只有真 agent 真实写作才暴露。这个脚本走真实管线——
// POST /api/agent/chat（SSE）真发指令、真调模型、真写真书——把每个 tool-call 的 args 与
// tool-result 的关键字段打出来，人工/CI 核对：无裸 id 泄露、无假拦、无 ok:true 谎报、
// 上下文段未被静默砍。
//
// 用法：
//   1) 起 dev server：pnpm dev --port 5188 --strictPort
//   2) node scripts/agent-drive.mjs "<用户消息>" [currentChapter] [historyFile] [projectPath]
//   多轮接着写：传同一个 historyFile（脚本会把 user+assistant 文本追加进去）。
//
// 环境变量：STORY_ENGINE_PROJECT（项目路径，无默认、缺省报错退出——见下）、
//          STORY_ENGINE_BASE（默认 http://127.0.0.1:5188）。
// 项目路径为什么不设默认：历史默认 story-test-book 已于 2026-07-12 清库；书库根下现只有
// 用户真书 story-demo-book，严禁拿来跑。必须经 [projectPath] 参数或 STORY_ENGINE_PROJECT 显式指定。
import { readFile, writeFile } from "node:fs/promises";

const PROJECT = process.argv[5] || process.env.STORY_ENGINE_PROJECT;
const BASE = process.env.STORY_ENGINE_BASE || "http://127.0.0.1:5188";

const userMsg = process.argv[2];
const currentChapter = process.argv[3] ? Number(process.argv[3]) : undefined;
const historyFile = process.argv[4];

const USAGE = "用法：node agent-drive.mjs '<用户消息>' [currentChapter] [historyFile] [projectPath]（项目路径也可由环境变量 STORY_ENGINE_PROJECT 指定）";
if (!userMsg) { console.error(USAGE); process.exit(1); }
if (!PROJECT) { console.error(`错误：必须显式指定项目路径，已无默认值（历史默认 story-test-book 已于 2026-07-12 清库）。\n${USAGE}`); process.exit(1); }

let history = [];
if (historyFile) history = JSON.parse(await readFile(historyFile, "utf-8").catch(() => "[]"));
const messages = [...history, { role: "user", content: userMsg }];

const body = JSON.stringify({ projectPath: PROJECT, messages, ...(currentChapter ? { currentChapter } : {}) });
console.log(`\n========== 用户：${userMsg}  (currentChapter=${currentChapter ?? "—"}) ==========`);

const res = await fetch(`${BASE}/api/agent/chat`, { method: "POST", headers: { "content-type": "application/json" }, body });
if (!res.ok) { console.error("HTTP", res.status, await res.text()); process.exit(1); }

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buf = "";
let curEvent = null;
let dataLines = [];
let assistantText = "";
let thinkingChars = 0;
const toolCalls = {};

function handle(event, dataStr) {
  let data;
  try { data = JSON.parse(dataStr); } catch { data = dataStr; }
  // 路由发的是 { text }（见 agent-chat.ts），历史上误读 .delta 导致从不显示 AI 回话/思考——兼容两者。
  if (event === "reasoning-delta") { thinkingChars += ((data?.text ?? data?.delta)?.length ?? 0); return; }
  if (event === "text-delta") { assistantText += data?.text ?? data?.delta ?? ""; return; }
  if (event === "tool-call") {
    toolCalls[data.toolCallId] = data.toolName;
    const a = JSON.stringify(data.args ?? data.input ?? {});
    console.log(`\n  🔧 ${data.toolName}\n     args: ${a.length > 300 ? a.slice(0, 300) + "…" : a}`);
    return;
  }
  if (event === "tool-result") {
    const name = toolCalls[data.toolCallId] ?? data.toolName ?? "?";
    const r = data.result ?? data.output ?? {};
    console.log(`\n  ✅ ${name}`);
    for (const k of ["ok", "passed", "partialMiss", "errorIssueCount", "chapter", "summary"]) {
      if (r[k] !== undefined) console.log(`     ${k}: ${typeof r[k] === "string" ? r[k] : JSON.stringify(r[k])}`);
    }
    if (r.characterSelection?.summary) console.log(`     characterSelection: ${r.characterSelection.summary}`);
    if (r.refined) console.log(`     refined: passed=${r.refined.passed} blocking=[${(r.refined.blocking ?? []).map((b) => b.label || b.type).join("、")}]`);
    if (r.report) console.log(`     report: ${JSON.stringify(r.report).slice(0, 300)}`);
    return;
  }
  if (event === "tool-error") { console.log(`\n  ❌ tool-error: ${JSON.stringify(data).slice(0, 300)}`); return; }
  if (event === "error") { console.log(`\n  ⛔ error: ${JSON.stringify(data)}`); return; }
}

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (line.startsWith("event:")) curEvent = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    else if (line === "") {
      if (curEvent && dataLines.length) handle(curEvent, dataLines.join("\n"));
      curEvent = null; dataLines = [];
    }
  }
}

console.log(`\n  💭 思考 ${thinkingChars} 字（省略）`);
if (assistantText.trim()) console.log(`\n  💬 AI：${assistantText.trim().slice(0, 500)}`);

if (historyFile) {
  await writeFile(historyFile, JSON.stringify([...messages, { role: "assistant", content: assistantText.trim() || "(仅工具调用)" }], null, 2), "utf-8");
}
