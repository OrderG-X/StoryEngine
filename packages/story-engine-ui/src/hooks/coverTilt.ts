/**
 * 从光标在封面内的相对位置(px,py∈[0,1]，0=左/上)算 3D 跟手倾斜 transform。
 * 幅度克制(±10°)、中心无倾斜、含 perspective + 抬起(translateY) + 轻放大(scale)。
 * 朝光标方向倾斜：rotateY 随横向、rotateX 取负让封面"朝光标抬头"。
 */
const MAX_DEG = 10;

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** 幅度可调：书架用的是更收着的一档（maxDeg 5、抬 3px、放大 1.02）。 */
export function coverTiltTransform(
  px: number,
  py: number,
  opts: { readonly maxDeg?: number; readonly lift?: number; readonly scale?: number } = {},
): string {
  const maxDeg = opts.maxDeg ?? MAX_DEG;
  const x = clamp01(px) - 0.5; // [-0.5, 0.5]，右侧为正
  const y = clamp01(py) - 0.5; // [-0.5, 0.5]，下方为正
  const rotateY = (x * 2 * maxDeg).toFixed(2); // 光标在右 → 绕 Y 正转，朝光标
  const rotateX = (-(y * 2 * maxDeg)).toFixed(2); // 取负：光标在上 → 顶部抬头朝光标
  return `perspective(560px) rotateY(${rotateY}deg) rotateX(${rotateX}deg) translateY(-${opts.lift ?? 6}px) scale(${opts.scale ?? 1.04})`;
}
