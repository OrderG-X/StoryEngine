const LOCAL_ABSOLUTE_PATH_PATTERN = /'?\/(?:Users|home|var|tmp|private)\/[^'"\s]*'?/gu;

/**
 * 用户可见文案的本地绝对路径消毒（铁律④·绝不泄露本地绝对路径）：errno 原文
 * （如 `EACCES: permission denied, open '/abs/path/chapters/0001.md'`）、git 子进程报错
 * （常带 -C 仓库路径）等诊断文本都内嵌绝对路径，进【给用户看的】summary/refusalReason/error
 * 前必须洗掉（含引号包裹形态）。本正则全仓唯一来源，不得再复制。
 */
export function scrubLocalAbsolutePaths(text: string): string {
  return text.replace(LOCAL_ABSOLUTE_PATH_PATTERN, "(本地路径)");
}
