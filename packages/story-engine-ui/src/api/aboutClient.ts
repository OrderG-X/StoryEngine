/** 关于（P11）。形状与 server/routes/about.ts 一致（前端不引服务端）。 */

export interface AboutView {
  /** 桌面包的版本；开发时没有。 */
  readonly version: string | null;
  readonly hasNotices: boolean;
  readonly hasLogs: boolean;
}

export type AboutOpenTarget = "notices" | "logs" | "books";

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (error) {
    throw new Error(`连不上本机服务：${error instanceof Error ? error.message : String(error)}`);
  }
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string } & T;
  if (body.ok !== true) throw new Error(body.error?.trim() || `没成功（${res.status}）。`);
  return body;
}

export async function fetchAbout(): Promise<AboutView> {
  return call<AboutView>("/api/about");
}

export async function openAboutTarget(what: AboutOpenTarget): Promise<void> {
  await call("/api/about/open", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ what }) });
}
