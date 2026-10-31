/**
 * 正文指纹（FNV-1a 32 位，十六进制 8 位）：检查结果卡记下查的那份正文的指纹，稿纸拿眼前盘上那版的正文算一遍比，
 * 不一样才说「核过后改过稿」。版本号带代次（撤销定稿、整本恢复都换），字没变也会变，拿它比会误说改过稿。
 * 只用来提示「结论是不是这几个字的」，不当存稿的依据（存稿照旧认版本号）。服务端、前端同用这一份。
 */
export function bodyHash(body: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < body.length; index += 1) {
    hash ^= body.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** 结果卡记下的「查的是哪一份」。 */
export interface CheckedBody {
  readonly checkedVersion?: string | null;
  readonly checkedBodyHash?: string;
}

/** 查的那份不是盘上眼前这份：有指纹按正文比（字没变就是同一份）；P3b 之前的卡没有指纹，照旧按版本号比。不管眼前有没有没存的字。 */
export function checkedOtherBody(checked: CheckedBody, disk: { readonly baseVersion: string | null; readonly savedBody: string }): boolean {
  if (typeof checked.checkedBodyHash === "string") return bodyHash(disk.savedBody) !== checked.checkedBodyHash;
  return checked.checkedVersion !== disk.baseVersion;
}
