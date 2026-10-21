/**
 * 书架上的书管理（P10）：回收站、导出、备份、书的资料、写作统计。
 * 读不到、做不成都如实给原因，不吞。
 */

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

// ---------------------------------------------------------------------------
// 回收站
// ---------------------------------------------------------------------------

export interface TrashItem {
  readonly id: string;
  readonly title: string;
  readonly originalPath: string;
  readonly deletedAt: string;
  readonly daysLeft: number;
}

export async function fetchTrash(): Promise<{ readonly items: readonly TrashItem[]; readonly keepDays: number }> {
  const body = await call<{ items?: TrashItem[]; keepDays?: number }>("/api/books/trash");
  return { items: body.items ?? [], keepDays: body.keepDays ?? 30 };
}

export async function restoreTrashItem(id: string): Promise<{ readonly projectPath: string; readonly title: string }> {
  const body = await call<{ projectPath: string; title: string }>("/api/books/trash/restore", postJson({ id }));
  return { projectPath: body.projectPath, title: body.title };
}

export async function purgeTrashItem(id: string): Promise<void> {
  await call("/api/books/trash/purge", postJson({ id, confirmPurge: true }));
}

// ---------------------------------------------------------------------------
// 下载（导出、备份共用）
// ---------------------------------------------------------------------------

/** 从附件头里取文件名（优先 UTF-8 的 filename*）。 */
export function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const encoded = /filename\*=UTF-8''([^;]+)/iu.exec(header)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded.trim()); } catch { /* 坏编码用兜底名 */ }
  }
  return /filename="([^"]+)"/iu.exec(header)?.[1] ?? fallback;
}

/** GET 一个附件：成功回文件内容和名字；失败（服务端回 JSON 错误）如实抛。 */
async function fetchAttachment(url: string, fallbackName: string): Promise<{ readonly blob: Blob; readonly filename: string; readonly headers: Headers }> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (error) {
    throw new Error(`连不上本机服务：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error?.trim() || `没成功（${res.status}）。`);
  }
  return { blob: await res.blob(), filename: filenameFromDisposition(res.headers.get("content-disposition"), fallbackName), headers: res.headers };
}

/** 存文件的结果：存好了 / 作者取消了 / 交给浏览器下载了（存没存、存哪了这边不知道）。 */
export type SaveOutcome = "saved" | "canceled" | "downloaded";

type SaveFilePicker = (options: { readonly suggestedName: string }) => Promise<{
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
}>;

/**
 * 把内容存成文件。能弹「存到哪」（桌面包、Chrome）就弹，存好、取消都如实回——
 * 真机试写：原先一律走下载链接，存文件框点了取消，界面照样说「导出了 10 章」。
 * 弹不出来（浏览器不支持、点了太久才弹）才退回下载链接，这时只能说交给浏览器了。
 */
export async function saveBlob(blob: Blob, filename: string): Promise<SaveOutcome> {
  const picker = (window as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  if (typeof picker === "function") {
    try {
      const handle = await picker.call(window, { suggestedName: filename });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return "saved";
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "AbortError") return "canceled";
      if (name !== "SecurityError" && name !== "NotAllowedError") {
        throw new Error(`文件没存成：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return "downloaded";
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

export type ExportFormat = "txt" | "docx" | "epub";

export interface ExportRequest {
  readonly projectPath: string;
  readonly format: ExportFormat;
  readonly from?: number;
  readonly to?: number;
  readonly includeDrafts?: boolean;
}

export async function exportBookFile(request: ExportRequest): Promise<{ readonly blob: Blob; readonly filename: string; readonly chapters: number }> {
  const params = new URLSearchParams({ project: request.projectPath, format: request.format });
  if (request.from !== undefined) params.set("from", String(request.from));
  if (request.to !== undefined) params.set("to", String(request.to));
  if (request.includeDrafts) params.set("drafts", "1");
  const { blob, filename, headers } = await fetchAttachment(`/api/books/export?${params.toString()}`, `导出.${request.format}`);
  return { blob, filename, chapters: Number(headers.get("x-export-chapters") ?? 0) };
}

// ---------------------------------------------------------------------------
// 备份
// ---------------------------------------------------------------------------

export async function downloadBookBackup(projectPath: string): Promise<{ readonly blob: Blob; readonly filename: string }> {
  const { blob, filename } = await fetchAttachment(`/api/books/backup?project=${encodeURIComponent(projectPath)}`, "备份.zip");
  return { blob, filename };
}

export async function restoreBookBackup(file: Blob): Promise<{ readonly projectPath: string; readonly title: string }> {
  const body = await call<{ projectPath: string; title: string }>("/api/books/restore", {
    method: "POST",
    headers: { "content-type": "application/zip" },
    body: file,
  });
  return { projectPath: body.projectPath, title: body.title };
}

export interface BackupSettingsView {
  readonly auto: boolean;
  readonly dir: string;
  readonly isDefaultDir: boolean;
  readonly defaultDir: string;
  readonly keep: number;
  readonly last?: { readonly at: string; readonly ok: boolean; readonly title: string; readonly error?: string };
}

export async function fetchBackupSettings(): Promise<BackupSettingsView> {
  return call<BackupSettingsView>("/api/backup-settings");
}

export async function saveBackupSettings(patch: { readonly auto?: boolean; readonly dir?: string }): Promise<BackupSettingsView> {
  return call<BackupSettingsView>("/api/backup-settings", postJson(patch));
}

export async function openBackupFolder(): Promise<void> {
  await call("/api/backup-settings/open-folder", postJson({}));
}

// ---------------------------------------------------------------------------
// 书的资料、归档、写作统计
// ---------------------------------------------------------------------------

export interface BookInfo {
  readonly author?: string;
  readonly synopsis?: string;
  readonly tags?: readonly string[];
  readonly targetWords?: number;
  readonly dailyGoal?: number;
  readonly coverTone?: number;
}

export interface WordStats {
  readonly totalWords: number;
  readonly today: { readonly net: number; readonly author: number; readonly ai: number };
  readonly streak: number;
  readonly recent: readonly { readonly date: string; readonly net: number }[];
}

export interface BookInfoView {
  readonly title: string;
  readonly info: BookInfo;
  readonly archived: boolean;
  readonly stats: WordStats;
}

export async function fetchBookInfo(projectPath: string): Promise<BookInfoView> {
  return call<BookInfoView>(`/api/books/info?project=${encodeURIComponent(projectPath)}`);
}

export async function saveBookInfo(projectPath: string, info: BookInfo): Promise<{ readonly title: string; readonly info: BookInfo; readonly archived: boolean }> {
  return call("/api/books/info", postJson({ projectPath, info }));
}

export async function setBookArchived(projectPath: string, archived: boolean): Promise<void> {
  await call("/api/books/archive", postJson({ projectPath, archived }));
}

export interface ShelfBookMeta {
  readonly archived: boolean;
  readonly coverTone?: number;
  readonly tags?: readonly string[];
  readonly author?: string;
}

export async function fetchShelfMeta(paths: readonly string[]): Promise<Readonly<Record<string, ShelfBookMeta>>> {
  if (paths.length === 0) return {};
  const body = await call<{ books?: Record<string, ShelfBookMeta> }>("/api/books/meta", postJson({ paths }));
  return body.books ?? {};
}

export async function fetchBookStats(projectPath: string): Promise<{ readonly stats: WordStats; readonly dailyGoal?: number; readonly targetWords?: number }> {
  return call(`/api/books/stats?project=${encodeURIComponent(projectPath)}`);
}
