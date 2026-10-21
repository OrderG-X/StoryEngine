/** 联网搜索设置（P11）。形状与 server/routes/search-settings.ts 一致（前端不引服务端）；密钥只上不下。 */

export type SearchProviderIdView = "bocha" | "tavily";

export interface SearchSettingsView {
  readonly provider: SearchProviderIdView | null;
  readonly hasKey: boolean;
  readonly providers: readonly { readonly id: SearchProviderIdView; readonly label: string; readonly site: string }[];
}

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

const postJson = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export async function fetchSearchSettings(): Promise<SearchSettingsView> {
  return call<SearchSettingsView>("/api/search-settings");
}

/** 存：同一家不填密钥 = 沿用旧的；provider 为 null = 关掉、删密钥。 */
export async function saveSearchSettings(input: { readonly provider: SearchProviderIdView | null; readonly apiKey?: string }): Promise<SearchSettingsView> {
  return call<SearchSettingsView>("/api/search-settings", postJson(input));
}

export async function testSearchSettings(): Promise<{ readonly works: boolean; readonly summary: string }> {
  return call<{ works: boolean; summary: string }>("/api/search-settings/test", postJson({}));
}
