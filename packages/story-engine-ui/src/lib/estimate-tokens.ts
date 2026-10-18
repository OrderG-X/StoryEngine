// token 估算（CJK 0.67/token、ASCII 0.25/token、其它 Unicode 0.35/token），前后端共用这一份：
// 前端用于滑动窗口截断、上下文百分比；服务端写作上下文（server/writing/context-gateway）和会话存盘也用它。
// 纯函数、不碰盘，放在前端 src/lib 是因为前端不许引服务端模块，反过来服务端引这里没问题。
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
