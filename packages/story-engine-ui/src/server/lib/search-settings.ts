/**
 * 联网搜索的服务和密钥（P11）：web_search 只走有正式接口的搜索服务。
 * 默认用 You.com 公开的免费档（不要密钥、每天 100 次）；想要更稳的自己填博查 / Tavily 的密钥。
 *
 * 存在全局数据目录的 search-settings.json（0600，和模型密钥一样只在本机）。
 * 界面只拿「用哪家、填没填」，密钥本身绝不回给界面、不进日志。
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveGlobalDataDir } from "./data-dirs.js";
import { isRecord, writeFileAtomic } from "./project-io.js";

export type SearchProviderId = "free" | "bocha" | "tavily";

export const SEARCH_PROVIDERS: readonly {
  readonly id: SearchProviderId;
  readonly label: string;
  readonly site: string;
  readonly needsKey: boolean;
}[] = [
  { id: "free", label: "免费", site: "https://you.com", needsKey: false },
  { id: "bocha", label: "博查", site: "https://open.bochaai.com", needsKey: true },
  { id: "tavily", label: "Tavily", site: "https://app.tavily.com", needsKey: true },
];

const FREE: SearchSettings = { provider: "free", apiKey: "" };

function needsKey(id: SearchProviderId): boolean {
  return SEARCH_PROVIDERS.find((provider) => provider.id === id)?.needsKey ?? true;
}

export function isSearchProviderId(value: unknown): value is SearchProviderId {
  return SEARCH_PROVIDERS.some((provider) => provider.id === value);
}

export function searchProviderLabel(id: SearchProviderId): string {
  return SEARCH_PROVIDERS.find((provider) => provider.id === id)?.label ?? id;
}

export interface SearchSettings {
  readonly provider: SearchProviderId;
  readonly apiKey: string;
}

/** 给界面的样子：用哪家、填没填密钥。 */
export interface SearchSettingsView {
  readonly provider: SearchProviderId | null;
  readonly hasKey: boolean;
}

function settingsPath(): string {
  return join(resolveGlobalDataDir(), "search-settings.json");
}

/**
 * 作者关过（`off`）才算没开；没有文件、坏文件、认不得的服务、要密钥的没填密钥，都用免费的。
 * 返回 null = 作者关了联网搜索。
 */
export async function readSearchSettings(): Promise<SearchSettings | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(settingsPath(), "utf-8"));
  } catch {
    return FREE;
  }
  if (isRecord(raw) && raw.off === true) return null;
  if (!isRecord(raw) || !isSearchProviderId(raw.provider) || !needsKey(raw.provider)) return FREE;
  const apiKey = typeof raw.apiKey === "string" ? raw.apiKey.trim() : "";
  return apiKey ? { provider: raw.provider, apiKey } : FREE;
}

export function searchSettingsView(settings: SearchSettings | null): SearchSettingsView {
  return settings ? { provider: settings.provider, hasKey: Boolean(settings.apiKey) } : { provider: null, hasKey: false };
}

async function writeSettings(body: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(settingsPath()), { recursive: true });
  await writeFileAtomic(settingsPath(), `${JSON.stringify({ version: 1, ...body }, null, 2)}\n`, { mode: 0o600 });
}

/** 存：免费的不要密钥（换成免费 = 删掉旧密钥）；密钥空着且还是同一家 = 沿用旧的；换了家或第一次就得填。 */
export async function saveSearchSettings(input: { readonly provider: SearchProviderId; readonly apiKey?: string }): Promise<SearchSettings> {
  if (!needsKey(input.provider)) {
    await writeSettings({ provider: input.provider });
    return FREE;
  }
  const typed = input.apiKey?.trim() ?? "";
  const current = await readSearchSettings();
  const apiKey = typed || (current?.provider === input.provider ? current.apiKey : "");
  if (!apiKey) throw new Error(`要填「${searchProviderLabel(input.provider)}」的密钥。`);
  const next: SearchSettings = { provider: input.provider, apiKey };
  await writeSettings({ ...next });
  return next;
}

/** 关掉联网搜索：连密钥一起删，记下「关了」（不记的话下次读到没文件就又是免费的开着）。 */
export async function clearSearchSettings(): Promise<void> {
  await writeSettings({ off: true });
}
