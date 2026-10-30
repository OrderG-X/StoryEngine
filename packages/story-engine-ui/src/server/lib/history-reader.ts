/**
 * 撤销、整本恢复读存档的 git 实现（写作版本 P2a 片 4C，核心的 HistoryReader，设计 8.1 / 8.2）。
 *
 * - 树 → 撤销范围里的路径和 blob 号：`git ls-tree -r -z`（NUL 分隔，路径不转义）；树不在了（裁掉、回收了）返回 undefined。
 *   范围里（认得出的名字）有不是普通文件的（软链、子模块）如实失败，不当成「存档里没有」去删现在那份。
 * - 按 blob 号取原始字节：一次计划开一个 `git cat-file --batch` 进程按号取（buffer、不 trim），用完 close。
 * - 一份字节的键 = git 的 blob 号（`blob <长度>\0` + 字节的哈希；仓库是 sha256 的就用 sha256），和树里给的同一种。
 * 只读：不写盘、不拿锁（调用方在书锁里用）。
 */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { isUndoablePath, UNDOABLE_DIRS, UNDOABLE_FILES, type HistoryReader } from "@actalk/story-core";
import { resolveGitCommand } from "./data-dirs.js";

const execFileAsync = promisify(execFile);

/** 存档树、blob 号：git 的十六进制对象号（sha1 40 位、sha256 64 位）。 */
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/** 普通文件的两种模式（可执行的也算）。 */
const FILE_MODES: ReadonlySet<string> = new Set(["100644", "100755"]);

export interface GitHistoryReader extends HistoryReader {
  /** 关掉取字节的那个进程（取到一半的如实失败）。 */
  close(): void;
}

interface Pending {
  readonly resolve: (bytes: Uint8Array) => void;
  readonly reject: (error: Error) => void;
}

/** 一个 `git cat-file --batch` 进程：按号排队取，回来的按顺序对上。 */
class BlobBatch {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly queue: Pending[] = [];
  private buffer: Buffer = Buffer.alloc(0);
  private failed: Error | undefined;

  constructor(git: string, projectDir: string) {
    this.process = spawn(git, ["-C", projectDir, "cat-file", "--batch"], { stdio: ["pipe", "pipe", "pipe"] });
    this.process.stdout.on("data", (chunk: Buffer) => {
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    const stop = (error: Error): void => {
      this.failed ??= error;
      for (const pending of this.queue.splice(0)) pending.reject(this.failed);
    };
    this.process.on("error", stop);
    this.process.on("close", () => stop(new Error("读存档的进程已经关了")));
    this.process.stdin.on("error", stop);
  }

  read(key: string): Promise<Uint8Array> {
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
      this.process.stdin.write(`${key}\n`);
    });
  }

  /** 回来的按 `<号> <类型> <长度>\n<字节>\n` 或 `<号> missing\n` 一份份切。 */
  private drain(): void {
    for (;;) {
      const head = this.buffer.indexOf(0x0a);
      if (head < 0) return;
      const header = this.buffer.subarray(0, head).toString("utf-8").split(" ");
      const pending = this.queue[0];
      if (!pending) return;
      if (header[1] === "missing" || header.length < 3) {
        this.buffer = this.buffer.subarray(head + 1);
        this.queue.shift();
        pending.reject(new Error("存档里没有这一份"));
        continue;
      }
      const size = Number(header[2]);
      if (!Number.isSafeInteger(size) || size < 0) {
        this.failed ??= new Error("读存档的回应认不出");
        for (const item of this.queue.splice(0)) item.reject(this.failed);
        this.process.kill();
        return;
      }
      if (this.buffer.length < head + 1 + size + 1) return;
      const bytes = Buffer.from(this.buffer.subarray(head + 1, head + 1 + size));
      this.buffer = this.buffer.subarray(head + 1 + size + 1);
      this.queue.shift();
      if (header[1] === "blob") pending.resolve(bytes);
      else pending.reject(new Error("存档里这一份不是文件"));
    }
  }

  close(): void {
    this.failed ??= new Error("读存档的进程已经关了");
    this.process.stdin.end();
    this.process.kill();
  }
}

/** 开一个读这本书存档的 reader（用完 close）。 */
export async function openGitHistoryReader(projectDir: string): Promise<GitHistoryReader> {
  const git = resolveGitCommand();
  const format = await execFileAsync(git, ["-C", projectDir, "rev-parse", "--show-object-format"])
    .then(({ stdout }) => stdout.trim(), () => "sha1");
  const algorithm = format === "sha256" ? "sha256" : "sha1";
  let batch: BlobBatch | undefined;
  return {
    async list(tree) {
      if (!OBJECT_ID.test(tree)) return undefined;
      try {
        await execFileAsync(git, ["-C", projectDir, "cat-file", "-e", `${tree}^{tree}`]);
      } catch {
        return undefined;
      }
      const { stdout } = await execFileAsync(
        git,
        ["-C", projectDir, "ls-tree", "-r", "-z", "--full-tree", tree, "--", ...UNDOABLE_DIRS, ...UNDOABLE_FILES],
        { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 },
      );
      const files = new Map<string, string>();
      for (const entry of stdout.toString("utf-8").split("\0")) {
        if (!entry) continue;
        const tab = entry.indexOf("\t");
        const [mode, type, id] = entry.slice(0, tab).split(" ");
        const path = entry.slice(tab + 1);
        if (tab < 0 || !mode || !id) throw new Error("存档的文件列表认不出");
        if (!isUndoablePath(path)) continue;
        if (type !== "blob" || !FILE_MODES.has(mode)) throw new Error(`存档里的这一份不是普通文件，不处理：${path}`);
        files.set(path, id);
      }
      return files;
    },
    read(key) {
      if (!OBJECT_ID.test(key)) return Promise.reject(new Error("存档号不对"));
      batch ??= new BlobBatch(git, projectDir);
      return batch.read(key);
    },
    keyOf(bytes) {
      return createHash(algorithm).update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
    },
    close() {
      batch?.close();
      batch = undefined;
    },
  };
}

/** 用一个 reader 做完一件事，做完关掉。 */
export async function withGitHistoryReader<T>(projectDir: string, fn: (reader: GitHistoryReader) => Promise<T>): Promise<T> {
  const reader = await openGitHistoryReader(projectDir);
  try {
    return await fn(reader);
  } finally {
    reader.close();
  }
}
