/**
 * 聊天文本判定的纯函数集合。
 *
 * 这些是 B5 拆除正则路由（commandParser / chatOrchestrator）后仍被
 * useChat 直接使用的少数 live 纯函数，从原 commandParser.ts 原样搬迁，
 * 正则与行为保持不变：
 * - isChapterAgentConfirm / isChapterAgentCancel：消费 pending 章节确认/取消。
 * - isClearDraftRequest：directEditWorkingDraft 判定「清空草稿」请求。
 */

export function isClearDraftRequest(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  if (/删除.*书|删.*项目|删除项目|删除书籍/u.test(text)) return false;
  if (/设定|资料|角色矩阵|资产库|地点库|正式状态/u.test(text)) return false;
  return /^(?:把|将|帮我|给我|直接)?\s*(?:这篇|当前|左侧|本章|这一章|这章)?\s*(?:文章|正文|草稿|章节|全文|全部内容)?\s*(?:删掉|删除|清空|全部删掉|全部删除|全删|清掉)\s*(?:吧|一下|掉|了)?[。！!？?\s]*$/u.test(text)
    || /(?:清空|删除|删掉|全删).{0,8}(?:文章|正文|草稿|章节|这一章|本章|全文|全部内容)|(?:文章|正文|草稿|章节|这一章|本章|全文|全部内容).{0,8}(?:清空|删除|删掉|全删)/u.test(text);
}

export function isChapterAgentConfirm(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  if (/^(?:确认|确定|可以|好|好的|行|没问题|就这样|按这个|开始|执行|来吧|继续|开始吧|可以开始)[。！!？?\s]*$/u.test(text)) return true;
  if (/^(?:生成本章方案|整理本章方案|生成草稿|生成工作稿|开始写|写吧|质检草稿|质检工作稿|生成入库预览|生成定稿预览|确认入库|确认定稿|继续下一章)[。！!？?\s]*$/u.test(text)) return true;
  return false;
}

export function isChapterAgentCancel(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  return /^(?:取消|算了|先不要|不要了|等等|先停|暂停|别执行|不写了|先不做|重新说)[。！!？?\s]*$/u.test(text);
}
