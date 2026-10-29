/**
 * 操作（写作版本 P2a）的 HTTP 口：开书 / 重连时找在做的、订阅一次操作、停掉。对话里交的操作随对话 SSE 走（agentChatClient），
 * 这里管对话那条流断了以后（关过页、重开书）接着看。
 */
import { readOperationView, type OperationViewData } from "./agentChatClient.js";

const BASE = "/api/operations";

async function readError(response: Response): Promise<string> {
  try {
    const payload = await response.json() as { error?: unknown };
    return typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

/** 这本书还没结束的操作（新的在前）。 */
export async function listActiveOperations(projectPath: string, signal?: AbortSignal): Promise<readonly OperationViewData[]> {
  const params = new URLSearchParams({ project: projectPath, active: "1" });
  const response = await fetch(`${BASE}?${params.toString()}`, signal ? { signal } : {});
  if (!response.ok) throw new Error(await readError(response));
  const payload = await response.json() as { ok?: boolean; operations?: unknown; error?: string };
  if (!payload.ok || !Array.isArray(payload.operations)) throw new Error(payload.error ?? "读不到在做的操作。");
  return payload.operations.flatMap((item) => {
    const view = readOperationView(item);
    return view ? [view] : [];
  });
}

/** 停掉一次操作。已经结束的停不了（cancelled = false），如实回它现在的样子。 */
export async function cancelOperationRequest(projectPath: string, opId: string): Promise<{ readonly cancelled: boolean; readonly operation?: OperationViewData }> {
  const response = await fetch(`${BASE}/${encodeURIComponent(opId)}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project: projectPath }),
  });
  if (!response.ok) throw new Error(await readError(response));
  const payload = await response.json() as { ok?: boolean; cancelled?: unknown; operation?: unknown; error?: string };
  if (!payload.ok) throw new Error(payload.error ?? "没停成。");
  const operation = readOperationView(payload.operation);
  return { cancelled: payload.cancelled === true, ...(operation ? { operation } : {}) };
}

/**
 * 订阅一次操作：先一份当前的，再跟着变，到结束为止（停着的一直挂着，等「接着做」）。连接断了、读不出就返回（调用方当没再变）。
 * 进度那一句给 onProgress。
 */
export async function followOperationEvents(
  projectPath: string,
  opId: string,
  handlers: { readonly onOperation: (operation: OperationViewData) => void; readonly onProgress?: (text: string) => void },
  signal: AbortSignal,
): Promise<void> {
  const params = new URLSearchParams({ project: projectPath });
  let response: Response;
  try {
    response = await fetch(`${BASE}/${encodeURIComponent(opId)}/events?${params.toString()}`, { signal });
  } catch {
    return;
  }
  if (!response.ok || !response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let dataLines: string[] = [];
  const flush = (): void => {
    const raw = dataLines.join("\n");
    const name = eventName;
    dataLines = [];
    eventName = "message";
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return;
    }
    if (name === "live") {
      const live = parsed as { readonly type?: unknown; readonly text?: unknown };
      if (live.type === "progress" && typeof live.text === "string") handlers.onProgress?.(live.text);
      return;
    }
    const view = readOperationView(parsed);
    if (view) handlers.onOperation(view);
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/u, "");
        buffer = buffer.slice(newline + 1);
        if (line === "") flush();
        else if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
        newline = buffer.indexOf("\n");
      }
    }
    flush();
  } catch {
    // 断了：调用方当没再变（下次开书再接）。
  }
}
