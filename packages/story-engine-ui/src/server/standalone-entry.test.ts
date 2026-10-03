// @vitest-environment node
//
// 阶段0 验证：那套后端能脱离 Vite、在独立 connect+http server 上跑起来。
// 起一个真实 server（端口 0 随机），打 /api 路由应拿到 JSON（路由中间件生效、没掉进静态兜底），
// 打任意非 /api 路径应拿到 dist 的 index.html（sirv SPA fallback 生效）。
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeStandaloneServer, createStandaloneServer, type StandaloneServerHandle } from "./standalone-entry.js";

const SENTINEL = "STANDALONE-DIST-OK";
let handle: StandaloneServerHandle;

beforeAll(async () => {
  const distDir = await mkdtemp(join(tmpdir(), "se-standalone-dist-"));
  await writeFile(join(distDir, "index.html"), `<!doctype html><title>${SENTINEL}</title>`, "utf-8");
  handle = await createStandaloneServer({ distDir, port: 0 });
});

afterAll(async () => {
  await handle?.close();
});

describe("createStandaloneServer（后端脱离 Vite 独立跑）", () => {
  it("分配到真实端口、url 指向本机", () => {
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.url).toBe(`http://127.0.0.1:${handle.port}/`);
  });

  it("/api 路由生效：返回 dev-api 统一的 JSON（不掉进静态兜底）", async () => {
    const res = await fetch(`${handle.url}api/state-overview?project=${encodeURIComponent("/no/such/project")}`);
    const text = await res.text();
    expect(text).not.toContain(SENTINEL); // 没被 SPA fallback 接走
    const parsed = JSON.parse(text); // 是 JSON（API 中间件确实跑了）
    expect(parsed).toHaveProperty("ok"); // dev-api 路由统一 { ok, ... } 形态
  });

  it("静态 + SPA fallback 生效：任意路径回退 dist/index.html", async () => {
    const res = await fetch(`${handle.url}some/spa/deep/route`);
    expect(await res.text()).toContain(SENTINEL);
  });
});

// P2（2026-10-02）桌面壳 Cmd+Q 不被在飞 SSE 挂死：close() 必须主动断开既有连接，而不是等它们自然结束。
describe("closeStandaloneServer（关闭时主动断开既有长连接）", () => {
  /** 起一个永不结束响应的 SSE server（模拟 agent 流式出稿），返回 server + 已建立的客户端流。 */
  async function openHangingSse(): Promise<{ server: ReturnType<typeof createServer>; response: Response; url: string }> {
    const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write("event: text-delta\ndata: {\"text\":\"……\"}\n\n");
      // 故意不 end：连接一直挂着
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const url = `http://127.0.0.1:${port}/api/agent/chat`;
    const response = await fetch(url);
    expect(response.ok).toBe(true);
    return { server, response, url };
  }

  it("graceMs=0：在飞 SSE 连接被立即掐断，close 在百毫秒级内 resolve（不再无限等）", async () => {
    const { server, response } = await openHangingSse();
    const started = Date.now();
    await closeStandaloneServer(server);
    expect(Date.now() - started).toBeLessThan(2_000);
    // 客户端这边流被断开（读到 end 或抛错，二者皆算断开）。
    await expect(response.body!.getReader().read().then(() => response.text()).catch(() => "")).resolves.toBeDefined();
  });

  it("graceMs>0：先停监听、给在飞连接宽限，宽限到期强制断开后才 resolve", async () => {
    const { server, url } = await openHangingSse();
    const started = Date.now();
    await closeStandaloneServer(server, { graceMs: 300 });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(3_000);
    // 已停监听：新连接被拒。
    await expect(fetch(url)).rejects.toThrow();
  });

  it("createStandaloneServer 的句柄 close() 走同一实现：挂着的空闲 keep-alive 连接不阻塞关闭", async () => {
    const distDir = await mkdtemp(join(tmpdir(), "se-standalone-dist-"));
    await writeFile(join(distDir, "index.html"), "<!doctype html><title>x</title>", "utf-8");
    const own = await createStandaloneServer({ distDir, port: 0 });
    await (await fetch(`${own.url}index.html`)).text(); // 建一条 keep-alive 连接后就闲置
    const started = Date.now();
    await own.close();
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
