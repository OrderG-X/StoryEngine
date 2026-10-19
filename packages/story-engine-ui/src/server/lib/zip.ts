/**
 * 最小 zip 读写（P10：备份、导出 Word / epub 都是 zip）。只用 node:zlib，不引第三方包。
 *
 * 写：文件名 UTF-8（通用位 11）；可选不压缩（epub 的 mimetype、已压缩过的 git 对象）；条目超 65535 个时写 zip64 结尾记录
 *   （长书的存档历史里松散对象可能很多）；单个文件或整个包超过 4GB 直接报错，不写 zip64 条目扩展。
 * 读：只读本应用写的这种包——认 zip64 结尾记录，单条目要 zip64 扩展的不认；路径必须是相对路径、不许 `..`、不许反斜杠；
 *   声明的解压大小和真解出来的对不上就报错（防压缩炸弹：解压时上限就是声明大小）。
 */
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

export interface ZipEntryInput {
  /** 包内路径，正斜杠分隔；以 `/` 结尾表示空目录。 */
  readonly path: string;
  readonly data?: Buffer | string;
  /** true = 不压缩原样存。 */
  readonly store?: boolean;
  readonly mtime?: Date;
}

export interface ZipEntry {
  readonly path: string;
  readonly data: Buffer;
  readonly isDirectory: boolean;
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const UTF8_FLAG = 0x0800;
const MAX32 = 0xffffffff;
const MAX16 = 0xffff;

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** 把若干条目打成一个 zip。 */
export function createZip(entries: readonly ZipEntryInput[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const isDirectory = entry.path.endsWith("/");
    const name = Buffer.from(entry.path, "utf-8");
    const raw = isDirectory ? Buffer.alloc(0) : typeof entry.data === "string" ? Buffer.from(entry.data, "utf-8") : entry.data ?? Buffer.alloc(0);
    const store = isDirectory || entry.store === true || raw.length === 0;
    const body = store ? raw : deflateRawSync(raw);
    const method = store ? 0 : 8;
    const crc = crc32(raw) >>> 0;
    if (raw.length > MAX32 || body.length > MAX32 || offset > MAX32) throw new Error("文件太大，超过 4GB，打不了包。");
    const { time, date } = dosDateTime(entry.mtime ?? new Date());

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, body);

    const head = Buffer.alloc(46);
    head.writeUInt32LE(CENTRAL_SIG, 0);
    head.writeUInt16LE((3 << 8) | 20, 4); // 3 = Unix，带权限位
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(UTF8_FLAG, 8);
    head.writeUInt16LE(method, 10);
    head.writeUInt16LE(time, 12);
    head.writeUInt16LE(date, 14);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(body.length, 20);
    head.writeUInt32LE(raw.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt16LE(0, 30);
    head.writeUInt16LE(0, 32);
    head.writeUInt16LE(0, 34);
    head.writeUInt16LE(0, 36);
    head.writeUInt32LE((isDirectory ? 0o40755 : 0o100644) * 0x10000 + (isDirectory ? 0x10 : 0), 38);
    head.writeUInt32LE(offset, 42);
    central.push(head, name);

    offset += local.length + name.length + body.length;
  }
  const centralBuf = Buffer.concat(central);
  if (offset > MAX32 || centralBuf.length > MAX32) throw new Error("文件太大，超过 4GB，打不了包。");
  const tail: Buffer[] = [];
  const count = entries.length;
  if (count > MAX16) {
    const zip64 = Buffer.alloc(56);
    zip64.writeUInt32LE(ZIP64_EOCD_SIG, 0);
    zip64.writeBigUInt64LE(44n, 4);
    zip64.writeUInt16LE(45, 12);
    zip64.writeUInt16LE(45, 14);
    zip64.writeUInt32LE(0, 16);
    zip64.writeUInt32LE(0, 20);
    zip64.writeBigUInt64LE(BigInt(count), 24);
    zip64.writeBigUInt64LE(BigInt(count), 32);
    zip64.writeBigUInt64LE(BigInt(centralBuf.length), 40);
    zip64.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(ZIP64_LOCATOR_SIG, 0);
    locator.writeUInt32LE(0, 4);
    locator.writeBigUInt64LE(BigInt(offset + centralBuf.length), 8);
    locator.writeUInt32LE(1, 16);
    tail.push(zip64, locator);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(Math.min(count, MAX16), 8);
  eocd.writeUInt16LE(Math.min(count, MAX16), 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, ...tail, eocd]);
}

/** 包内路径是否安全：相对路径、不含 `..`、不含反斜杠和空段。 */
export function isSafeZipPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  const parts = path.replace(/\/$/, "").split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..");
}

/** 读本应用写的 zip。totalLimit：所有条目解压后加起来的上限（字节）。 */
export function readZip(buf: Buffer, options: { readonly totalLimit?: number } = {}): ZipEntry[] {
  const totalLimit = options.totalLimit ?? 2 * 1024 * 1024 * 1024;
  const fail = (why: string): never => { throw new Error(`这不是能认的压缩包：${why}`); };
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - MAX16); i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) fail("找不到结尾记录");
  let count = buf.readUInt16LE(eocd + 10);
  let centralOffset = buf.readUInt32LE(eocd + 16);
  if (count === MAX16 || centralOffset === MAX32) {
    const locator = eocd - 20;
    if (locator < 0 || buf.readUInt32LE(locator) !== ZIP64_LOCATOR_SIG) fail("zip64 定位记录缺失");
    const zip64At = Number(buf.readBigUInt64LE(locator + 8));
    if (zip64At < 0 || zip64At + 56 > buf.length || buf.readUInt32LE(zip64At) !== ZIP64_EOCD_SIG) fail("zip64 结尾记录不对");
    count = Number(buf.readBigUInt64LE(zip64At + 32));
    centralOffset = Number(buf.readBigUInt64LE(zip64At + 48));
  }
  const out: ZipEntry[] = [];
  let pos = centralOffset;
  let total = 0;
  for (let n = 0; n < count; n += 1) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== CENTRAL_SIG) fail("目录记录不对");
    const method = buf.readUInt16LE(pos + 10);
    const crc = buf.readUInt32LE(pos + 16);
    const compressed = buf.readUInt32LE(pos + 20);
    const size = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localAt = buf.readUInt32LE(pos + 42);
    const path = buf.subarray(pos + 46, pos + 46 + nameLen).toString("utf-8");
    pos += 46 + nameLen + extraLen + commentLen;
    if (compressed === MAX32 || size === MAX32 || localAt === MAX32) fail("不支持单个超大文件");
    if (!isSafeZipPath(path)) fail(`路径不安全（${path}）`);
    if (method !== 0 && method !== 8) fail(`不支持的压缩方式（${method}）`);
    total += size;
    if (total > totalLimit) fail("解压后太大");
    if (localAt + 30 > buf.length || buf.readUInt32LE(localAt) !== LOCAL_SIG) fail("文件记录不对");
    const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
    if (dataAt + compressed > buf.length) fail("文件被截断");
    const body = buf.subarray(dataAt, dataAt + compressed);
    const isDirectory = path.endsWith("/");
    let data: Buffer;
    try {
      data = method === 0 ? Buffer.from(body) : inflateRawSync(body, { maxOutputLength: Math.max(1, size) });
    } catch {
      return fail(`解不开（${path}）`);
    }
    if (data.length !== size || (crc32(data) >>> 0) !== crc) fail(`内容校验不过（${path}）`);
    out.push({ path: isDirectory ? path.replace(/\/$/, "") : path, data, isDirectory });
  }
  return out;
}
