/**
 * parity-kit — routes↔tools 双轨对拍测试的公共基建（非测试文件，无断言）。
 *
 * 用途：同一真引擎（@actalk/story-engine 不打 mock）+ 同一 fixture，分别驱动
 *   - HTTP 侧：callRoute(registerXxxRoutes, ...)（伪 req/res，见 routes/test-helpers.ts）
 *   - 工具侧：driveToolExecute(xxxTool, input, ...)（Mastra execute + buildProjectRequestContext）
 * 然后断言语义等价（ok 契约 / 落盘状态 / 关键输出字段），不做写盘字节对比以外的实现绑定。
 *
 * LLM 边界统一在各测试文件里 vi.mock（vi.mock 是文件级作用域，没法收敛到这里）：
 *   ../lib/llm-client.js       — createConfiguredWriterClient / resolveConfiguredChatModel /
 *                                callOpenAICompatibleChatModel / streamChatModelToText / buildProviderRequestHeaders
 *   ../lib/quality-judge.js    — judgeDraftQualityWithModel（质检/入库预览的 AI 判定层）
 *   ../agent/fact-ledger/fact-ledger.js — extractAndAppendFacts（入库后搭车抽事实，非被对拍面）
 * 引擎包一律走真实实现——对拍的价值就在于两侧共享同一引擎行为。
 *
 * fixture 纪律：项目必须建在 $HOME 下（makeHomeTempDir）——guardProjectPath 拒 $HOME 外的路径；
 * 写盘对拍用 makeParityTwinProjects 建双胞胎（route/tool 各一个同种子项目），避免互相污染；
 * 只读对拍（preview/quality/ai-review/steering）可共用一个项目目录。
 *
 * fixture 加固（2026-09-11，满负载并行 flake 治理）：当日并行 flake 的真根因是旧 globalSetup
 * 对共享基目录整体 rm -rf 把并行 vitest 进程的在飞 fixture 连根拔；该层已改为按进程独立
 * run 目录（见 home-test-tmp.ts / test-global-setup.ts）。本层保留的防御：建好后读 project.json
 * 自证落盘事实、双胞胎目录撞车当面炸出。
 *
 * 注（2026-09-11 第四轮复审 P2-4）：根因已除后，脚手架撞 ENOENT/EPERM 更可能是真 bug
 * （半建半删目录、权限问题），换目录重试侥幸过=洗绿——瞬时重试层已删，脚手架失败立即抛红。
 */
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createStoryProject, countDraftChineseCharacters } from "@actalk/story-engine";
import type { ToolExecutionContext } from "@mastra/core/tools";

import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import {
  defaultCommittedChapterPath,
  defaultDraftPath,
  stripLeadingMarkdownChapterHeading,
} from "../lib/project-io.js";
import { buildProjectRequestContext } from "../agent/request-context.js";

export { callRoute } from "../routes/test-helpers.js";
export { defaultCommittedChapterPath, defaultDraftPath, stripLeadingMarkdownChapterHeading };

export const PARITY_MAIN_CHARACTER = "林远";

/** 与 routes/commit.test.ts、tools 各测试同构的最小真实项目（createStoryProject 真引擎脚手架）。 */
export async function makeParityProject(prefix: string, title = "对拍书"): Promise<string> {
  const rootDir = await makeHomeTempDir(prefix);
  const { projectDir } = await createStoryProject({
    rootDir,
    title,
    genre: "都市",
    premise: "主角进入权力中心。",
    mainCharacterName: PARITY_MAIN_CHARACTER,
  });
  // 建好自证：projectDir 落在本次全新目录内、project.json 真可读——「脚手架建成」
  // 凭落盘事实，不凭 createStoryProject 没抛错。
  if (!projectDir.startsWith(rootDir)) {
    throw new Error(`fixture 目录越界：${projectDir} 不在 ${rootDir} 内`);
  }
  await readFile(join(projectDir, "project.json"), "utf-8");
  return projectDir;
}

/** 双胞胎 fixture：同参数建两个项目（route 侧 / tool 侧各一），供「写盘对拍」逐文件比较落盘结果。 */
export async function makeParityTwinProjects(
  prefix: string,
  title = "对拍书",
): Promise<{ readonly routeDir: string; readonly toolDir: string }> {
  const routeDir = await makeParityProject(`${prefix}r-`, title);
  const toolDir = await makeParityProject(`${prefix}t-`, title);
  // 双胞胎不变量：两目录必须真分家（mkdtemp 唯一后缀 + r-/t- 前缀双保险）——若将来重构把两侧
  // 指到同一目录，写盘对拍会互相污染还照绿，在这里当面炸出来。
  if (routeDir === toolDir) throw new Error(`双胞胎 fixture 目录撞车：${routeDir}`);
  return { routeDir, toolDir };
}

/* ---------------------------------------------------------------------------
 * 正文 fixture（字数均为确定性实测值，改文案必须同步重算——draft 对拍依赖 300–345 窗口）
 * ------------------------------------------------------------------------- */

const P1 = "林远在走廊尽头停下脚步，反复掂量手里这份账册的分量，心里盘算着接下来每一步该怎么走才不至于落人话柄。";
const P2 = "「这东西你拿稳了。」老王把灯压低，声音也跟着压下去，「出了这道门，谁问都别认。」";
const P3 = "林远点头，没多问。他知道老王这些年经手的东西比账面上多得多，问急了反而什么都套不出来。";
const P4 = "走廊尽头有脚步声靠近，他把账册塞进外套内袋，转身进了茶水间，顺手把门带上。";
const P5 = "茶水间的灯管忽明忽暗，他盯着杯子里浮起的茶叶，等着外面的脚步声走过去，才慢慢吐出一口气。";
const F1 = "楼下的停车场空荡荡的，只有夜班保安的手电在立柱之间晃来晃去，光柱扫过车牌又移开。";
const F2 = "他把账册又翻到最后两页，那几行数字的笔迹和前面不一样，墨色更新，落笔也更急。";
const F3 = "手机在口袋里震了一下，是一条没有署名的短信，只有四个字：别再查了。";
const F4 = "他没有回。屏幕暗下去之后，他把手机扣在桌上，抬眼看向走廊另一端那扇还亮着灯的办公室。";

/**
 * 干净正文：328 个中文字符（实测），落在 requestedDraftLength:300 的 [300,345] 窗口内；
 * 提及主角、含对话、零内置 AI 腔规则命中（无 仿佛/殊不知/不是…而是/眼中闪过 等）。
 */
export const PARITY_CLEAN_BODY = [P1, P2, P3, P4, P5, F1, F2, F3, F4].join("\n\n");

/** 自动去味对拍用的违规句（high 档「解释腔/剧透腔」：殊不知）。整句即段落，边界 。！？\n。 */
export const PARITY_DEAI_SENTENCE = "殊不知，林远早已把账册誊录了一份。";
/** 去味改写落地句（mock 改写模型的 afterText）：删掉「殊不知，」其余不动。 */
export const PARITY_DEAI_AFTER = "林远早已把账册誊录了一份。";
/** 含一处 high 档 AI 腔的正文：343 字（在 [300,345] 窗口内，HTTP 路不会因长度拒稿）。 */
export const PARITY_AI_FLAVOR_BODY = [P1, P2, P3, PARITY_DEAI_SENTENCE, P4, P5, F1, F2, F3, F4].join("\n\n");

const COMMIT_SENTENCE = "林远在会议室外停下脚步，反复掂量手里那份账册的分量，盘算着接下来每一步该怎么走。";

/** 入库/质检对拍用的工作稿正文：444 个中文字符（实测，>300 下限），提及主角。 */
export const PARITY_COMMIT_BODY = Array.from({ length: 12 }, () => COMMIT_SENTENCE).join("");

/** 工作稿文件文本（带 Markdown 章节标题行，与引擎 persistFastDraftBody 同构 `# 标题\n\n正文\n`）。 */
export function parityDraftFileText(chapter: number, body: string): string {
  return `# 第${chapter}章\n\n${body}\n`;
}

/** 入库/质检用的合格工作稿；revision 对拍用的三句稿（每句唯一、互不包含）。 */
export function parityCommitDraft(chapter: number): string {
  return parityDraftFileText(chapter, PARITY_COMMIT_BODY);
}

export const REVISE_SENTENCE_A = "林远把账册摊开在桌上，指尖点着最后两页那几行新墨迹，看了很久。";
export const REVISE_SENTENCE_B = "老王站在窗边没说话，手里的烟头积了长长一截灰，始终没弹。";
export const REVISE_SENTENCE_C = "楼下传来卷帘门落地的闷响，两人对视一眼，谁都没有先开口。";
export const REVISE_REPLACEMENT_B = "老王站在窗边，把烟头摁灭在窗台上，说我陪你去。";
export function parityReviseDraft(chapter: number): string {
  return parityDraftFileText(chapter, [REVISE_SENTENCE_A, REVISE_SENTENCE_B, REVISE_SENTENCE_C].join("\n\n"));
}

/** 引擎同款中文字符计数（[\u3400-\u9fff]），给「长度窗口假设」做显式断言用。 */
export function countParityCjk(text: string): number {
  return countDraftChineseCharacters(text);
}

/* ---------------------------------------------------------------------------
 * 落盘读写与驱动辅助
 * ------------------------------------------------------------------------- */

export async function writeParityDraft(projectDir: string, chapter: number, content: string): Promise<string> {
  const path = defaultDraftPath(projectDir, chapter);
  await writeFile(path, content, "utf-8");
  return path;
}

export async function readTextIfExists(path: string): Promise<string | undefined> {
  return readFile(path, "utf-8").catch(() => undefined);
}

export async function pathExists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

interface ExecutableTool {
  readonly execute?: (input: unknown, context: ToolExecutionContext) => Promise<unknown>;
}

/**
 * 驱动工具 execute 层（不是纯 logic 层）：RequestContext 注入 projectDir/currentChapter/userTurnText，
 * 让意图门、章号回退、章序护栏、快照包装这些 execute 级行为全部参与对拍。
 */
export async function driveToolExecute(
  tool: ExecutableTool,
  input: Record<string, unknown>,
  opts: {
    readonly projectDir: string;
    readonly currentChapter?: number;
    readonly userTurnText?: string;
  },
): Promise<Record<string, unknown>> {
  const execute = tool.execute;
  if (!execute) throw new Error("tool has no execute");
  const context = {
    requestContext: buildProjectRequestContext(opts.projectDir, opts.currentChapter, undefined, opts.userTurnText),
  } as unknown as ToolExecutionContext;
  return (await execute(input, context)) as Record<string, unknown>;
}

/** llm-client 的 ResolvedChatModel 假值：只带代码真实读取的字段（baseUrl/apiKey/customHeaders/profile/thinking）。 */
export function fakeResolvedChatModel(model = "parity-model") {
  return {
    provider: { id: "parity-provider", name: "对拍", baseUrl: "https://parity.invalid" },
    profile: { id: "parity-profile", label: "对拍档案", model, temperature: 0.2 },
    apiKey: "parity-key",
    thinking: false,
    thinkingDialect: "none",
    customHeaders: {},
  };
}

/** 固定正文的 mock writerClient（引擎 runFastDraft 的唯一 LLM 触点；两侧共用同一正文才可对拍）。 */
export function staticWriterClient(body: string, title = "夜探") {
  return {
    async generateDraft() {
      return { title, content: body };
    },
  };
}
