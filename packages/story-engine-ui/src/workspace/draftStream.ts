/**
 * 写稿操作（draft.change）的正文流怎么拼（写作版本 P2a 设计 6.7）：对话这一轮里跟着的、重开书接着看的都用这一份。
 *
 * - 正文流按执行（exec）分：一步重做（停过再接着做、整步重来）换了 exec，之前流出来的那份作废、从新的那份重新拼；
 *   旧执行迟到的片段丢掉。
 * - 同一个 exec 里 streamSeq 递增：订阅时服务端先补发到现在流出来的那份（base + 整段 replace，同一个号），之后是增量；
 *   号比见过的小的丢掉，号一样的只认整段换（replace / base），追加的不重复拼。
 * - base 是接着写时本来写好的那段：原样显示在新写的前面，换引号、去星号只动新写的（streamingDraftDisplay）。
 */
import type { OperationLiveData } from "../api/agentChatClient.js";

export interface DraftStreamState {
  readonly exec: string | null;
  /** 旧执行（这次操作里换掉的），它们迟到的片段不要。 */
  readonly superseded: readonly string[];
  readonly seq: number;
  readonly base: string;
  readonly text: string;
}

export const EMPTY_DRAFT_STREAM: DraftStreamState = { exec: null, superseded: [], seq: 0, base: "", text: "" };

type DraftDelta = Extract<OperationLiveData, { readonly type: "draft-delta" }>;

/** 收到一段正文流：返回新的样子（这段不要就原样返回）。 */
export function applyDraftDelta(state: DraftStreamState, event: DraftDelta): DraftStreamState {
  if (state.superseded.includes(event.exec)) return state;
  const fresh = event.exec !== state.exec;
  const current: DraftStreamState = fresh
    ? { exec: event.exec, superseded: state.exec ? [...state.superseded, state.exec] : state.superseded, seq: 0, base: "", text: "" }
    : state;
  const whole = event.replace === true || event.base === true;
  if (!fresh && (event.streamSeq < current.seq || (event.streamSeq === current.seq && !whole))) return state;
  if (event.base) return { ...current, seq: event.streamSeq, base: event.text, text: "" };
  return { ...current, seq: event.streamSeq, text: event.replace ? event.text : current.text + event.text };
}

/** 一步开始了，稿纸顶上说 AI 在干什么：拟章纲（读前文、拟纲、存纲）/ 写正文（写、补字数、去 AI 味）/ 核账（核、按核账改、换上）。 */
export function draftPhaseOfStep(step: string): "plan" | "write" | "check" | undefined {
  if (step === "notes" || step === "plan" || step === "plan-save") return "plan";
  if (step.startsWith("write:") || step === "extend" || step === "deai") return "write";
  if (step === "check" || step === "fix" || step === "recheck" || step === "apply") return "check";
  return undefined;
}
