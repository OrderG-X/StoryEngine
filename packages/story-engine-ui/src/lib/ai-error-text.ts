import type { AiErrorReason } from "../server/lib/ai-errors.js";

/** 出错卡的一句话（P11）：按服务端分的类说原因和该做什么；老消息、认不出的都回到原来那句。 */
const BODY: Record<Exclude<AiErrorReason, "unknown">, string> = {
  setup: "AI 还没设好（没接服务商、没填密钥或没选模型）。去设置里补上就能用；自己写不受影响。",
  auth: "服务商说密钥不对或没有权限。去设置里检查一下密钥。",
  quota: "服务商那边余额不足或额度用完了，充值后再试。",
  "rate-limit": "服务商暂时不让调用（请求太频繁，或额度不够）。等一会儿再试，还不行就看看账户余额。",
  server: "服务商那边出了故障，不是你的问题。稍后再试，或在设置里换个模型。",
  network: "连不上服务商，看看网络是否正常。",
  timeout: "服务商太久没有反应，可以再试一次。",
};

// 只说「没做完」，不打「没有改动」的包票：界面不知道服务端做到了哪一步（长篇连写走查 2026-10-24：出稿途中连接断了，
// 卡上写「本次没有改动」，一分钟后稿还是写进了盘）。做了一半的，稿纸出错后会重读盘上的样子。
const UNKNOWN_BODY = "AI 服务暂时没响应，这一步没做完。";

export function aiErrorBody(reason: AiErrorReason | undefined): string {
  return reason && reason !== "unknown" ? `${BODY[reason]}这一步没做完。` : UNKNOWN_BODY;
}

/** 这几类得去设置里改了才会好：错误卡给「去设置」。 */
export function aiErrorWantsSettings(reason: AiErrorReason | undefined): boolean {
  return reason === "setup" || reason === "auth";
}
