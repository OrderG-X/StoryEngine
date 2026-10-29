/**
 * 操作的出口（写作版本 P2a 设计 6.7）：
 * - GET  /api/operations?project=<dir>[&active=1] —— 这本书的操作，新的在前；active=1 只要没结束的（开书 / 重连时找在跑的）。
 * - GET  /api/operations/<opId>/events?project=<dir> —— 订阅一次操作（SSE）：先 `snapshot`，再 `record` / `live`；结束了发完终态就关。
 * - POST /api/operations/<opId>/cancel {project} —— 停掉（先持久记 cancelled 再掐在途请求）。
 * 出去的都是 `operationView`（不带参数原文、请求哈希）。
 */
import { isOperationId, isTerminal, listOperations } from "../lib/operations/store.js";
import { scrubLocalAbsolutePaths } from "../lib/local-path-scrubber.js";
import { guardProjectPath, readJsonBody, writeJson, type MiddlewareStack } from "../lib/project-io.js";
import { startSseHeartbeat } from "../lib/sse-heartbeat.js";
import { cancelOperation, subscribeOperation, type OperationEvent } from "../services/operations/executor.js";
import { operationView } from "../services/operations/view.js";

const PATH = /^\/api\/operations(?:\/([^/]+)\/(events|cancel))?$/u;

export function registerOperationsRoutes(middlewares: MiddlewareStack): void {
  middlewares.use(async (req, res, next) => {
    if (!req.url?.startsWith("/api/operations")) {
      next();
      return;
    }
    const url = new URL(req.url, "http://localhost");
    const matched = PATH.exec(url.pathname);
    if (!matched) {
      next();
      return;
    }
    const [, opId, verb] = matched;
    try {
      if (opId !== undefined && !isOperationId(opId)) {
        writeJson(res, 404, { ok: false, error: "找不到这次操作。" });
        return;
      }

      if (verb === undefined) {
        if (req.method !== "GET") {
          writeJson(res, 405, { ok: false, error: "Only GET is supported." });
          return;
        }
        const projectDir = url.searchParams.get("project")?.trim() ?? "";
        if (!projectDir) {
          writeJson(res, 400, { ok: false, error: "Project path is required." });
          return;
        }
        if (!guardProjectPath(res, projectDir)) return;
        const activeOnly = url.searchParams.get("active") === "1";
        const operations = (await listOperations(projectDir))
          .filter((record) => !activeOnly || !isTerminal(record.state))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map(operationView);
        writeJson(res, 200, { ok: true, operations });
        return;
      }

      if (verb === "cancel") {
        if (req.method !== "POST") {
          writeJson(res, 405, { ok: false, error: "Only POST is supported." });
          return;
        }
        const body = await readJsonBody(req);
        const projectDir = typeof body.project === "string" ? body.project.trim() : "";
        if (!projectDir) {
          writeJson(res, 400, { ok: false, error: "Project path is required." });
          return;
        }
        if (!guardProjectPath(res, projectDir)) return;
        const outcome = await cancelOperation(projectDir, opId!);
        if (!outcome) {
          writeJson(res, 404, { ok: false, error: "找不到这次操作了。" });
          return;
        }
        // 已经结束的停不了：如实回它现在的样子（cancelled = false）。
        writeJson(res, 200, { ok: true, cancelled: outcome.cancelled, operation: operationView(outcome.record) });
        return;
      }

      // events
      if (req.method !== "GET") {
        writeJson(res, 405, { ok: false, error: "Only GET is supported." });
        return;
      }
      const projectDir = url.searchParams.get("project")?.trim() ?? "";
      if (!projectDir) {
        writeJson(res, 400, { ok: false, error: "Project path is required." });
        return;
      }
      if (!guardProjectPath(res, projectDir)) return;

      let open = true;
      let stopHeartbeat: (() => void) | undefined;
      let unsubscribe: (() => void) | undefined;
      const close = (): void => {
        if (!open) return;
        open = false;
        stopHeartbeat?.();
        unsubscribe?.();
        if (!res.writableEnded) res.end();
      };
      const send = (event: OperationEvent): void => {
        if (!open || res.writableEnded || res.destroyed) return;
        if (!res.headersSent) {
          res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive" });
          stopHeartbeat = startSseHeartbeat(res).stop;
        }
        const data = event.type === "live" ? event.event : operationView(event.record);
        res.write(`event: ${event.type}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
        if (event.type !== "live" && isTerminal(event.record.state)) close();
      };
      res.on("close", close);
      const off = await subscribeOperation(projectDir, opId!, send);
      if (!off) {
        if (!res.headersSent) writeJson(res, 404, { ok: false, error: "找不到这次操作了。" });
        close();
        return;
      }
      // 快照已经是终态的话 send 里已关；还开着就挂上退订。
      if (open) unsubscribe = off;
      else off();
    } catch (error) {
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return;
      }
      writeJson(res, 500, { ok: false, error: scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error)) });
    }
  });
}
