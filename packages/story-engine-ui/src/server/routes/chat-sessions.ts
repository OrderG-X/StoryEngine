/**
 * GET  /api/chat-sessions?list=1&project=…    — 读会话索引（自动迁移/建默认会话）
 * GET  /api/chat-sessions?session=…&project=… — 读单个会话
 * PUT  /api/chat-sessions { action, … }        — 9 个写动作
 */
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveGlobalDataDir } from "../lib/data-dirs.js";
import {
  readJsonBody,
  guardProjectPath,
  requireBodyString,
  assertStoryEngineProject,
  readWorkspaceMessages,
  writeJson,
  writeFileAtomic,
  isRecord,
  type MiddlewareStack,
} from "../lib/project-io.js";
import {
  readChatSessionIndex,
  loadChatSessionForDisplay,
  renameChatSession,
  saveChatSessionMessages,
  archiveOldMessages,
  unarchiveLast,
  createChatSessionTransaction,
  switchChatSessionTransaction,
  deleteChatSessionTransaction,
} from "../lib/chat-sessions-io.js";

const DEFAULT_CHAT_HISTORY_BUDGET = 96000;

function isErrnoNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT");
}

/**
 * 更新 model-settings.json 里的 chatHistoryBudgetTokens（R3）。
 * 仅 ENOENT 允许当新文件从 {} 起步；其它 IO / 坏 JSON / 非对象 → 抛错、绝不落盘，
 * 避免「读失败当空」写出只剩 budget、把 providers 冲光。写盘走原子写。
 */
export async function updateChatHistoryBudgetTokens(budget: number): Promise<number> {
  const settingsPath = join(resolveGlobalDataDir(), "model-settings.json");
  let settings: Record<string, unknown>;
  let text: string;
  try {
    text = await readFile(settingsPath, "utf-8");
  } catch (error) {
    if (isErrnoNotFound(error)) {
      settings = {};
      await mkdir(resolveGlobalDataDir(), { recursive: true });
      settings.chatHistoryBudgetTokens = budget;
      await writeFileAtomic(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
      return budget;
    }
    throw new Error(
      `读取模型设置失败（${settingsPath}）：${error instanceof Error ? error.message : String(error)}。` +
        `为避免覆盖现有模型配置，本次未保存。`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `模型设置不是有效 JSON（${settingsPath}）：${error instanceof Error ? error.message : String(error)}。` +
        `为避免覆盖现有模型配置，本次未保存。`,
    );
  }
  if (!isRecord(parsed)) {
    throw new Error(
      `模型设置格式异常（期望对象，实际为 ${Array.isArray(parsed) ? "数组" : typeof parsed}）（${settingsPath}）。` +
        `为避免覆盖现有模型配置，本次未保存。`,
    );
  }
  settings = parsed;
  settings.chatHistoryBudgetTokens = budget;
  await mkdir(resolveGlobalDataDir(), { recursive: true });
  await writeFileAtomic(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return budget;
}

async function loadChatHistoryBudget(): Promise<number> {
  try {
    const raw = await readFile(join(resolveGlobalDataDir(), "model-settings.json"), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const v = parsed.chatHistoryBudgetTokens;
    if (typeof v === "number" && v > 0) return v;
  } catch { /* 缺配置/解析失败 → 用默认值 */ }
  return DEFAULT_CHAT_HISTORY_BUDGET;
}

export function registerChatSessionsRoutes(middlewares: MiddlewareStack): void {
  middlewares.use(async (req, res, next) => {
    if (!req.url?.startsWith("/api/chat-sessions")) { next(); return; }
    try {
      if (req.method === "GET") {
        const url = new URL(req.url ?? "", "http://localhost");
        const projectDir = requireBodyString(url.searchParams.get("project"), "项目路径不能为空。");
        if (!guardProjectPath(res, projectDir)) return;
        await assertStoryEngineProject(projectDir);
        if (url.searchParams.get("list")) {
          writeJson(res, 200, {
            ok: true,
            index: await readChatSessionIndex(projectDir),
            chatHistoryBudgetTokens: await loadChatHistoryBudget(),
          });
          return;
        }
        const id = requireBodyString(url.searchParams.get("session"), "会话 id 不能为空。");
        // 打开会话 = 整备后下发：僵尸 running 步骤结算 + 冷热分层（热窗口外旧消息进冷归档，传输/DOM 有界）
        writeJson(res, 200, { ok: true, session: await loadChatSessionForDisplay(projectDir, id) });
        return;
      }

      if (req.method === "PUT") {
        const body = await readJsonBody(req);
        const projectDir = requireBodyString(body.projectPath, "项目路径不能为空。");
        if (!guardProjectPath(res, projectDir)) return;
        await assertStoryEngineProject(projectDir);
        const action = requireBodyString(body.action, "action 不能为空。");
        switch (action) {
          case "create": {
            const result = await createChatSessionTransaction(projectDir, typeof body.name === "string" ? body.name : undefined);
            writeJson(res, 200, {
              ok: true,
              ...result,
            });
            return;
          }
          case "rename":
            writeJson(res, 200, {
              ok: true,
              index: await renameChatSession(
                projectDir,
                requireBodyString(body.id, "id 不能为空。"),
                requireBodyString(body.name, "name 不能为空。"),
              ),
            });
            return;
          case "delete": {
            const result = await deleteChatSessionTransaction(projectDir, requireBodyString(body.id, "id 不能为空。"));
            writeJson(res, 200, { ok: true, ...result, activeSessionId: result.index.activeSessionId });
            return;
          }
          case "setActive": {
            const result = await switchChatSessionTransaction(projectDir, requireBodyString(body.id, "id 不能为空。"));
            writeJson(res, 200, {
              ok: true,
              ...result,
            });
            return;
          }
          case "save":
            await saveChatSessionMessages(
              projectDir,
              requireBodyString(body.id, "id 不能为空。"),
              readWorkspaceMessages(body.messages),
              typeof body.windowEpoch === "number" && Number.isFinite(body.windowEpoch) ? body.windowEpoch : undefined,
            );
            writeJson(res, 200, { ok: true });
            return;
          case "archive":
            writeJson(res, 200, {
              ok: true,
              ...(await archiveOldMessages(
                projectDir,
                requireBodyString(body.id, "id 不能为空。"),
                await loadChatHistoryBudget(),
              )),
            });
            return;
          case "unarchive":
            writeJson(res, 200, {
              ok: true,
              ...(await unarchiveLast(projectDir, requireBodyString(body.id, "id 不能为空。"))),
            });
            return;
          case "setBudget": {
            const budget = typeof body.budget === "number" && body.budget > 0 ? body.budget : null;
            if (!budget) { writeJson(res, 400, { ok: false, error: "budget 必须为正数。" }); return; }
            const saved = await updateChatHistoryBudgetTokens(budget);
            writeJson(res, 200, { ok: true, chatHistoryBudgetTokens: saved });
            return;
          }
          default:
            writeJson(res, 400, { ok: false, error: `未知 action: ${action}` });
            return;
        }
      }

      writeJson(res, 405, { ok: false, error: "Only GET and PUT are supported." });
    } catch (error) {
      writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
}
