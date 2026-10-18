/**
 * 作者导进来的 txt / md 文件解码（P8 导入已写的书）：先认 BOM（UTF-8 / UTF-16），没有 BOM 就按 UTF-8 严格解，
 * 解不通（多半是老平台导出的 GBK 文件）再按 GB18030 解（GBK 的超集）。只看字节，不看内容。
 */
export function decodeTextBytes(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder("utf-8").decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("gb18030").decode(bytes);
  }
}

/** 读浏览器里选中的文件并解码。 */
export async function readTextFile(file: Blob): Promise<string> {
  return decodeTextBytes(new Uint8Array(await file.arrayBuffer()));
}
