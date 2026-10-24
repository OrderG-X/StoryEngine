/**
 * 把模型写成英文直引号的对话换成中文弯引号："我出。"他说 → “我出。”他说。
 * 写手偶尔整章用英文直引号（长篇连写 2026-10-24：30 章里第 13 章整章、第 16、18 章一半），书里两种引号混着，
 * 改稿时模型再按弯引号改一句，就叠成「许微说，"“昨天……”"」。每段里的直引号按出现顺序一开一合；
 * 一段只有一个的（跨段引语，下一段开头再开）当开引号。题材中立、纯确定性。
 * 前后端共用：出稿落盘、改稿落盘换一遍；流式出稿时稿纸上的显示也换一遍。
 */
export function curlyStraightQuotes(content: string): string {
  if (!content.includes("\"")) return content;
  return content.split("\n").map((line) => {
    let open = true;
    let out = "";
    for (const char of line) {
      if (char === "\"") {
        out += open ? "“" : "”";
        open = !open;
      } else {
        out += char;
      }
    }
    return out;
  }).join("\n");
}
