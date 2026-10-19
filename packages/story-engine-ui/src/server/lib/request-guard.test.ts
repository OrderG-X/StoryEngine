import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateRequestSecurity,
  hostnameFromHostHeader,
  hostnameFromUrlHeader,
  isLoopbackHostname,
  isRemoteAccessAllowed,
  parseAllowedHosts,
  type RequestSecurityInput,
} from "./request-guard.js";

function req(overrides: Partial<RequestSecurityInput> = {}): RequestSecurityInput {
  return {
    method: "GET",
    url: "/api/state-overview",
    host: "127.0.0.1:5180",
    origin: undefined,
    referer: undefined,
    contentType: undefined,
    allowRemote: false,
    allowedHosts: [],
    ...overrides,
  };
}

describe("hostnameFromHostHeader", () => {
  it("strips port from IPv4 and hostname", () => {
    expect(hostnameFromHostHeader("127.0.0.1:5180")).toBe("127.0.0.1");
    expect(hostnameFromHostHeader("localhost:5173")).toBe("localhost");
    expect(hostnameFromHostHeader("evil.com")).toBe("evil.com");
  });
  it("keeps IPv6 bracket form and strips port", () => {
    expect(hostnameFromHostHeader("[::1]:5180")).toBe("[::1]");
    expect(hostnameFromHostHeader("[::1]")).toBe("[::1]");
  });
  it("returns undefined for empty", () => {
    expect(hostnameFromHostHeader(undefined)).toBeUndefined();
    expect(hostnameFromHostHeader("")).toBeUndefined();
  });
});

describe("hostnameFromUrlHeader", () => {
  it("parses origin/referer hostnames", () => {
    expect(hostnameFromUrlHeader("http://127.0.0.1:5180")).toBe("127.0.0.1");
    expect(hostnameFromUrlHeader("https://evil.com/x")).toBe("evil.com");
  });
  it("treats null and garbage as absent", () => {
    expect(hostnameFromUrlHeader("null")).toBeUndefined();
    expect(hostnameFromUrlHeader("not a url")).toBeUndefined();
    expect(hostnameFromUrlHeader(undefined)).toBeUndefined();
  });
});

describe("isLoopbackHostname", () => {
  it("accepts loopback forms only", () => {
    for (const h of ["127.0.0.1", "localhost", "::1", "[::1]", "LOCALHOST"]) {
      expect(isLoopbackHostname(h)).toBe(true);
    }
    for (const h of ["evil.com", "192.168.1.5", "0.0.0.0", "10.0.0.1"]) {
      expect(isLoopbackHostname(h)).toBe(false);
    }
  });
});

describe("evaluateRequestSecurity", () => {
  it("lets non-/api paths through untouched", () => {
    expect(evaluateRequestSecurity(req({ url: "/index.html", host: "evil.com" })).ok).toBe(true);
  });

  it("allows loopback GET", () => {
    expect(evaluateRequestSecurity(req()).ok).toBe(true);
    expect(evaluateRequestSecurity(req({ host: "localhost:5173" })).ok).toBe(true);
    expect(evaluateRequestSecurity(req({ host: "[::1]:5180" })).ok).toBe(true);
  });

  it("rejects non-loopback Host (DNS rebinding) by default", () => {
    const d = evaluateRequestSecurity(req({ host: "evil.com" }));
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.status).toBe(403);
  });

  it("rejects missing Host by default", () => {
    expect(evaluateRequestSecurity(req({ host: undefined })).ok).toBe(false);
  });

  it("skips Host allowlist when remote access is allowed", () => {
    expect(evaluateRequestSecurity(req({ host: "192.168.1.5:5180", allowRemote: true })).ok).toBe(true);
  });

  it("lets only the restore route take application/zip; same-origin check still applies", () => {
    expect(evaluateRequestSecurity(req({ method: "POST", url: "/api/books/restore", contentType: "application/zip" })).ok).toBe(true);
    const other = evaluateRequestSecurity(req({ method: "POST", url: "/api/books/delete", contentType: "application/zip" }));
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.status).toBe(415);
    const cross = evaluateRequestSecurity(req({ method: "POST", url: "/api/books/restore", contentType: "application/zip", origin: "https://evil.example" }));
    expect(cross.ok).toBe(false);
  });

  it("requires application/json for write methods", () => {
    const d = evaluateRequestSecurity(req({ method: "POST", contentType: "text/plain" }));
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.status).toBe(415);
    expect(evaluateRequestSecurity(req({ method: "POST", contentType: "application/json" })).ok).toBe(true);
    expect(
      evaluateRequestSecurity(req({ method: "POST", contentType: "application/json; charset=utf-8" })).ok,
    ).toBe(true);
  });

  it("allows same-origin write (Origin hostname matches Host)", () => {
    expect(
      evaluateRequestSecurity(
        req({ method: "PUT", contentType: "application/json", host: "127.0.0.1:5180", origin: "http://127.0.0.1:5180" }),
      ).ok,
    ).toBe(true);
  });

  it("rejects cross-origin write (CSRF)", () => {
    const d = evaluateRequestSecurity(
      req({ method: "POST", contentType: "application/json", host: "127.0.0.1:5180", origin: "https://evil.com" }),
    );
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.status).toBe(403);
  });

  it("allows write when Origin/Referer absent (non-browser client)", () => {
    expect(
      evaluateRequestSecurity(req({ method: "POST", contentType: "application/json", origin: undefined, referer: undefined })).ok,
    ).toBe(true);
  });

  it("falls back to Referer when Origin absent, and rejects cross-site referer", () => {
    const d = evaluateRequestSecurity(
      req({ method: "POST", contentType: "application/json", host: "127.0.0.1:5180", referer: "https://evil.com/page" }),
    );
    expect(d.ok).toBe(false);
  });

  it("accepts loopback Origin even when Host differs (remote host + local origin edge)", () => {
    expect(
      evaluateRequestSecurity(
        req({ method: "POST", contentType: "application/json", host: "192.168.1.5:5180", origin: "http://localhost:5180", allowRemote: true }),
      ).ok,
    ).toBe(true);
  });

  // —— R2：allowRemote 时仍做 Host 校验（回环 / IP 字面量 / SE_ALLOWED_HOSTS）——
  it("远程模式：攻击者域名 Host → 403（防 DNS rebinding）", () => {
    const d = evaluateRequestSecurity(req({ host: "evil.attacker.com", allowRemote: true }));
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.status).toBe(403);
      expect(d.error).toMatch(/SE_ALLOWED_HOSTS/);
    }
  });

  it("远程模式：IPv4 / IPv6 字面量 Host → 放行", () => {
    expect(evaluateRequestSecurity(req({ host: "10.0.0.8:5180", allowRemote: true })).ok).toBe(true);
    expect(evaluateRequestSecurity(req({ host: "[2001:db8::1]:5180", allowRemote: true })).ok).toBe(true);
  });

  it("远程模式：白名单域名（含带端口、大小写变体）→ 放行", () => {
    const allowed = ["story.local", "books.lan"];
    expect(
      evaluateRequestSecurity(req({ host: "story.local:5180", allowRemote: true, allowedHosts: allowed })).ok,
    ).toBe(true);
    expect(
      evaluateRequestSecurity(req({ host: "STORY.LOCAL", allowRemote: true, allowedHosts: allowed })).ok,
    ).toBe(true);
  });

  it("远程模式：白名单外域名 → 403", () => {
    const d = evaluateRequestSecurity(
      req({ host: "other.example", allowRemote: true, allowedHosts: ["story.local"] }),
    );
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.status).toBe(403);
  });
});

describe("parseAllowedHosts（SE_ALLOWED_HOSTS）", () => {
  it("空串 / 空项 / 大小写 / 带端口", () => {
    expect(parseAllowedHosts(undefined)).toEqual([]);
    expect(parseAllowedHosts("")).toEqual([]);
    expect(parseAllowedHosts("  , , ")).toEqual([]);
    expect(parseAllowedHosts("Story.Local, books.lan:8080, ,FOO.BAR")).toEqual([
      "story.local",
      "books.lan",
      "foo.bar",
    ]);
  });
});

describe("isRemoteAccessAllowed", () => {
  const original = process.env.SE_ALLOW_REMOTE;
  afterEach(() => {
    if (original === undefined) delete process.env.SE_ALLOW_REMOTE;
    else process.env.SE_ALLOW_REMOTE = original;
  });
  it("reads SE_ALLOW_REMOTE=1 at call time", () => {
    process.env.SE_ALLOW_REMOTE = "1";
    expect(isRemoteAccessAllowed()).toBe(true);
    process.env.SE_ALLOW_REMOTE = "0";
    expect(isRemoteAccessAllowed()).toBe(false);
    delete process.env.SE_ALLOW_REMOTE;
    expect(isRemoteAccessAllowed()).toBe(false);
  });
});
