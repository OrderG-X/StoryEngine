/**
 * 记账员（2026-10-12 编辑部 T2）：从第 1 章起一章一章跟读、自己记笔记的章节语义声明者。
 *
 * 定稿预览时的「章节声明」过去只看这一章正文 + 一串开着的线索标题，模型没读过前文：
 * 同一件事记成三条线索、做完的打算不会收口、新称呼认不出是已有人物。记账员在读完第 N-1 章那一刻的
 * 窗口后面接上本章新稿 + 声明要求，让它带着读过的全文和自己的账目笔记来声明。
 *
 * 声明契约：字段说明和 JSON 键复用 buildChapterDeltaSystemSpec / buildChapterDeltaContextSections（chapter-delta-declaration
 * 的确定性工具），解析复用 parseChapterDeltaDeclaration + resolveThreadRefs，引擎的证据校验（verifyChapterDelta）不动。
 * 提示词额外强调的几条（只报一条 / 做完的打算报进 resolvedForeshadowing / 新称呼用 aliasOf 归并）是通用写法，
 * 不含任何具体书名、人名。
 */
import { withStep } from "../lib/token-meter.js";
import {
  buildChapterDeltaContextSections,
  buildChapterDeltaSystemSpec,
  parseChapterDeltaDeclaration,
  resolveThreadRefs,
  warnLikelyCopiedSummaries,
  type DeclarationDropListener,
} from "../agent/tools/chapter-delta-declaration.js";
import type { ChapterDeltaDeclarationOutcome } from "../services/commit-service.js";
import { buildColdReaderWindow, ensureReaderWindow, type BrainCallModel, type ColdCoverage, type ReaderRole } from "./reader-window.js";
import { readerWaitingHandlers, type ReaderWaited } from "./reader-progress.js";

export const LEDGER_ROLE: ReaderRole = {
  id: "ledger",
  system: [
    "你是这本长篇小说的记账员，从第 1 章起一章一章跟读，管人物、线索、打算、目标。",
    "每读完一章，你写一份记账笔记，只记以后记账要用的硬信息，不复述情节。",
    "作者交来新的一章要定稿时，你对照读过的前文原文和你的笔记，把这一章引起的变化列成结构化声明。",
  ].join("\n"),
  noteTask: [
    "读完写这一章的记账笔记（纯文本，800 字以内），只记硬信息：",
    "- 人物：本名、别称、称呼（谁叫谁什么）、身份；本章新出现的称呼指的是谁",
    "- 开着的问题 / 悬念：新冒出的、推进的、揭晓的各是哪条",
    "- 人物的打算 / 待办：新立的、做完的、放弃的各是哪条",
    "- 主角的目标：新立的、推进的、达成的各是哪条",
  ].join("\n"),
};

/** 记账员比旧路多强调的几条（通用写法，绝不写进具体书名、人名）。 */
const LEDGER_EXTRA_RULES: readonly string[] = [
  "你读过前文：同一件事只报一条；前文已经立过的问题不要当成新开的线索再报一遍。",
  "本章第一次冒出来的一个悬念也只开一条线索：同一个谜不要既开「它是什么」又开「为什么是它」两条——角度不同也算同一条，报成一条，把疑点写进 summary。",
  "前文立过的打算 / 待办，本章正文写出了做完或兑现，就报进 resolvedForeshadowing 并把那条的编号（如 T2）填进 targetThreadHint。报 keyLeads advanced 或留 pendingIntents 之前先想一遍：它是不是其实已经做完了？做完了的一律报回收，别让它一直挂着；谜底揭开也一样，不要新建目标。",
  "判断待办做没做完，只看那个动作本身：正文写到这个动作做成了（问过了、找到了、交出去了、打开了、办下来了），这条待办就算完成，报回收；动作完成之后又冒出的新问题，是另外的事，另开新线索，不影响旧待办回收。",
  "正文里出现的新称呼如果指的是已有人物：charactersPresent 的 name 写正文里那个称呼（必须逐字出现在 quote 里），aliasOf 填那个人的已确立名字，identityHint 写「即 某某」。同一个人本章的多种叫法只报一条，用最主要的那个。",
  "time 每章都给 daysSincePrevious（第 1 章没有上一章，整个 time 省略）：正文明写隔几天就照写；没明写就对照你读过的上一章结尾和本章开头判断——上一章结尾在夜里、本章开头接着当晚的事就是 0（同一天），隔了一夜才是 1。quote 给本章开头最能说明时间的那句原句（代码会逐字核对在正文里）。只有确实判断不了才不填这个数。",
  "可选字段（conflict / discovery / decision / continuityWithPrevious）没有就整个键都不写；写了就每个子键都写全，不要只写一半或给空对象。",
];

export interface LedgerDeclareInput {
  readonly projectDir: string;
  readonly chapter: number;
  readonly draft: string;
  readonly callModel: BrainCallModel;
  /** 开着的线索标题（照现有做法附上，声明里对号入座用）。 */
  readonly openThreadTitles?: readonly string[];
  /** 已确立的角色名（照现有做法附上）。 */
  readonly establishedNames?: readonly string[];
  /** 已存在的主线/阶段目标标题（照现有做法附上）。 */
  readonly openGoalTitles?: readonly string[];
  /** 笔记存放的根目录；缺省就是书目录。 */
  readonly notesRoot?: string;
  /** 需要新写的笔记超过这个数就不当场补，改走冷窗口（已有笔记 + 最近 K 章原文先记账，R4.4）。 */
  readonly maxCatchUp?: number;
}

export interface LedgerDeclareResult {
  /** 声明结果（status=model/fallback），调用方直接当声明通道的返回用。 */
  readonly outcome: ChapterDeltaDeclarationOutcome;
  /** 冷窗口＝记账员还没读完全书（笔记要补的太多，后台在补），这次按已有笔记 + 最近 K 章原文记的账。
   *  已并进 outcome.cold（预览卡据此如实标「按最近 K 章记账」）；这里单独留一份给调用方触发后台补读。 */
  readonly cold?: ColdCoverage;
  /** 这次先等了补读（R5.2＋R6.1，谁补的都算）：回执据此加「这次先等记账员读完…再记账」。已并进 outcome.waited。 */
  readonly waited?: ReaderWaited;
}

/** 把异常文本压成一行、截短（不含草稿正文）。 */
function compactErrorText(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).trim().replace(/\s+/gu, " ");
  return message.length > 160 ? `${message.slice(0, 160)}…` : message || "未知错误";
}

/**
 * 记账员声明一章的语义：先确保读到第 N-1 章（缺的笔记按顺序补），再在窗口后接一条 user 消息
 * （本章新稿 + 上下文段 + 字段说明和额外强调）要一份 JSON 声明。解析、引用编号换算全复用旧路的函数，
 * 输出结构与旧声明完全一样；坏 JSON / 调用失败 → status=fallback + 原因，不抛。
 */
export async function declareChapterDeltaByLedger(input: LedgerDeclareInput): Promise<LedgerDeclareResult> {
  const fallback = (reason: string): LedgerDeclareResult => ({ outcome: { status: "fallback", reason } });
  if (!input.draft || input.draft.trim().length === 0) {
    return fallback("正文为空，没有可声明的章节语义");
  }
  let window;
  let cold: ColdCoverage | undefined;
  let waited: ReaderWaited | undefined;
  try {
    // 等读（R5.2＋R6.1）：补读期间进度行标「记账在等它读完」（进程内登记，进锁前后都算）；
    // 等过了（笔记是谁补上的都算）由 ensureReaderWindow 带回 waited，回执如实说等了哪几章。
    const root = input.notesRoot ?? input.projectDir;
    const waiting = readerWaitingHandlers(root, LEDGER_ROLE.id, input.chapter - 1);
    const ready = await withStep("跟读补笔记", () => ensureReaderWindow({
      projectDir: input.projectDir,
      role: LEDGER_ROLE,
      upTo: input.chapter - 1,
      callModel: input.callModel,
      ...(input.notesRoot ? { notesRoot: input.notesRoot } : {}),
      ...(input.maxCatchUp !== undefined ? { maxCatchUp: input.maxCatchUp } : {}),
      waitingAs: "记账",
      onCatchUpBegin: waiting.onCatchUpBegin,
      onProgress: waiting.onProgress,
      onCatchUpEnd: waiting.onCatchUpEnd,
    }));
    waited = ready.waited;
    if (ready.missing > 0) {
      // R4.4 冷窗口兜底：要补的笔记太多不再走 fallback 空转——已有笔记 + 最近 K 章原文先记账，
      // 冷窗口的范围随声明带回（预览卡如实标），笔记由调用方在后台接着补。冷窗口不落盘任何笔记。
      const built = await buildColdReaderWindow({
        projectDir: input.projectDir,
        role: LEDGER_ROLE,
        upTo: input.chapter - 1,
        ...(input.notesRoot ? { notesRoot: input.notesRoot } : {}),
      });
      window = built.messages;
      cold = built.coverage;
    } else {
      window = ready.messages;
    }
  } catch (error) {
    // 补到一半失败：已写下的笔记留着，下次接着补；这次如实说没声明成。
    return fallback(`记账员读前文没成：${compactErrorText(error)}`);
  }
  const onDrop: DeclarationDropListener = (field, detail) => {
    console.warn(`[chapter-delta] ch${input.chapter} 声明字段丢弃 ${field}：${detail}`);
  };
  try {
    const task = [
      `这是作者刚交来的第 ${input.chapter} 章正文（上面还没给过你），即将定稿入库。对照你读过的前文原文和记账笔记，声明这一章的语义。`,
      ...LEDGER_EXTRA_RULES,
      buildChapterDeltaSystemSpec(),
    ].join("\n\n");
    const context = buildChapterDeltaContextSections({
      ...(input.openThreadTitles ? { openThreadTitles: input.openThreadTitles } : {}),
      ...(input.establishedNames ? { establishedNames: input.establishedNames } : {}),
      ...(input.openGoalTitles ? { openGoalTitles: input.openGoalTitles } : {}),
    });
    const text = await withStep("记账员", () => input.callModel(
      [...window, { role: "user", content: `【第 ${input.chapter} 章 正文（待定稿）】\n${input.draft}${context}\n\n${task}` }],
      { json: true },
    ));
    const declaration = parseChapterDeltaDeclaration(text, input.chapter, onDrop);
    if (!declaration) {
      console.warn(`[chapter-delta] ch${input.chapter} 记账员声明整体失败（输出无法解析成 JSON），这章按确定性规则兜底`);
      return fallback("记账员的输出无法解析成结构化 JSON");
    }
    warnLikelyCopiedSummaries(input.chapter, declaration);
    const resolved = resolveThreadRefs(declaration, input.openThreadTitles ?? []);
    // 冷窗口记账：范围并进 outcome（预览卡据此如实标），单独一份让调用方好触发后台补读；等读那一句同理（R5.2）。
    return {
      outcome: { status: "model", declaration: resolved, ...(cold ? { cold } : {}), ...(waited ? { waited } : {}) },
      ...(cold ? { cold } : {}),
      ...(waited ? { waited } : {}),
    };
  } catch (error) {
    console.warn(`[chapter-delta] ch${input.chapter} 记账员声明调用异常（${error instanceof Error ? error.message : String(error)}），这章按确定性规则兜底`);
    return fallback(`记账员声明模型调用失败：${compactErrorText(error)}`);
  }
}
