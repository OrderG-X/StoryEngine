/**
 * 操作历史里的条目名（存档点标签 → 作者看得懂的一行）。
 * 安静账房（2026-11-03）：「查看改动」（每个存档点之后落盘的文件翻成人话）随历史页的细节一起删了，只留条目名。
 */
import { humanizeUndoLabel } from "./snapshot.js";

const OP_NAMES: Readonly<Record<string, string>> = {
  "抽卡选用候选": "选用候选稿",
  "工作稿生成": "生成工作稿",
  "草稿生成": "生成工作稿",
  "自动去AI味": "自动去机器腔",
  "入库": "定稿",
  "修订应用": "应用修改",
  "一键去 AI 味": "一键去机器腔",
};

/**
 * 操作历史里的条目名：存档点标签写的是「X前快照」，而这一行代表的就是操作 X 本身（按钮是「恢复到这之前」），
 * 所以去掉「前快照」、章号放后面，和「定稿：第58章」同一个说法。只用于列表展示，撤销逻辑仍认原始标签。
 */
export function humanizeHistoryLabel(label: string): string {
  // 恢复到某个存档点 = 回到那一步操作之前。
  // 不猜白名单：自家格式
  const restore = /^恢复到：(.+)$/u.exec(label.trim());
  if (restore) return `恢复到「${humanizeHistoryLabel(restore[1]!)}」之前`;
  if (label.trim() === "初始快照") return "建书时的初始状态";
  const text = humanizeUndoLabel(label);
  const op = (name: string) => OP_NAMES[name.trim()] ?? name.trim();
  // 不猜白名单开始：自家格式
  const chapterFirst = /^第\s*(\d+)\s*章(.+?)前快照$/u.exec(text);
  if (chapterFirst) return `${op(chapterFirst[2]!)}：第${chapterFirst[1]}章`;
  const withDetail = /^(.+?)前快照[：:](.+)$/u.exec(text);
  if (withDetail) return `${op(withDetail[1]!)}：${withDetail[2]!.trim()}`;
  const plain = /^(.+?)前快照$/u.exec(text);
  // 不猜白名单结束
  if (plain) return op(plain[1]!);
  return text;
}
