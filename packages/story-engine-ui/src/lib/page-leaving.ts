/**
 * 页面正在关 / 刷新（pagehide 之后，写作版本 P2a）：这时掐断的对话流不是 AI 出错，别记成错误卡——交了的操作还在服务端做，
 * 重开书会接上。从往返缓存里回来（pageshow）就不算了。
 */
let leaving = false;

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    leaving = true;
  });
  window.addEventListener("pageshow", () => {
    leaving = false;
  });
}

export function pageLeaving(): boolean {
  return leaving;
}
