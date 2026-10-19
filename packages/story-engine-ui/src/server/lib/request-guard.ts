/**
 * 本机请求安全闸（审查 #2；R2 远程 Host 白名单）。
 *
 * 这套 /api 后端没有鉴权、跑在 localhost（桌面随机端口 / 开发 5173），既能调模型烧额度、又能读写书稿、
 * 恢复快照。仅靠「随机端口」只能降低被发现概率，挡不住浏览器侧的两类真实攻击：
 *   - DNS rebinding：恶意站点把自己的域名重绑到 127.0.0.1:PORT 再 fetch —— 靠 **Host 白名单** 拦
 *     （重绑后 Host 头仍是恶意域名，非回环）。
 *   - CSRF：恶意页面 fetch/form 提交到 http://127.0.0.1:PORT/api/... —— 靠 **Origin 同源校验** +
 *     **写路由强制 application/json** 拦（跨源 fetch 会带 Origin；HTML form 只能发非 JSON Content-Type）。
 *
 * 默认只认回环 Host。确需暴露到局域网时用 SE_ALLOW_REMOTE=1：仍校验 Host，按序放行回环 / IP 字面量
 * （DNS rebinding 必须借域名，浏览器对 IP 不走 DNS）/ SE_ALLOWED_HOSTS 显式域名；其余 403。
 * standalone-entry 同口径把关监听地址。
 * 注意：本机其它进程可伪造任意头，闸挡不住「本地恶意进程」——那类攻击者本就能直接读 ~/.story-engine，
 * 超出本闸威胁模型；本闸治的是「浏览器被当跳板」这一类可远程触发的攻击。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { writeJson, type Middleware } from "./project-io.js";

const WRITE_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

export interface RequestSecurityInput {
  readonly method: string;
  readonly url: string;
  readonly host: string | undefined;
  readonly origin: string | undefined;
  readonly referer: string | undefined;
  readonly contentType: string | undefined;
  /** SE_ALLOW_REMOTE=1：允许非回环暴露；Host 仍按回环 / IP 字面量 / allowedHosts 校验（R2）。 */
  readonly allowRemote: boolean;
  /** SE_ALLOWED_HOSTS 解析后的主机名（小写、无端口）；仅 allowRemote 时参与 Host 放行。 */
  readonly allowedHosts: readonly string[];
}

export type RequestSecurityDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number; readonly error: string };

/** 回环主机名（忽略端口）。IPv6 同时认 "::1" 与 "[::1]" 两种书写。 */
export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
}

/** Host 是否为 IP 字面量（IPv4 / IPv6；方括号形式先去括号再判）。DNS rebinding 必须借域名。 */
export function isIpLiteralHostname(hostname: string): boolean {
  const h = hostname.trim();
  const bare = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
  return isIP(bare) !== 0;
}

/** 解析 SE_ALLOWED_HOSTS：逗号分隔、去空白空项、去端口、小写。 */
export function parseAllowedHosts(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const host = hostnameFromHostHeader(trimmed) ?? trimmed;
    const normalized = host.trim().toLowerCase();
    if (normalized) out.push(normalized);
  }
  return out;
}

/** 从 Host 头抽主机名（去端口）：`127.0.0.1:5180`→`127.0.0.1`、`[::1]:80`→`[::1]`。 */
export function hostnameFromHostHeader(host: string | undefined): string | undefined {
  if (!host) return undefined;
  const trimmed = host.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end >= 0 ? trimmed.slice(0, end + 1) : trimmed;
  }
  const colon = trimmed.lastIndexOf(":");
  return colon >= 0 ? trimmed.slice(0, colon) : trimmed;
}

/** 从 Origin / Referer 头抽主机名；解析失败或为 "null"（sandbox iframe 等）返回 undefined。 */
export function hostnameFromUrlHeader(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null") return undefined;
  try {
    return new URL(trimmed).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  return contentType.trim().toLowerCase().startsWith("application/json");
}

/**
 * 只收压缩包的写路由（P10 从备份恢复）。application/zip 不是浏览器「简单类型」：跨源发要先预检，
 * 本服务不回 CORS 头，预检过不去，所以和 JSON 一样挡得住表单 / 跨站请求；同源校验照做。
 */
export const ZIP_UPLOAD_PATHS: readonly string[] = ["/api/books/restore"];

function isZipUpload(url: string, contentType: string | undefined): boolean {
  if (!ZIP_UPLOAD_PATHS.includes(url.split("?")[0] ?? "")) return false;
  return Boolean(contentType?.trim().toLowerCase().startsWith("application/zip"));
}

function hostAllowedWhenRemote(
  hostname: string | undefined,
  allowedHosts: readonly string[],
): boolean {
  if (!hostname) return false;
  if (isLoopbackHostname(hostname)) return true;
  if (isIpLiteralHostname(hostname)) return true;
  const key = hostname.toLowerCase();
  // 白名单存的是去端口小写主机名；IPv6 方括号形式也按字面比
  const bare = key.startsWith("[") && key.endsWith("]") ? key.slice(1, -1) : key;
  return allowedHosts.some((h) => h === key || h === bare);
}

/**
 * 纯函数版安全判定（便于单测穷举）。策略：
 * - 非 /api 路径放行（静态资源由 sirv 兜底，风险低）。
 * - Host 白名单：默认仅回环；allowRemote 时放行回环 / IP 字面量 / allowedHosts（R2），其余 403。
 * - 写方法（POST/PUT/DELETE/PATCH）：强制 application/json；再做 Origin/Referer 同源校验
 *   （Origin 缺失=非浏览器客户端/同源导航，放行——Host 已把关；Origin 存在则其主机名必须与 Host 同名或为回环）。
 */
export function evaluateRequestSecurity(input: RequestSecurityInput): RequestSecurityDecision {
  if (!input.url.startsWith("/api")) return { ok: true };

  const hostname = hostnameFromHostHeader(input.host);
  if (!input.allowRemote) {
    if (!hostname || !isLoopbackHostname(hostname)) {
      return { ok: false, status: 403, error: "请求被拒绝：仅允许来自本机（127.0.0.1）的访问。" };
    }
  } else if (!hostAllowedWhenRemote(hostname, input.allowedHosts)) {
    return {
      ok: false,
      status: 403,
      error:
        "请求被拒绝：远程模式下 Host 须为回环、IP 字面量，或列入 SE_ALLOWED_HOSTS（防 DNS rebinding）。",
    };
  }

  const method = input.method.toUpperCase();
  if (WRITE_METHODS.has(method)) {
    if (!isJsonContentType(input.contentType) && !isZipUpload(input.url, input.contentType)) {
      return { ok: false, status: 415, error: "写操作要求 Content-Type 为 application/json。" };
    }
    const originHost = hostnameFromUrlHeader(input.origin) ?? hostnameFromUrlHeader(input.referer);
    if (originHost !== undefined) {
      const sameAsHost = hostname !== undefined && originHost === hostname.toLowerCase();
      if (!sameAsHost && !isLoopbackHostname(originHost)) {
        return { ok: false, status: 403, error: "跨源写请求被拒绝（Origin 校验未通过）。" };
      }
    }
  }

  return { ok: true };
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/** SE_ALLOW_REMOTE=1（现读 env，测试可注入）→ 允许非回环暴露。 */
export function isRemoteAccessAllowed(): boolean {
  return process.env.SE_ALLOW_REMOTE?.trim() === "1";
}

/**
 * 安全闸中间件：挂在所有 /api 路由之前（registerStateOverviewApi 首位）。
 * 命中拒绝就 writeJson(403/415) 结束；否则 next() 交给业务路由。
 */
export function createSecurityGate(): Middleware {
  return (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void): void => {
    const decision = evaluateRequestSecurity({
      method: req.method ?? "GET",
      url: req.url ?? "",
      host: firstHeader(req.headers.host),
      origin: firstHeader(req.headers.origin),
      referer: firstHeader(req.headers.referer),
      contentType: firstHeader(req.headers["content-type"]),
      allowRemote: isRemoteAccessAllowed(),
      allowedHosts: parseAllowedHosts(process.env.SE_ALLOWED_HOSTS),
    });
    if (!decision.ok) {
      writeJson(res, decision.status, { ok: false, error: decision.error });
      return;
    }
    next();
  };
}
