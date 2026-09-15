/**
 * sse-heartbeat —— SSE 长连接保活。
 *
 * 为什么需要：chapter-chat 的总控模型调用是非流式的（stream:false），出稿的流式调用在思考阶段
 * 也可能十几秒不吐字。这期间连接完全静默，浏览器/反向代理/CDN 会按「空闲超时」把连接掐掉
 * （nginx proxy_read_timeout 默认 60s，Chrome 也有自己的空闲上限），用户看到的是请求莫名挂掉、
 * 前端却以为还在跑。SSE 注释帧（`: ping\n\n`）是标准做法：不产生任何事件，只让链路保持活跃。
 *
 * 返回一个停止函数——写完响应或出错时必须调用，否则定时器会泄漏到进程关闭。
 */
export interface SseHeartbeat {
  readonly stop: () => void;
}

const DEFAULT_INTERVAL_MS = 15_000;

export function startSseHeartbeat(
  res: import("node:http").ServerResponse,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): SseHeartbeat {
  const timer = setInterval(() => {
    // 注释帧不携带事件名/数据，EventSource 不会触发任何监听器——纯保活
    if (res.writableEnded || res.destroyed) return;
    // 双保险：guard 通过后仍可能与 res.end() 撤写竞态（ERR_STREAM_WRITE_AFTER_END），
    // 客户端已不在，保活无意义，吞掉即可——绝不让心跳定时器把路由处理函数拖崩。
    try {
      res.write(": ping\n\n");
    } catch {
      // ignore
    }
  }, intervalMs);
  // 已失效的定时器不挂在事件循环上拖累关闭
  timer.unref?.();
  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
