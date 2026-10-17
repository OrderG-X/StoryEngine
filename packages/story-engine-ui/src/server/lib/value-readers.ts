/**
 * 读 JSON 里的值：类型对才收，不对就当没有（存盘白名单、请求体校验共用）。
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function readStringAllowEmpty(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function readStringList(value: unknown): string[] {
  const items = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\r?\n|[；;]/u)
      : [];
  return items
    .map((item) => readString(item))
    .filter((item): item is string => Boolean(item));
}

export function readPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const parsed = Math.trunc(value);
  return parsed > 0 ? parsed : undefined;
}

export function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}
