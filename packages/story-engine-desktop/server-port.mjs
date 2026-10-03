/**
 * 桌面 server 端口持久化：纯解析 + 原子写，无 electron 依赖（可 node -e 演练、node --test 直测）。
 *
 * why：localStorage 按 origin（host:port）隔离，端口漂移=书架/主题等前端持久化全清零；
 * 固定端口换取跨重启的 origin 稳定。仍仅回环 + request-guard 把关，可发现性提升可接受。
 */
import { rename, unlink, writeFile } from "node:fs/promises";

/**
 * 解析 server-port.json 原始内容，返回合法端口或 null。
 * 合法：1024–65535 的整数。
 */
export function readStoredPort(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    const port = parsed?.port;
    if (typeof port !== "number" || !Number.isInteger(port)) return null;
    if (port < 1024 || port > 65535) return null;
    return port;
  } catch {
    return null;
  }
}

/**
 * 原子写文本文件：先写同目录临时名，再 rename 就位（同一文件系统上 rename 原子；读方要么看到旧文件、要么看到完整新文件）。
 * P2（2026-10-02）：server-port.json 直接 writeFile 写到一半被杀/断电会留半截 JSON → 下次启动解析失败 → 回退随机端口
 * → origin 漂移 → 书架/主题等 localStorage 整体清零。失败时清掉临时文件、原错误照抛。
 */
export async function writeFileAtomically(targetPath, contents) {
  const temp = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temp, contents, "utf-8");
    await rename(temp, targetPath);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

/** 把端口以 readStoredPort 能读回的形态原子写入 targetPath。 */
export async function writeStoredPortAtomically(targetPath, port) {
  await writeFileAtomically(targetPath, `${JSON.stringify({ port })}\n`);
}
