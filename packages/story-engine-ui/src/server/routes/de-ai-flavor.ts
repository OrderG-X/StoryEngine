/**
 * POST /api/draft/de-ai-flavor/apply — AI 味「一键全修」：把卡片里挑出的多处 AI 腔一次批量改写、倒序落盘。
 *
 * 设计：复用纯核心 de-ai-flavor-batch（批量改写 + 多 span 倒序落盘 + 诚实回报），这里只接磁盘与快照。
 *   - 改写模型走 streamChatModelToText（流式 + 空闲超时，不传 max_tokens·超时铁律），repair profile。
 *   - 只在真有改动（rewritten>0 且内容变了）时建快照 + 写盘；否则不写、诚实回报「没改动」。
 *   - 不返回 overview：去 AI 味只改文风、不动故事状态/事实，无需刷新资料面板。
 *   - violations 由前端把卡片里那几条传来（含可定位 text），不在端点重复体检（用户改的就是卡里那几条）。
 */
import { readFile } from "node:fs/promises";
import {
  assertStoryEngineProject,
  defaultDraftPath,
  guardProjectPath,
  isRecord,
  readJsonBody,
  readString,
  requireBodyString,
  requirePositiveBodyInteger,
  writeJson,
  writeFileAtomic,
  type MiddlewareStack,
} from "../lib/project-io.js";
import { resolveConfiguredChatModel, streamChatModelToText } from "../lib/llm-client.js";
import { runWithSnapshot } from "../lib/snapshot.js";
import { readAntiRules } from "../agent/tools/check-ai-flavor.js";
import { runDeAiFlavorBatch } from "../agent/ai-flavor/de-ai-flavor-batch.js";
import type { AiFlavorViolation } from "../agent/ai-flavor/ai-flavor-check.js";

export function registerDeAiFlavorRoutes(middlewares: MiddlewareStack): void {
  middlewares.use(async (req, res, next) => {
    if (req.url?.startsWith("/api/draft/de-ai-flavor/apply")) {
      await handleDeAiFlavorApply(req, res);
      return;
    }
    next();
  });
}

/** 把前端传来的违规条目归一成 AiFlavorViolation（text 必填，其它给默认；模型无关：容忍缺字段）。 */
function readViolations(raw: unknown): AiFlavorViolation[] {
  if (!Array.isArray(raw)) return [];
  const out: AiFlavorViolation[] = [];
  raw.forEach((item, i) => {
    if (!isRecord(item)) return;
    const text = readString(item.text);
    if (!text) return;
    const sev = readString(item.severity);
    const suggestedFix = readString(item.suggestedFix);
    out.push({
      id: readString(item.id) ?? `v-${i}`,
      text,
      reason: readString(item.reason) ?? "AI 腔",
      severity: sev === "high" || sev === "medium" || sev === "low" ? sev : "medium",
      ...(suggestedFix ? { suggestedFix } : {}),
    });
  });
  return out;
}

async function handleDeAiFlavorApply(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
  try {
    if (req.method !== "POST") {
      writeJson(res, 405, { ok: false, error: "Only POST is supported." });
      return;
    }
    const body = await readJsonBody(req);
    const projectDir = requireBodyString(body.projectPath, "Project path is required.");
    if (!guardProjectPath(res, projectDir)) return;
    const chapter = requirePositiveBodyInteger(body.chapter, "Chapter is required.");
    if (body.confirm !== true) {
      writeJson(res, 400, { ok: false, error: "一键去 AI 味需要 confirm=true。" });
      return;
    }
    await assertStoryEngineProject(projectDir);

    const draftPath = defaultDraftPath(projectDir, chapter);
    // 全文内容（含可能的标题行）：违规句是正文整句、必为全文子串，倒序落盘后写回全文，标题不动。
    const rawDraft = readString(body.draftContent) ?? await readFile(draftPath, "utf-8").catch(() => "");
    const violations = readViolations(body.violations);
    const antiRules = await readAntiRules(projectDir);

    const configured = await resolveConfiguredChatModel("repair");
    const callModel = async (prompt: string): Promise<string> => {
      // 超时铁律：流式 + 空闲超时、不传 max_tokens。改写要 JSON。
      const { content } = await streamChatModelToText({
        configured,
        messages: [{ role: "user", content: prompt }],
        temperature: configured.profile.temperature ?? 0.4,
        responseFormat: { type: "json_object" },
      });
      if (!content) throw new Error("改写模型返回了空内容。");
      return content;
    };

    const result = await runDeAiFlavorBatch({ draftText: rawDraft, violations, callModel, antiRules });

    let snapshotId: string | undefined;
    let writtenContent = rawDraft;
    if (result.rewritten > 0 && result.updatedContent !== rawDraft) {
      // 审计 High-2：快照与落盘同一临界区（此前锁外裸写可被 commit_apply 交错读到半截稿）+ 原子写。
      writtenContent = `${result.updatedContent.trimEnd()}\n`;
      const { snapshot } = await runWithSnapshot(projectDir, "一键去 AI 味前快照", async () => {
        await writeFileAtomic(draftPath, writtenContent);
      });
      snapshotId = snapshot.id;
    }

    writeJson(res, 200, {
      ok: result.ok,
      result: {
        applied: result.rewritten > 0,
        chapter,
        detected: result.detected,
        rewritten: result.rewritten,
        skipped: result.skipped,
        changes: result.changes,
      },
      summary: result.summary,
      draftContent: writtenContent,
      ...(snapshotId ? { snapshotId } : {}),
    });
  } catch (error) {
    writeJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}
