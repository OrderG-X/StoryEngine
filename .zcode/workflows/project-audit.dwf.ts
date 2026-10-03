/* zcode-workflow
description: 对 story-engine-ng 做全项目体检：并行跑基线三件套（4 包 tsc/build/vitest + desktop
  安全门），可选按 focusItems
  清单逐项核对修复落地情况（核对员+复核员双验），再由引擎/服务端/前端三个审计员并行扫静默失败、并发窗口、裸写盘、路径泄漏等问题，每条发现经独立复核员确认后汇总成
  markdown 报告。
whenToUse: 修完一批问题后想验证落地+全量扫尾时；或定期给项目做体检时。传 focusItems 可核对指定修复清单，不传则只跑基线+分域审计。
args:
  focusItems:
    type: json
    description: 专项核对清单 [{item,title,detail}]：核对返工/修复是否落地；不传则跳过专项核对与交叉复核两个阶段，只跑基线+三路分域审计
    default: []
  reportPath:
    type: string
    description: 审计报告 markdown 输出路径（工作区相对）
    default: docs/audit-latest-full-sweep.md
*/
// —— 结果类型 ——

interface BaselineCheck {
  /** 检查名，如「引擎 vitest」。 */
  name: string;
  /** 进程退出码；-1 表示命令没能执行（超时/启动失败）。 */
  exitCode: number;
  /** 测试计数行 / built in 行 / 兜底末行。 */
  summary: string;
}

interface FocusItem {
  /** 专项核对条目编号（从 1 起，仅用于展示与看板 key）。 */
  item: number;
  /** 条目短标题。 */
  title: string;
  /** 核对要求的具体描述（含 path:line 线索）。 */
  detail: string;
}

interface ReworkItemCheck {
  /** 专项条目编号。 */
  item: number;
  /** 条目短标题。 */
  title: string;
  /** 核对结论。 */
  status: "已修妥" | "半修" | "未修" | "无法判定";
  /** 主要文件:行。 */
  where: string;
  /** 该处代码现状（亲自读到的关键行）。 */
  evidence: string;
  /** 未修妥时还差什么；已修妥为空串。 */
  gap: string;
}

interface ReworkVerifyNote {
  /** 对应条目编号。 */
  item: number;
  /** 核对员的判定是否站得住。 */
  agree: boolean;
  /** 一句话：复核时实际读到什么。 */
  note: string;
}

interface AuditFinding {
  /** 工作区相对路径，尽量带行号："packages/story-engine/src/foo.ts:42"。 */
  where: string;
  /** 一句话说清问题是什么（不是说怎么修）。 */
  what: string;
  /** 读到的代码证据。 */
  evidence: string;
  /** 独立复核后的状态。 */
  status: "verified" | "unconfirmed";
  /** high 仅留给丢数据/崩溃/错结果；medium=功能受损或误导用户；low=其余真问题。 */
  severity: "low" | "medium" | "high";
  /** 问题类别：静默失败/路径泄漏/并发窗口/裸写盘/死代码/投影缺口/其他。 */
  category: string;
}

interface Confirmation {
  /** reproduced=证据成立；not_reproduced=按证据找不到或问题不成立；unclear=证据不足。 */
  verdict: "reproduced" | "not_reproduced" | "unclear";
  /** 一句话：复核时实际看到什么。 */
  note: string;
}

interface SynthesisResult {
  /** 两三句话回答「项目现在什么状态、最要紧的事是什么」。 */
  conclusion: string;
  /** 本轮实际执行的检查与核对方式。 */
  verified: string[];
  /** 没查什么、为什么。 */
  notCovered: string[];
  /** 写好的报告文件路径（工作区相对）。 */
  reportPath: string;
}

interface Finding {
  /** Workspace-relative path, with a line when it applies: "src/a.ts:42". */
  where: string;
  /** One sentence: what is wrong, or what was found. */
  what: string;
  /** What showed it: the lines read, or the command and the output that proved it. */
  evidence: string;
  /** "verified" when an independent subagent or a deterministic check confirmed it; "unconfirmed" when confirmation failed or was not attempted. */
  status: "verified" | "unconfirmed";
  /** How much it matters. Reserve "high" for data loss, a crash, or a wrong result. */
  severity: "low" | "medium" | "high";
}

interface WorkflowReport {
  /** Two or three sentences answering what the user asked for. */
  conclusion: string;
  findings: Finding[];
  /** What the run checked and how: the commands it ran, the files it covered. */
  verified: string[];
  /** What the run did not look at or could not check, and why. */
  notCovered: string[];
}

// —— 入参 ——

const focusItems: FocusItem[] = [];
if (Array.isArray(args.focusItems)) {
  for (const f of args.focusItems) {
    if (typeof f === "object" && f !== null) {
      const rec = f as Record<string, unknown>;
      if (typeof rec.item === "number" && typeof rec.title === "string" && typeof rec.detail === "string") {
        focusItems.push({ item: rec.item, title: rec.title, detail: rec.detail });
      }
    }
  }
}
const hasFocus = focusItems.length > 0;
const reportPath =
  typeof args.reportPath === "string" && args.reportPath.trim()
    ? args.reportPath.trim()
    : "docs/audit-latest-full-sweep.md";

// —— 纯工具 ——

function extractSummary(out: string): string {
  const tests = /^\s*Tests\s{2,}.*$/m.exec(out);
  if (tests && tests[0]) return tests[0].trim();
  const files = /^\s*Test Files\s{2,}.*$/m.exec(out);
  if (files && files[0]) return files[0].trim();
  const built = /✓ built in .*$/m.exec(out);
  if (built && built[0]) return built[0].trim();
  const lines = out.trim().split("\n");
  const last = lines[lines.length - 1] ?? "";
  return last.slice(0, 160) || "（无输出）";
}

// 专项条目严重度由调用方在清单外自行判断；工作流统一按 medium 计，除非下面映射命中。
const REWORK_SEVERITY: Record<number, "high" | "medium"> = {};

const FOCUS_SECTION = hasFocus
  ? `## 二、专项核对 ${focusItems.length} 项逐项（状态、证据、复核意见、还差什么）；`
  : "## 二、专项核对：本轮未提供 focusItems，跳过（在报告里如实说明）；";

// 看板：专项核对状态（用户可实时看进度）
artifact.board("rework-board", {
  key: "item",
  status: "status",
  columns: ["已修妥", "半修", "未修", "无法判定"],
  cardTitle: "title",
  detail: [{ field: "gap", label: "还差" }],
  title: "专项核对状态",
});

// —— 阶段 1：基线（纯确定性检查，不开子代理）——

phase("跑基线三件套：类型检查、构建、全量测试");
const CHECKS: { readonly name: string; readonly args: readonly string[]; readonly timeoutMs: number }[] = [
  { name: "引擎 tsc", args: ["-C", "packages/story-engine", "exec", "tsc", "--noEmit"], timeoutMs: 300_000 },
  { name: "引擎 vitest", args: ["-C", "packages/story-engine", "exec", "vitest", "run"], timeoutMs: 600_000 },
  { name: "UI tsc", args: ["-C", "packages/story-engine-ui", "exec", "tsc", "--noEmit"], timeoutMs: 300_000 },
  { name: "UI vite build", args: ["-C", "packages/story-engine-ui", "exec", "vite", "build"], timeoutMs: 600_000 },
  { name: "UI vitest", args: ["-C", "packages/story-engine-ui", "exec", "vitest", "run"], timeoutMs: 600_000 },
  { name: "CLI tsc", args: ["-C", "packages/story-engine-cli", "exec", "tsc", "--noEmit"], timeoutMs: 300_000 },
  { name: "CLI vitest", args: ["-C", "packages/story-engine-cli", "exec", "vitest", "run"], timeoutMs: 600_000 },
  { name: "desktop 安全门", args: ["-C", "packages/story-engine-desktop", "test"], timeoutMs: 300_000 },
];
const baselinePromise = (async (): Promise<BaselineCheck[]> => {
  const runs = await Promise.all(CHECKS.map(async (check): Promise<BaselineCheck> => {
    try {
      const r = await world.run("pnpm", [...check.args], { timeoutMs: check.timeoutMs });
      return { name: check.name, exitCode: r.exitCode, summary: extractSummary(`${r.stdout}\n${r.stderr}`) };
    } catch (error) {
      return { name: check.name, exitCode: -1, summary: `未能执行：${String(error)}` };
    }
  }));
  return runs;
})();
const gitStatusPromise: Promise<GitStatus | undefined> = git.status().catch(() => undefined);
log("基线 8 项检查并行开跑：引擎/UI/CLI 的 tsc、vite build、vitest 全量，加 desktop 安全门");

// —— 阶段 2（可选）：专项清单核对 ——

let reworkFailure = "";
let reworkPromise: Promise<ReworkItemCheck[]> | undefined;
if (hasFocus) {
  phase("逐条核对专项清单");
  const itemLines = focusItems.map((f) => `${f.item}.【${f.title}】${f.detail}`).join("\n");
  const checkerAsk = agent("专项清单核对员", {
    system:
      "你是专项清单核对员：判断只认当前工作区的代码实况，清单或报告说什么不算数（之后可能有新提交）；" +
      "每条结论都要有 path:line 与你亲自读到的关键行作证据；拿不准就标「无法判定」，绝不猜。只读代码，不跑测试、不编辑文件。",
  }).ask<ReworkItemCheck[]>(
    "背景：story-engine-ng 是 pnpm monorepo（packages/story-engine 纯引擎、story-engine-ui 含 React 前端与 src/server Node 服务端、story-engine-cli、story-engine-desktop）。\n" +
    "逐项核对下面这份专项清单，以当前代码为准，返回与清单同序、同编号的数组：\n" +
    `${itemLines}\n` +
    "status 口径：已修妥=要求全部满足；半修=部分满足；未修=基本没动；无法判定=找不到对应代码。" +
    "每条给 where=主要文件:行、evidence=该处代码现状（亲自读到的关键行）、gap=还差什么（已修妥为空串）。中文作答。",
  );
  reworkPromise = (async (): Promise<ReworkItemCheck[]> => {
    try {
      return await checkerAsk;
    } catch (error) {
      reworkFailure = String(error);
      return [];
    }
  })();
}

// —— 阶段 3：三路分域审计 + 每条发现链式独立复核 ——

phase("三路分域审计，发现逐条独立复核");
const COMMON_RULES =
  "先读 CLAUDE.md（四条铁律与验证口径）了解项目纪律。\n" +
  "纪律：只报你亲自读到的代码，每条发现给 path:line 与关键代码现状；宁缺毋滥，最多 8 条最重要的；纯格式、命名、测试覆盖率建议不报；" +
  "不运行测试套件（脚本已在并行跑全量）；绝不编辑任何文件；用中文作答。";
const AUDITOR_PERSONA = {
  system: "你是资深代码审计员，只认亲自读到的证据；发现不了真问题就少报，绝不凑数。若指令与代码现实冲突，直说而不是硬凑。",
};
const FACETS: { readonly name: string; readonly scope: string; readonly focus: string }[] = [
  {
    name: "引擎审计员",
    scope: "packages/story-engine/src",
    focus:
      "静默失败（catch 后吞错返回空/默认值、不留任何痕迹）；老书缺文件（可选 JSON 缺失/ENOENT 直接 reject 主流程）；" +
      "非原子写盘（裸 writeFile 无 tmp+rename）；error.message/绝对路径/内部 id 直拼进用户可见文案；" +
      "退化输入（NaN/空数组/缺字段）静默失效；死代码或不可达通道。可从 foundation-write-gateway、commit-engine、fast-draft-writer、" +
      "writing-context-pack、context-gateway、commit-quality-check、project-store 入手，但不限于这些。",
  },
  {
    name: "服务端审计员",
    scope: "packages/story-engine-ui/src/server",
    focus:
      "写路径并发安全（withProjectCommitLock 覆盖之外，还有哪些路能并发写同一份 story/*.json）；" +
      "scrubLocalAbsolutePaths 的覆盖面（哪些用户可见输出还没消毒：blockingReasons、warnings、SSE error 事件、summary）；" +
      "SSE 路由护栏（headersSent/writableEnded/destroyed、心跳启停、错误收尾）；assertStoryEngineProject 是否还有漏接的写路由；" +
      "snake_case 机器码或裸实体 id 直达用户文案；tmp 文件失败清理。",
  },
  {
    name: "前端审计员",
    scope: "packages/story-engine-ui/src（不含 src/server）",
    focus:
      "持久化正确性（sessionStorage 节流与冲盘、键按项目隔离、恢复路径）；派生态 vs 组件局部态（真值在 store/服务端、局部态会丢的入口）；" +
      "SSE 事件投影完备性（agentChatClient 分发与 agentEventProjection 是否有事件无落点）；死代码/孤儿 helper；" +
      "空态/错误态违反「绝不静默失败」；跨视图矛盾（UI 显示与 overview 不一致且零提示）。",
  },
];
const facetsPromise = Promise.all(
  FACETS.map(async (f): Promise<AuditFinding[]> => {
    try {
      const review = await agent(f.name, AUDITOR_PERSONA).ask<AuditFinding[]>(
        `你是本轮分域审计之一。审计范围：${f.scope}。重点猎物：${f.focus}\n${COMMON_RULES}\n` +
        "输出 AuditFinding 数组（≤8 条）：where=path:line；what=一句话问题；evidence=你读到的代码证据；" +
        "severity（high 仅丢数据/崩溃/错结果，medium=功能受损或误导用户，low=其余真问题）；category=问题类别（静默失败/路径泄漏/并发窗口/裸写盘/死代码/投影缺口/其他）。",
      );
      const toConfirm = review.slice(0, 8);
      const overflow = review.slice(8);
      const confirmed = await Promise.all(
        toConfirm.map(async (finding, i): Promise<AuditFinding> => {
          try {
            const c = await agent(`独立复核-${f.name}-${i + 1}`, {
              system: "你是独立复核员，只认自己读到的代码；不同意就直说。",
            }).ask<Confirmation>(
              `请独立复核下面这条审计发现（只读代码验证；不跑测试、不编辑文件）：\n${JSON.stringify(finding)}\n` +
              "亲自打开 where 指向的文件与行读上下文，判定：evidence 描述的代码确实存在且问题成立=reproduced；" +
              "按证据找不到或问题不成立=not_reproduced；证据不足无法判定=unclear。note 一句话写你实际看到什么。中文。",
            );
            return {
              ...finding,
              status: c.verdict === "reproduced" ? ("verified" as const) : ("unconfirmed" as const),
              evidence: `${finding.evidence}｜复核：${c.note}`,
            };
          } catch {
            return { ...finding, status: "unconfirmed" as const, evidence: `${finding.evidence}｜复核未能执行` };
          }
        }),
      );
      return [
        ...confirmed,
        ...overflow.map((finding): AuditFinding => ({
          ...finding,
          status: "unconfirmed" as const,
          evidence: `${finding.evidence}｜超出复核配额，未复核`,
        })),
      ];
    } catch (error) {
      return [{
        where: f.scope,
        what: `${f.name}的审计子任务未能完成`,
        evidence: String(error),
        status: "unconfirmed" as const,
        severity: "low" as const,
        category: "审计基础设施",
      }];
    }
  }),
).then((groups) => groups.flat());

const [baseline, reworkChecks, facetFindings, gitStatus] = await Promise.all([
  baselinePromise,
  reworkPromise ?? Promise.resolve([] as ReworkItemCheck[]),
  facetsPromise,
  gitStatusPromise,
]);
log(
  `基线通过 ${baseline.filter((c) => c.exitCode === 0).length}/${baseline.length}；` +
  `专项核对 ${reworkChecks.length} 项；分域审计新发现 ${facetFindings.length} 条` +
  `${gitStatus ? `；工作区${gitStatus.clean ? "干净" : "有未提交改动"}` : ""}`,
);

// —— 阶段 4（可选）：交叉复核专项核对结论 ——

let verifyNotes: ReworkVerifyNote[] = [];
if (hasFocus && reworkChecks.length > 0) {
  phase("交叉复核专项核对结论");
  verifyNotes = await agent("专项核对复核员", {
    system: "你是独立复核员：只认自己读到的代码，别人（包括核对员）的判定一律重新验证；不同意就直说。",
  }).ask<ReworkVerifyNote[]>(
    `以下是核对员对专项清单 ${reworkChecks.length} 项的判定。请逐项独立复核：亲自打开每条 where/evidence 引用的位置读代码（只读，不跑测试、不编辑），判断其 status 是否站得住。\n` +
    `${JSON.stringify(reworkChecks)}\n` +
    "每项返回 {item, agree（判定站得住=true）, note（一句话：你实际读到了什么）}。中文作答。",
  );
}
const verifyMap = new Map(verifyNotes.map((n) => [n.item, n]));

// —— 阶段 5：汇总 + 发布 ——

phase("汇总并发布审计报告");
const payload = JSON.stringify({
  baseline,
  gitStatus: gitStatus ? { clean: gitStatus.clean, branch: gitStatus.branch ?? "", unstaged: gitStatus.unstaged.length } : null,
  rework: reworkChecks.map((c) => ({ ...c, verify: verifyMap.get(c.item) ?? null })),
  findings: facetFindings,
});
const synth = await agent("报告撰写员", {
  system: "你是审计报告撰写员：报告里每个事实都来自给你的数据或你亲手读的代码，数据里没有的不编；unconfirmed 必须如实标注，绝不升格成已证实。",
}).ask<SynthesisResult>(
  `把本轮全项目审计写成一份完整中文报告，用你的文件工具写到 ${reportPath}（只创建/写这一个文件）。数据如下（基线检查、git 状态、专项核对判定与复核意见、分域审计发现）：\n` +
  `${payload}\n` +
  `报告结构：# 全项目审计；## 一、基线三件套（8 项检查的通过/失败与计数）；${FOCUS_SECTION}` +
  `## 三、新发现（verified 在前，unconfirmed 单独标注并保留）；## 四、未覆盖（未做真机/dev-server E2E、未做变异验证、desktop 只跑了安全门等，据实写）；` +
  `## 五、总结论（两三句：项目当前状态、最要紧的事）。引用一律带 path:line。除该文件外不改任何文件、不跑测试。` +
  `返回 {conclusion（两三句总结论）, verified（本轮实际执行的检查与核对方式，字符串数组）, notCovered（没查的与为什么）, reportPath（就是 ${reportPath}）}。`,
);
for (const c of reworkChecks) {
  report({ item: c.item, title: `第${c.item}项 ${c.title}`, status: c.status, gap: c.gap || "—" }, "rework-board");
}
let published = false;
const PUBLISH_OPTS = { title: "全项目审计报告", description: "基线三件套、专项核对、三路分域审计与逐条独立复核的完整结果。", primary: true };
try {
  await artifact.file("audit-report", synth.reportPath, PUBLISH_OPTS);
  published = true;
} catch {
  const repair = await agent("报告补写员").ask<SynthesisResult>(
    `报告文件发布失败，多半是 ${reportPath} 没写成。请基于下面这份数据把审计报告写到 ${reportPath}（用你的文件工具；结构：基线/专项核对逐项/新发现/未覆盖/总结论，中文，引用带 path:line）：\n${payload}\n` +
    `返回 {conclusion, verified, notCovered, reportPath}。`,
  );
  try {
    await artifact.file("audit-report", repair.reportPath, PUBLISH_OPTS);
    published = true;
  } catch {
    log("报告文件两次发布失败；结果以下方 return 为准");
  }
}

const failedBaseline = baseline.filter((c) => c.exitCode !== 0);
const reworkFindings: Finding[] = reworkChecks
  .filter((c) => c.status !== "已修妥")
  .map((c): Finding => {
    const note = verifyMap.get(c.item);
    return {
      where: c.where || "（见 evidence）",
      what: `专项第 ${c.item} 项【${c.title}】${c.status}：${c.gap || c.evidence}`,
      evidence: `${c.evidence}${note ? `｜复核：${note.note}` : ""}`,
      status: note?.agree === true ? "verified" : "unconfirmed",
      severity: REWORK_SEVERITY[c.item] ?? "medium",
    };
  });
const findings: Finding[] = [
  ...failedBaseline.map((c): Finding => ({
    where: `基线检查：${c.name}`,
    what: `基线检查失败（退出码 ${c.exitCode}）`,
    evidence: c.summary,
    status: "verified",
    severity: "high",
  })),
  ...reworkFindings,
  ...facetFindings,
];
const report_: WorkflowReport = {
  conclusion: synth.conclusion,
  findings,
  verified: [
    `基线 8 项确定性检查：${baseline.map((c) => `${c.name} ${c.exitCode === 0 ? "✓" : "✗"}（${c.summary}）`).join("；")}`,
    ...(hasFocus ? ["专项核对由核对员与复核员两双独立眼睛读码核对"] : []),
    "分域审计（引擎/服务端/前端）每条发现由独立复核员读码确认，未确认的已标注 unconfirmed",
    ...synth.verified,
  ],
  notCovered: [
    ...synth.notCovered,
    ...(!hasFocus ? ["未提供 focusItems，专项核对阶段未运行"] : []),
    ...(reworkFailure ? [`专项核对子任务失败（${reworkFailure}），各项状态未确认`] : []),
    ...(published ? [] : ["审计报告文件未能发布为产物卡片，完整内容以 findings 为准"]),
  ],
};
return report_;
