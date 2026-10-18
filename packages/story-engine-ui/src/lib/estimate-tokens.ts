// UI 侧 token 估算——与服务端 `src/server/writing/context-gateway.ts` 的 `estimateTokens`
// 同算法（CJK 0.67/token、ASCII 0.25/token、其它 Unicode 0.35/token）。
//
// 为何复制而非 import 服务端那份：`scripts/check-import-boundary.mjs` 禁止 `src/server/` 以外的前端
// 文件 value-import 服务端模块（防服务端代码进前端 bundle）。token 估算是稳定不变的
// 纯函数，前端（滑动窗口截断、上下文百分比）需要它，故在前端复制这一小段逻辑。改服务端那份时同步此处。
export function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return 1;
  let count = 0;
  const codePoints = Array.from(text);
  for (const char of codePoints) {
    const cp = char.codePointAt(0)!;
    if (
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x20000 && cp <= 0x323af)
    ) {
      count += 0.67;
    } else if (cp <= 0x7f) {
      count += 0.25;
    } else {
      count += 0.35;
    }
  }
  return Math.max(1, Math.ceil(count));
}
