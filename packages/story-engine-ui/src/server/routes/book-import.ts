/**
 * 导入已写的书（P8，设计见 docs/rebuild/P8-serial-import-design.md）：
 *
 * POST /api/books/import-preview  { files: [{ name, text }] }
 *      → 切章预览（不写盘）：{ ok, parts: [{ kind, title, chars, file }], totalChars, emptyDropped, volumeLines, suggestedTitle }
 * POST /api/books/import          { title, files, include?: boolean[] }
 *      → 建书 → 「导入已写的书」命令（每章正文 + 空账单）→ 镜像 → 开一轮通读记账（后台）
 *      → { ok, projectDir, project, overview, imported: { chapters } }
 *      include 和预览的 parts 一一对应（缺省：章节都导、第一章前面的字不导）；对不上就是文件变了，要重新预览。
 * POST /api/books/reread          { projectPath } → 通读停下后「接着记」：{ ok, status }
 *
 * 切章两次都在服务端做（同一个纯函数、同样的输入），预览和导入切出来的一定一样。
 */
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { bookImportText, runCommand, serialFileStem, splitSerialText, type SerialFile, type SerialSplit } from "@actalk/story-core";
import { buildStateOverview } from "../book/state-overview.js";
import { ensureBookOnCore } from "../book/mirror/ensure.js";
import { createStoryProject } from "../book/project-store.js";
import { resolveBooksRootDir } from "../lib/data-dirs.js";
import { scrubLocalAbsolutePaths } from "../lib/local-path-scrubber.js";
import { assertStoryEngineProject, guardProjectPath, isRecord, isSafeProjectPath, readJsonBody, readString, requireBodyString, writeJson, type MiddlewareStack } from "../lib/project-io.js";
import { coreSnapshotFor } from "../lib/snapshot.js";
import { readRereadState, runBookReread, startBookReread } from "../editorial/index.js";
import { withUiOverviewDetails } from "../services/ui-overview.js";

type Req = import("node:http").IncomingMessage;
type Res = import("node:http").ServerResponse;

export function registerBookImportRoutes(middlewares: MiddlewareStack): void {
  middlewares.use(async (req, res, next) => {
    const path = req.url?.split("?")[0];
    if (path === "/api/books/import-preview") return handle(req, res, handlePreview);
    if (path === "/api/books/import") return handle(req, res, handleImport);
    if (path === "/api/books/reread") return handle(req, res, handleResume);
    next();
  });
}

async function handle(req: Req, res: Res, run: (body: Record<string, unknown>, res: Res) => Promise<void>): Promise<void> {
  try {
    if (req.method !== "POST") {
      writeJson(res, 405, { ok: false, error: "Only POST is supported." });
      return;
    }
    await run(await readJsonBody(req), res);
  } catch (error) {
    writeJson(res, 500, { ok: false, error: scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error)) });
  }
}

/** 请求里的文件：名字和全文都得是字符串，空文件不收。 */
function readFiles(body: Record<string, unknown>): SerialFile[] | string {
  const raw = Array.isArray(body.files) ? body.files : [];
  const files: SerialFile[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.name !== "string" || typeof item.text !== "string") return "文件格式不对";
    files.push({ name: item.name, text: item.text });
  }
  if (files.length === 0) return "没有选文件";
  if (files.every((file) => file.text.trim().length === 0)) return "选的文件是空的";
  return files;
}

function previewOf(split: SerialSplit, files: readonly SerialFile[]) {
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true }));
  return {
    parts: split.parts.map((part) => ({ kind: part.kind, title: part.title, chars: part.chars, file: part.file })),
    totalChars: split.parts.reduce((sum, part) => sum + (part.kind === "chapter" ? part.chars : 0), 0),
    emptyDropped: split.emptyDropped,
    volumeLines: split.volumeLines,
    suggestedTitle: sorted.length === 1 ? serialFileStem(sorted[0]!.name) : "",
  };
}

async function handlePreview(body: Record<string, unknown>, res: Res): Promise<void> {
  const files = readFiles(body);
  if (typeof files === "string") {
    writeJson(res, 400, { ok: false, error: files });
    return;
  }
  const split = splitSerialText(files);
  writeJson(res, 200, { ok: true, ...previewOf(split, files) });
}

async function handleImport(body: Record<string, unknown>, res: Res): Promise<void> {
  const files = readFiles(body);
  if (typeof files === "string") {
    writeJson(res, 400, { ok: false, error: files });
    return;
  }
  const split = splitSerialText(files);
  const include = Array.isArray(body.include) ? body.include : undefined;
  if (include && (include.length !== split.parts.length || include.some((value) => typeof value !== "boolean"))) {
    writeJson(res, 400, { ok: false, error: "文件和预览时的对不上了，重新选一次文件再导入。" });
    return;
  }
  const chosen = split.parts.filter((part, index) => (include ? include[index] === true : part.kind === "chapter"));
  if (chosen.length === 0) {
    writeJson(res, 400, { ok: false, error: "一章都没选，没有可导入的。" });
    return;
  }
  // 书名缺省：只有一个文件就用文件名（和预览给的建议一样），几个文件拼的不替作者起名。
  const title = (readString(body.title) ?? "").trim() || (files.length === 1 ? serialFileStem(files[0]!.name) : "") || "未命名故事";
  if (title.length > 80) {
    writeJson(res, 400, { ok: false, error: "书名不能超过 80 个字符。" });
    return;
  }
  const rootDir = readString(body.rootDir) ?? resolveBooksRootDir();
  if (!isSafeProjectPath(rootDir) && resolve(rootDir) !== resolve(resolveBooksRootDir())) {
    writeJson(res, 400, { ok: false, error: "不安全的项目路径" });
    return;
  }

  const created = await createStoryProject({ rootDir, title });
  const projectDir = created.projectDir;
  try {
    const outcome = await runCommand(projectDir, bookImportText, {
      chapters: chosen.map((part) => ({ title: part.kind === "preamble" ? "" : part.title, body: part.body })),
    }, { caller: "author", idempotencyKey: "book-import-text", snapshot: coreSnapshotFor(projectDir) });
    if (!outcome.ok) throw new Error(outcome.message);
    const onCore = await ensureBookOnCore(projectDir, { snapshot: coreSnapshotFor(projectDir) });
    if (!onCore.ok) throw new Error(`这本书没接上新核心：${onCore.reason}`);
    await startBookReread(projectDir, outcome.result.chapters);
  } catch (error) {
    // 导到一半不留半本书：整本删掉，如实报错。
    await rm(projectDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  const overview = await withUiOverviewDetails(projectDir, await buildStateOverview({ projectDir, maxTimelineEvents: 8 }));
  writeJson(res, 200, { ok: true, projectDir, project: created.project, overview, imported: { chapters: chosen.length } });
}

async function handleResume(body: Record<string, unknown>, res: Res): Promise<void> {
  const projectDir = requireBodyString(body.projectPath, "项目路径不能为空。");
  if (!guardProjectPath(res, projectDir)) return;
  await assertStoryEngineProject(projectDir);
  const state = await readRereadState(projectDir);
  if (!state) {
    writeJson(res, 400, { ok: false, error: "这本书没有在通读记账。" });
    return;
  }
  if (state.status !== "done") void runBookReread(projectDir);
  writeJson(res, 200, { ok: true, status: state.status === "done" ? "done" : "running" });
}
