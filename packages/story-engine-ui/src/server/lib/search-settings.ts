/**
 * 联网搜索的服务和密钥（P11）：web_search 只走有正式接口的搜索服务，作者自己填密钥。
 *
 * 存在全局数据目录的 search-settings.json（0600，和模型密钥一样只在本机）。
 * 界面只拿「用哪家、填没填」，密钥本身绝不回给界面、不进日志。
 */
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveGlobalDataDir } from "./data-dirs.js";
import { isRecord, writeFileAtomic } from "./project-io.js";

export type SearchProviderId = "bocha" | "tavily";

export const SEARCH_PROVIDERS: readonly { readonly id: SearchProviderId; readonly label: string; readonly site: string }[] = [
  { id: "bocha", label: "博查", site: "https://open.bochaai.com" },
  { id: "tavily", label: "Tavily", site: "https://app.tavily.com" },
];

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

/** 没有文件、坏文件、缺字段都当「没开」：搜索只是锦上添花，读不到就如实说没开。 */
export async function readSearchSettings(): Promise<SearchSettings | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(settingsPath(), "utf-8"));
  } catch {
    return null;
  }
  if (!isRecord(raw) || !isSearchProviderId(raw.provider)) return null;
  const apiKey = typeof raw.apiKey === "string" ? raw.apiKey.trim() : "";
  return apiKey ? { provider: raw.provider, apiKey } : null;
}

export function searchSettingsView(settings: SearchSettings | null): SearchSettingsView {
  return settings ? { provider: settings.provider, hasKey: true } : { provider: null, hasKey: false };
}

/** 存：密钥空着且还是同一家 = 只是没改密钥，沿用旧的；换了家或第一次就得填。 */
export async function saveSearchSettings(input: { readonly provider: SearchProviderId; readonly apiKey?: string }): Promise<SearchSettings> {
  const typed = input.apiKey?.trim() ?? "";
  const current = await readSearchSettings();
  const apiKey = typed || (current?.provider === input.provider ? current.apiKey : "");
  if (!apiKey) throw new Error(`要填「${searchProviderLabel(input.provider)}」的密钥。`);
  const next: SearchSettings = { provider: input.provider, apiKey };
  await mkdir(dirname(settingsPath()), { recursive: true });
  await writeFileAtomic(settingsPath(), `${JSON.stringify({ version: 1, ...next }, null, 2)}\n`, { mode: 0o600 });
  return next;
}

/** 关掉联网搜索：连密钥一起删。 */
export async function clearSearchSettings(): Promise<void> {
  await rm(settingsPath(), { force: true });
}
