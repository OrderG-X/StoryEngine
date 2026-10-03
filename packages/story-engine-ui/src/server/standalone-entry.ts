/**
 * 独立生产 server 入口（桌面打包阶段0）。
 *
 * 把现在只活在 Vite 开发中间件里的那套后端（registerStateOverviewApi 的 ~21 个 /api 路由
 * + Mastra 聊天大脑 + 本地读写）搬到一个能 `node server.mjs` 独立启动的进程里：
 *   connect() 实例 → registerStateOverviewApi 原样挂全部路由 → sirv 服务构建好的静态前端 dist/
 *   （single:true = SPA fallback）→ http.createServer 监听本地端口。
 *
 * 业务路由零改动；唯一前提是 dev-api 的签名已从 vite 的 Connect.Server 换成本地 MiddlewareStack。
 * 这个入口同时给阶段1 的 Electron 主进程复用（主进程 import createStandaloneServer 起服务、窗口连 localhost）。
 */
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import connect from "connect";
import sirv from "sirv";
import { registerStateOverviewApi } from "./dev-api.js";
import { isLoopbackHostname, isRemoteAccessAllowed } from "./lib/request-guard.js";

export interface StandaloneServerOptions {
  /** 构建好的前端静态目录（vite build 的 dist/）。 */
  readonly distDir: string;
  /** 监听主机，默认仅本机 127.0.0.1（桌面 App 不对外暴露）。 */
  readonly host?: string;
  /** 监听端口；0 = 让系统分配空闲端口（Electron 用随机端口避冲突）。默认 0。 */
  readonly port?: number;
}

export interface StandaloneServerCloseOptions {
  /**
   * 给「仍在处理中」的连接多少毫秒排空（如 pagehide keepalive 保存刚抵达、server 还在写盘）；超时后强制断开。
   * 默认 0 = 立即断开全部连接。空闲 keep-alive 连接任何情况下都立即关掉。
   */
  readonly graceMs?: number;
}

export interface StandaloneServerHandle {
  readonly server: Server;
  readonly host: string;
  readonly port: number;
  readonly url: string;
  /**
   * 关闭 server：停止接受新连接 + **主动断开既有连接**后 resolve。
   *
   * why（P2·2026-10-02）：`http.Server#close()` 只停监听，要等所有既有连接自然结束才回调；agent 聊天是长连接 SSE
   * （思考 + 多轮工具调用可持续数分钟），桌面壳 Cmd+Q 时若正在流式出稿，`before-quit` 等 close() 会一直挂着不退。
   * 现在：close() → closeIdleConnections() 立即收掉空闲 keep-alive → （graceMs 后）closeAllConnections() 掐掉在飞的
   * SSE/请求 → close 回调才能到达。被掐断的 SSE 只是断流，不是数据损坏：写盘路径都在 server 端持锁、有快照。
   */
  close(options?: StandaloneServerCloseOptions): Promise<void>;
}

/** 内部：把 Node ≥18.2 才有的连接收割 API 做成可选调用（旧运行时无此方法时退化为只停监听）。 */
function teardownConnections(server: Server, mode: "idle" | "all"): void {
  const target = server as Server & {
    closeIdleConnections?: () => void;
    closeAllConnections?: () => void;
  };
  if (mode === "idle") target.closeIdleConnections?.();
  else target.closeAllConnections?.();
}

/** 可单测的 close 实现：listen 中的 server → 停监听 + 收割连接，既有 SSE 长连接在 graceMs 后被强制断开。 */
export function closeStandaloneServer(server: Server, options: StandaloneServerCloseOptions = {}): Promise<void> {
  const graceMs = Math.max(0, Number.isFinite(options.graceMs) ? Number(options.graceMs) : 0);
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    server.close((error) => {
      if (timer !== undefined) clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    });
    teardownConnections(server, "idle");
    if (graceMs === 0) {
      teardownConnections(server, "all");
    } else {
      timer = setTimeout(() => teardownConnections(server, "all"), graceMs);
    }
  });
}

/** 起一个独立 server：挂全部 /api 路由 + 服务静态前端（SPA fallback）。返回句柄含真实 url/port。 */
export async function createStandaloneServer(options: StandaloneServerOptions): Promise<StandaloneServerHandle> {
  const host = options.host ?? "127.0.0.1";
  // 默认拒绝非回环监听（审查 #2）：这套 API 无鉴权，绑到 0.0.0.0/局域网 IP 等于把读写书稿/调模型的口子
  // 暴露给同网段任何人。确需内网访问时用 SE_ALLOW_REMOTE=1 显式解禁（安全闸仍校验 Host：回环 /
  // IP 字面量 / SE_ALLOWED_HOSTS，防 DNS rebinding）。
  if (!isLoopbackHostname(host) && !isRemoteAccessAllowed()) {
    throw new Error(
      `拒绝在非回环地址启动（host=${host}）：该本地 API 无鉴权，不应对局域网暴露。` +
        `如确需内网访问，请设置环境变量 SE_ALLOW_REMOTE=1 后重试` +
        `（可用 SE_ALLOWED_HOSTS 放行域名反代）。`,
    );
  }
  const app = connect();
  // 先挂业务路由（各路由只认自己的 /api/... 前缀、其余 next()）。
  registerStateOverviewApi(app);
  // 再用 sirv 兜底：服务构建好的前端静态资源；single=true → 任意未命中路径回退 index.html（SPA 路由）。
  app.use(sirv(options.distDir, { single: true, dev: false }));

  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (options.port ?? 0);
  return {
    server,
    host,
    port,
    url: `http://${host}:${port}/`,
    close: (closeOptions) => closeStandaloneServer(server, closeOptions),
  };
}

/** CLI：node dist-server/server.mjs。dist 目录取 SE_DIST_DIR，缺省= 包内 dist/（相对本文件 ../dist）。 */
async function runCli(): Promise<void> {
  const distDir = process.env.SE_DIST_DIR ?? fileURLToPath(new URL("../dist/", import.meta.url));
  const port = Number(process.env.SE_PORT) || 5180;
  const host = process.env.SE_HOST ?? "127.0.0.1";
  const handle = await createStandaloneServer({ distDir, port, host });
  // eslint-disable-next-line no-console
  console.log(`[story-engine] 独立 server 已启动：${handle.url}（静态目录：${distDir}）`);
}

// 仅当被 node 直接运行时启动（被 import 复用时不自动起）。
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runCli().catch((error) => {
    // eslint-disable-next-line no-console
    console.error("[story-engine] 独立 server 启动失败：", error);
    process.exitCode = 1;
  });
}
