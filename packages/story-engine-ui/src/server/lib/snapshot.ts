import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { recoverProjectCommitTransactions } from "../book/legacy-commit-recovery.js";
import { bumpRevision, recoverTransactions as recoverCoreTransactions, REVISION_PATH, withBookLock } from "@actalk/story-core";
import { mirrorIsStale, syncLegacyMirror } from "../book/mirror/sync.js";

import { resolveGitCommand, resolveGlobalDataDir } from "./data-dirs.js";
import { resyncWordStats } from "./word-stats.js";

const execFileAsync = promisify(execFile);

export interface SnapshotEntry {
  /** git commit hash，恢复时用 */
  readonly id: string;
  /** 操作描述，如"定稿前快照：第12章" */
  readonly label: string;
  /** epoch 秒 */
  readonly timestamp: number;
}

const LOG_FORMAT = "%H\t%ct\t%s";

async function git(projectDir: string, args: readonly string[], env?: Record<string, string>): Promise<string> {
  const argv = [
    "-C",
    projectDir,
    // 中文等非 ASCII 路径按原样输出，否则 diff --name-only 会给出八进制转义+引号
    "-c",
    "core.quotepath=false",
    // 隔离用户全局 gitconfig：开了 commit 签名会导致提交挂起
    "-c",
    "commit.gpgsign=false",
    // 提交后的自动维护（gc / maintenance）别甩到后台跑：后台进程还在往 .git/objects 写，
    // 书挪进回收站、测试删临时书都会撞上（ENOTEMPTY）
    "-c",
    "gc.autoDetach=false",
    "-c",
    "maintenance.autoDetach=false",
    ...args,
  ];
  const { stdout } = env === undefined
    ? await execFileAsync(resolveGitCommand(), argv)
    : await execFileAsync(resolveGitCommand(), argv, { encoding: "utf-8", env: { ...process.env, ...env } });
  return stdout.trim();
}

/** 存档、恢复和所有写命令共用核心的书锁（可重入，重构 P7 统一成一把）。 */
async function withProjectLock<T>(projectDir: string, fn: () => Promise<T>): Promise<T> {
  return withBookLock(projectDir, fn);
}

function parseLogLine(line: string): SnapshotEntry {
  const [id, ts, ...rest] = line.split("\t");
  return { id: id ?? "", timestamp: Number(ts ?? 0), label: rest.join("\t") };
}

/* ---------------------------------------------------------------------------
 * 对话历史不入快照（P2·2026-10-02）
 *
 * 快照用 `git add -A` 把项目目录整个卷进去，`.story-engine-ui/chat-sessions/`（右侧 AI 对话的持久化）也在内。
 * 于是 undo_last_change / 块级撤销在回退写作状态的同时，把用户**已经看到过的聊天记录**也回退掉——
 * 对话是「控制面日志」不是「写作状态」，撤销应只回退后者。
 * 做法：写进 `<gitdir>/info/exclude`（不碰用户可见的 .gitignore）；旧书里已被跟踪的会话文件 `git rm --cached` 摘出索引
 * （磁盘不动）；restore 的 diff/checkout 用 `:(exclude)` 路径魔法跳过该目录，连历史快照里的旧会话文件也不会被 checkout 盖回来。
 * 幂等回执目录 `.story-engine-ui/commit-idempotency/` 仍随快照（设计如此：撤销定稿要连回执一起回退，见 commit-service 不变量⑦）。
 * ------------------------------------------------------------------------- */

/** 对话历史目录（相对项目根，无前后斜杠）。 */
export const SNAPSHOT_EXCLUDED_CHAT_SESSIONS_DIR = ".story-engine-ui/chat-sessions";
/** info/exclude 里的那一行（锚定根、目录语义）。 */
export const CHAT_SESSIONS_EXCLUDE_LINE = `/${SNAPSHOT_EXCLUDED_CHAT_SESSIONS_DIR}/`;
const CHAT_SESSIONS_EXCLUDE_MARKER = "# story-engine-ui: 对话历史不入快照（撤销不回退聊天记录）";
/**
 * 定稿事务目录不入快照（2026-10-10 引擎升级第 4 期）：每章定稿都把当时要改的故事文件整份备份进
 * `.story-engine-tx/`，书越长每份越大；快照 `git add -A` 把它们全卷进书的 git 仓库，58 章的书仓库里 812 个文件是它，
 * 总量按章数平方涨。事务目录自带恢复证据、引擎自己管（同章再定稿复用、旧的归档并只留最近几份），
 * 和「撤销回到哪一步」无关：撤销定稿回退的是章节和故事资料，事务目录原样留着，下次定稿同一章照常复用。
 */
export const SNAPSHOT_EXCLUDED_TX_DIR = ".story-engine-tx";
const TX_EXCLUDE_LINE = `/${SNAPSHOT_EXCLUDED_TX_DIR}/`;
const TX_EXCLUDE_MARKER = "# story-engine-ui: 定稿事务目录不入快照（引擎自管，进快照会让仓库按章数平方涨）";
/** 分步计量记录（作者的运行日志）：撤销不该把它回退。 */
const METRICS_EXCLUDE_DIR = ".story-engine-ui/metrics";
const METRICS_EXCLUDE_MARKER = "# story-engine-ui: 分步计量记录不入快照（运行日志，撤销不回退）";
/** 专员读书笔记（编辑部，2026-10-12）：按定稿正文哈希自校验的缓存，撤销回退了正文它自己会作废重写，不必随快照。 */
const AGENTS_EXCLUDE_DIR = "agents";
const AGENTS_EXCLUDE_MARKER = "# story-engine-ui: 专员读书笔记不入快照（按正文哈希自校验的缓存）";

/** 新核心的定稿预览票（重构 P3）：只是缓存，丢了重新预览；进快照的话撤销会把过期的票翻回来。 */
const CORE_PREVIEW_DIR = "ledger/.preview";
const CORE_PREVIEW_MARKER = "# story-engine-ui: 定稿预览票不入快照（缓存）";
/** 新核心的写盘事务目录：核心自己收拾，和旧引擎的 .story-engine-tx 同理。 */
const CORE_TX_DIR = ".story-core-tx";
const CORE_TX_MARKER = "# story-engine-ui: 新核心事务目录不入快照（核心自管）";
/** 新核心留证的东西（坏事务、镜像前的老文件原样）：撤销不能把它们抹掉。 */
const CORE_KEPT_DIR = ".story-core-kept";
const CORE_KEPT_MARKER = "# story-engine-ui: 新核心留证目录不入快照（撤销不抹证据）";
/** 书的写入代次（写作版本 P1a）：撤销 / 恢复不能把它翻回去，恢复完换一个新的（按恢复前算的预览一律作废）。 */
const CORE_REVISION_DIR = dirname(REVISION_PATH);
const CORE_REVISION_MARKER = "# story-engine-ui: 写入代次不入快照（撤销不回退代次）";
/** 写作统计（P10）：撤销不回退统计，恢复后重数。 */
const WORD_STATS_DIR = ".story-engine-ui/stats";
const WORD_STATS_MARKER = "# story-engine-ui: 写作统计不入快照（撤销不回退统计）";

/** 快照排除的目录（info/exclude 一行 + diff/checkout 路径魔法）。 */
const SNAPSHOT_EXCLUSIONS: readonly { readonly dir: string; readonly line: string; readonly marker: string }[] = [
  { dir: SNAPSHOT_EXCLUDED_CHAT_SESSIONS_DIR, line: CHAT_SESSIONS_EXCLUDE_LINE, marker: CHAT_SESSIONS_EXCLUDE_MARKER },
  { dir: SNAPSHOT_EXCLUDED_TX_DIR, line: TX_EXCLUDE_LINE, marker: TX_EXCLUDE_MARKER },
  { dir: METRICS_EXCLUDE_DIR, line: `/${METRICS_EXCLUDE_DIR}/`, marker: METRICS_EXCLUDE_MARKER },
  { dir: AGENTS_EXCLUDE_DIR, line: `/${AGENTS_EXCLUDE_DIR}/`, marker: AGENTS_EXCLUDE_MARKER },
  { dir: CORE_PREVIEW_DIR, line: `/${CORE_PREVIEW_DIR}/`, marker: CORE_PREVIEW_MARKER },
  { dir: CORE_TX_DIR, line: `/${CORE_TX_DIR}/`, marker: CORE_TX_MARKER },
  { dir: CORE_KEPT_DIR, line: `/${CORE_KEPT_DIR}/`, marker: CORE_KEPT_MARKER },
  { dir: WORD_STATS_DIR, line: `/${WORD_STATS_DIR}/`, marker: WORD_STATS_MARKER },
  { dir: CORE_REVISION_DIR, line: `/${CORE_REVISION_DIR}/`, marker: CORE_REVISION_MARKER },
];
/** git 路径魔法：diff / checkout 时跳过这些目录。 */
const EXCLUDE_PATHSPECS = SNAPSHOT_EXCLUSIONS.map((item) => `:(exclude)${item.dir}`);

function excludeFileHasLine(text: string, line: string): boolean {
  return text.split(/\r?\n/u).some((entry) => entry.trim() === line);
}

/**
 * 确保 `<gitdir>/info/exclude` 含要排除的目录；首次写入时把旧书里已跟踪的文件摘出索引（下一次快照即记为「不再跟踪」）。
 * 失败不阻断快照（exclude 只是降噪，不是正确性前提）：读/写 exclude 出错就跳过，下次再试。
 */
async function ensureChatSessionsExcludedUnlocked(projectDir: string): Promise<void> {
  const excludePath = join(projectDir, ".git", "info", "exclude");
  let existing = "";
  try {
    existing = await readFile(excludePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return; // .git 是文件（worktree）等异常形态：不碰
  }
  const missing = SNAPSHOT_EXCLUSIONS.filter((item) => !excludeFileHasLine(existing, item.line));
  if (missing.length === 0) return;
  try {
    await mkdir(dirname(excludePath), { recursive: true });
    const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    await writeFile(excludePath, `${existing}${separator}${missing.map((item) => `${item.marker}\n${item.line}\n`).join("")}`, "utf-8");
    // 旧书迁移：已跟踪的文件从索引摘掉（--cached 不动磁盘；--ignore-unmatch 没跟踪过也不报错）。
    for (const item of missing) {
      await git(projectDir, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", item.dir]);
    }
  } catch (error) {
    console.warn("[snapshot] 写入快照排除目录失败（不影响快照本身，下次再试）", error);
  }
}

/**
 * 书目录本来就是 git 仓库（作者自己 init 过、或别处拷来的）时，我们没给它配过身份；电脑上也没有全局 git 身份的话，
 * 提交报「Author identity unknown」，存档点就打不上（2026-10-22 CI 跑手上撞到）。解析不出身份才补一份本仓库的，
 * 作者自己配过的不动。
 */
async function ensureIdentityUnlocked(projectDir: string): Promise<void> {
  const email = await git(projectDir, ["config", "user.email"]).catch(() => "");
  if (email) return;
  await git(projectDir, ["config", "user.name", "StoryEngine"]);
  await git(projectDir, ["config", "user.email", "snapshot@story-engine.local"]);
}

/** 不加锁的内部版本，供已持锁的导出函数复用，避免同模块重入死锁。 */
async function ensureRepoUnlocked(projectDir: string): Promise<void> {
  let isRepo = true;
  try {
    await access(join(projectDir, ".git"));
  } catch {
    isRepo = false; // 还不是仓库，初始化
  }
  if (isRepo) {
    await ensureIdentityUnlocked(projectDir);
    await ensureChatSessionsExcludedUnlocked(projectDir); // 旧书：补 exclude + 摘索引（幂等、一次性）
    return;
  }
  await git(projectDir, ["init"]);
  await git(projectDir, ["config", "user.name", "StoryEngine"]);
  await git(projectDir, ["config", "user.email", "snapshot@story-engine.local"]);
  await ensureChatSessionsExcludedUnlocked(projectDir);
  await git(projectDir, ["add", "-A"]);
  await git(projectDir, ["commit", "--allow-empty", "-m", "初始快照"]);
}

export async function ensureSnapshotRepo(projectDir: string): Promise<void> {
  return withProjectLock(projectDir, () => ensureRepoUnlocked(projectDir));
}

/** 不加锁的内部版本，供已持锁的导出函数复用（调用方须已 withProjectLock + ensureRepoUnlocked）。 */
async function createSnapshotUnlocked(projectDir: string, label: string): Promise<SnapshotEntry> {
  await git(projectDir, ["add", "-A"]);
  await git(projectDir, ["commit", "--allow-empty", "-m", label]);
  return parseLogLine(await git(projectDir, ["log", "-1", `--pretty=format:${LOG_FORMAT}`]));
}

/** 写入前调用：把当前全部状态存为一个快照。 */
export async function createSnapshot(projectDir: string, label: string): Promise<SnapshotEntry> {
  return withProjectLock(projectDir, async () => {
    await recoverProjectCommitTransactions(projectDir);
    await ensureRepoUnlocked(projectDir);
    return createSnapshotUnlocked(projectDir, label);
  });
}

/**
 * 原子地「建快照 + 执行落盘」：把 createSnapshot 与紧随其后的写操作 fn 罩进同一 project 锁，
 * 令二者成为一个不可分割的临界区——治撤销竞态。
 *
 * 旧 withSnapshot 是「createSnapshot（持锁、原子）→ run（锁外落盘）」：快照边界与落盘不在同一临界区，
 * 同一 project 并发时，另一操作的 createSnapshot/restoreSnapshot 会切进 run 中间 → 捕获不一致的部分态、
 * 或撤销逃逸/过度回滚（线性快照史被并发打乱）。本函数把写操作纳入同一把锁，彻底消除该窗口；
 * 撤销（restoreSnapshot 同走 withProjectLock）也会排在写之后，不再插进写中间。
 *
 * The canonical project lock is re-entrant, so formal-commit code may safely
 * call engine operations while this snapshot boundary remains held.
 */
export async function runWithSnapshot<T>(
  projectDir: string,
  label: string,
  fn: (snapshotId: string) => Promise<T>,
): Promise<{ readonly snapshot: SnapshotEntry; readonly result: T }> {
  return withProjectLock(projectDir, async () => {
    await recoverProjectCommitTransactions(projectDir);
    await ensureRepoUnlocked(projectDir);
    const snapshot = await createSnapshotUnlocked(projectDir, label);
    const result = await fn(snapshot.id);
    // 落盘收尾（afterfix #2）：把 fn 写出的文件即时收进 git，令工作树在每次写操作后保持干净——否则最后一次
    // 写操作的产物会长期以 dirty/untracked 残留（Codex 三轮误判「入库已完成但 git 还脏=没写盘」）。
    // 这条 commit 标成「落盘收尾」产物：undo 与操作历史都跳过它（isUndoSkippableArtifact / 路由过滤），
    // 撤销目标仍是 fn 之前的 `snapshot`、撤销语义完全不变。无改动则不建（避免空 commit 噪声）。
    if (await hasUncommittedChanges(projectDir)) {
      await createSnapshotUnlocked(projectDir, `${POST_WRITE_LABEL_PREFIX}${label}`);
    }
    return { snapshot, result };
  });
}

/**
 * 「真要写盘才打存档点」（重构 P9）：fn 拿到一个存档回调交给核心 runCommand——核心在书锁里、算出确实要写之后才调它，
 * 指错了、没变化、按钮点第二次（回执重放）都不打，操作历史里不会多出什么都没改的一条。
 * 一批里多条命令只打第一次（一批改动撤销一步）；有 fixedLabel 就用它，没有就用核心给的命令名 + 人话。
 * 整段在同一把书锁里，写完照 runWithSnapshot 落盘收尾，撤销不会插进中间。
 */
export async function runWithLazySnapshot<T>(
  projectDir: string,
  fn: (snapshot: (label: string, command: string) => Promise<void>) => Promise<T>,
  fixedLabel?: string,
): Promise<{ readonly snapshotId?: string; readonly result: T }> {
  return withProjectLock(projectDir, async () => {
    let taken: SnapshotEntry | undefined;
    const result = await fn(async (label, command) => {
      if (taken) return;
      await recoverProjectCommitTransactions(projectDir);
      await ensureRepoUnlocked(projectDir);
      taken = await createSnapshotUnlocked(projectDir, fixedLabel ?? coreSnapshotLabel(command, label));
    });
    if (taken && (await hasUncommittedChanges(projectDir))) {
      await createSnapshotUnlocked(projectDir, `${POST_WRITE_LABEL_PREFIX}${taken.label}`);
    }
    return { ...(taken ? { snapshotId: taken.id } : {}), result };
  });
}

export async function listSnapshots(projectDir: string, limit = 100): Promise<SnapshotEntry[]> {
  return withProjectLock(projectDir, async () => {
    await ensureRepoUnlocked(projectDir);
    const out = await git(projectDir, ["log", `-${limit}`, `--pretty=format:${LOG_FORMAT}`]);
    return out ? out.split("\n").map(parseLogLine) : [];
  });
}

/** 恢复实际退回的内容：目标存档点与「恢复前自动快照」之间的文件差异 + 哪些是「目标那一步之后才写的」。 */
export interface RestoreOutcome {
  /** 「恢复到：X」那条提交（历史最新一条）。 */
  readonly restored: SnapshotEntry;
  /**
   * 这次恢复实际动到的全部文件（状态方向=目标→恢复前：A=恢复后不再有、D=被恢复回来、M=内容回退）。
   * R4.2（验收 3.2）：撤销/恢复的回执必须写清实际退回了什么——只说「只撤了这一步」会给了模型
   * 编「没受影响」的空间（真机实锤：第 5 章草稿被删了，模型却说「还在磁盘上」）。
   */
  readonly reverted: readonly CommitFileChange[];
  /** reverted 里属于「目标那一步之后才写的」文件——超出所撤步骤本身的连带退回，回执要单独说明。 */
  readonly revertedLater: readonly CommitFileChange[];
}

/**
 * 恢复到目标快照。先校验目标存在，再把当前状态自动存档（可反悔），
 * 然后删掉目标之后新增的文件、还原全部内容，最后记一条"恢复到：X"。
 * 历史永不丢失，恢复操作本身也能被恢复。
 */
export async function restoreSnapshot(projectDir: string, id: string): Promise<RestoreOutcome> {
  return withProjectLock(projectDir, async () => {
    if (!/^[0-9a-f]{40}$/.test(id)) {
      throw new Error("无效的快照 id");
    }
    // Recovery must happen before git add/commit/checkout; otherwise a partial
    // formal transaction becomes part of the pre-restore history and may be
    // resurrected by a later undo.
    await recoverProjectCommitTransactions(projectDir);
    // 新核心的写盘事务同理：先收拾完（写完或回滚），半截的事务不能进「恢复前自动快照」。
    await recoverCoreTransactions(projectDir);
    await ensureRepoUnlocked(projectDir);
    // 先解析目标：失败即抛，不污染历史
    const target = parseLogLine(await git(projectDir, ["log", "-1", `--pretty=format:${LOG_FORMAT}`, id]));
    await git(projectDir, ["add", "-A"]);
    await git(projectDir, ["commit", "--allow-empty", "-m", "恢复前自动快照"]);
    // 恢复前自动快照即此刻 HEAD；回执的「实际退回了什么」= 它与目标之间的全部文件差异。
    const preRestoreId = (await git(projectDir, ["rev-parse", "HEAD"]));
    // --no-renames：禁用 rename 侦测，改名产生的新文件按 A 计，否则会被判为 R 而残留
    // 对话目录用 :(exclude) 跳过：旧快照里曾被跟踪的会话文件既不被 unlink、也不被下面的 checkout 盖回磁盘。
    const addedSince = await git(projectDir, [
      "diff", "--name-only", "--no-renames", "--diff-filter=A", `${id}..HEAD`, "--", ".", ...EXCLUDE_PATHSPECS,
    ]);
    for (const file of addedSince.split("\n").filter(Boolean)) {
      await unlink(join(projectDir, file)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    // unlink 只删文件不删目录：.story-engine-tx/commit-chapter-N 被掏空后会留下无 manifest 的
    // 空目录壳，引擎 recover 撞「目录在、manifest 不在」会 fail-closed 抛错把书搞砖（P1-B）。
    // 当场把零文件空壳收掉；有内容的目录 rmdir 不动（ENOTEMPTY 停手），漏网壳由引擎 recover 兜底。
    await removeEmptiedTransactionShells(projectDir);
    await git(projectDir, ["checkout", id, "--", ".", ...EXCLUDE_PATHSPECS]);
    // 真相换回去了：换一个新代次，恢复前照着书算的预览、提议按钮一律作废（哪怕又回到了和它一模一样的内容）。
    await bumpRevision(projectDir);
    await git(projectDir, ["add", "-A"]);
    await git(projectDir, ["commit", "--allow-empty", "-m", `恢复到：${target.label}`]);
    // 账单和老格式镜像同在快照里，恢复后本该一致；万一对不上（镜像那次没写完就存了快照），按恢复后的账重生成一遍。
    if (await mirrorIsStale(projectDir)) {
      const mirror = await syncLegacyMirror(projectDir);
      if (!mirror.ok) console.warn(`[snapshot] 恢复后重生成老格式镜像没成：${mirror.reason}`);
    }
    const receipt = await buildRestoreReceiptFacts(projectDir, id, preRestoreId);
    // 写作统计不进存档点：恢复后全书重数一遍。
    await resyncWordStats(projectDir);
    return { restored: parseLogLine(await git(projectDir, ["log", "-1", `--pretty=format:${LOG_FORMAT}`])), ...receipt };
  });
}

/** 两个提交之间的文件差异（--name-status，状态方向 from→to；排除对话/事务/笔记等非写作状态目录）。 */
async function diffFileChangesBetween(projectDir: string, fromId: string, toId: string): Promise<CommitFileChange[]> {
  const out = await git(projectDir, [
    "diff", "--name-status", "--no-renames", `${fromId}..${toId}`, "--", ".", ...EXCLUDE_PATHSPECS,
  ]);
  return parseFileStatusLines(out);
}

/** `--name-status` 输出 → CommitFileChange[]（认不出的行丢弃，绝不猜）。 */
function parseFileStatusLines(out: string): CommitFileChange[] {
  const files: CommitFileChange[] = [];
  for (const line of out.split("\n")) {
    const match = /^([A-Z])[0-9]*\t(.+)$/u.exec(line.trim());
    if (match) files.push({ status: match[1]!, path: match[2]!.trim() });
  }
  return files;
}

/** 提交区间（fromId..toId，新→旧）里每个提交：id + label + 它改动的文件。 */
interface RangeCommit {
  readonly id: string;
  readonly label: string;
  readonly files: readonly CommitFileChange[];
}

async function readRangeCommits(projectDir: string, fromId: string, toId: string): Promise<RangeCommit[]> {
  const out = await git(projectDir, [
    "log", "--name-status", "--no-renames", `--pretty=format:@@%H%x1f%s`, `${fromId}..${toId}`,
  ]);
  const commits: RangeCommit[] = [];
  let current: { id: string; label: string; files: CommitFileChange[] } | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("@@")) {
      const [id, label] = line.slice(2).split("\x1f");
      current = { id: (id ?? "").trim(), label: label ?? "", files: [] };
      commits.push(current);
      continue;
    }
    const match = /^([A-Z])[0-9]*\t(.+)$/u.exec(line);
    if (current && match) current.files.push({ status: match[1]!, path: match[2]!.trim() });
  }
  return commits;
}

/**
 * 回执事实：这次恢复实际退回了哪些文件、其中哪些是「目标那一步之后才写的」。
 *
 * 归因沿用操作历史的既有约定（attachSnapshotChanges）：一个存档点所-guard 的操作，其写出的文件
 * 落在它上方更旧侧的第一段提交里（「落盘收尾」工程提交，或没有收尾时被下一个存档点的 add -A 收走）。
 * 从目标往上找到第一个真存档点（非落盘收尾/恢复产物）为止收「这一步」的文件；它之上（更新侧）的
 * 一律算「这步之后写的」。中间没有真存档点 = 没有别的写操作插进来，全部差异都算这一步本身。
 */
async function buildRestoreReceiptFacts(
  projectDir: string,
  targetId: string,
  preRestoreId: string,
): Promise<Pick<RestoreOutcome, "reverted" | "revertedLater">> {
  const reverted = await diffFileChangesBetween(projectDir, targetId, preRestoreId).catch(() => [] as CommitFileChange[]);
  if (reverted.length === 0) return { reverted: [], revertedLater: [] };
  const commits = await readRangeCommits(projectDir, targetId, preRestoreId).catch(() => [] as RangeCommit[]);
  // commits 新→旧；从最旧端（紧贴目标）往上找第一个真存档点 = boundary（含它，它的提交承载上一步未收尾的写产物）。
  let boundary = -1;
  for (let index = commits.length - 1; index >= 0; index -= 1) {
    const label = commits[index]!.label;
    if (!isRestoreArtifact(label) && !isPostWriteSettlementSnapshot(label)) { boundary = index; break; }
  }
  const laterPaths = new Set<string>();
  if (boundary >= 0) {
    for (let index = 0; index < boundary; index += 1) {
      for (const file of commits[index]!.files) laterPaths.add(file.path);
    }
  }
  const revertedLater = reverted.filter((file) => laterPaths.has(file.path));
  return { reverted, revertedLater };
}

/**
 * 自底向上收掉「递归零文件」的目录壳：rmdir 只对空目录生效——有文件/有非空子目录即 ENOTEMPTY 停手，
 * 绝不会误删内容（也不用 recursive rm，Node 无 unlinkat、递归删除无法做到竞态安全）。
 */
async function rmdirIfEmptyRecursive(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => undefined);
  if (!entries) return; // 已消失/读不到——没有壳可收
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await rmdirIfEmptyRecursive(join(dir, entry.name));
    }
  }
  await rmdir(dir).catch(() => undefined); // 非空即停手，留给引擎 recover 按 fail-closed 判
}

/**
 * 恢复/撤销 unlink 新增文件后，清扫 .story-engine-tx 下被掏空的空目录壳（典型：commit-chapter-N
 * 的 manifest/暂存/备份全被删掉只剩空目录）。只动空壳；txRoot 本身保留（引擎容忍空根目录）。
 */
async function removeEmptiedTransactionShells(projectDir: string): Promise<void> {
  const txRoot = join(projectDir, ".story-engine-tx");
  const entries = await readdir(txRoot, { withFileTypes: true }).catch(() => undefined);
  if (!entries) return; // 没有 tx 目录即无事可做
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await rmdirIfEmptyRecursive(join(txRoot, entry.name));
    }
  }
}

/** 撤销操作自身写下的两条 commit（恢复前自动快照 / 恢复到：…）——逐步撤销时要跳过、否则卡在原地。 */
function isRestoreArtifact(label: string): boolean {
  return label.startsWith("恢复到：") || label === "恢复前自动快照";
}

/**
 * 落盘收尾 commit 前缀（afterfix #2）：runWithSnapshot 在写操作后把产物即时收进 git 的那条工程 commit。
 * 它内容==当时工作树（本就无差异、会被 undo 的 differing 判定跳过），但 undo 回退后工作树会变——届时它会「有差异」、
 * 可能被误当撤销目标（变成重做）；故显式纳入 undo 跳过名单。操作历史也据此过滤、不显这条工程 commit。
 */
const POST_WRITE_LABEL_PREFIX = "落盘收尾：";
/**
 * 每个提交改动了哪一章的正式章节文件（chapters/NNNN.md）：一次 git log --name-only 拿全，供操作历史给老的「定稿」条目补章号。
 * 只认项目根下的 chapters/ 文件（.story-engine-tx 事务归档里的副本不算）。读不到返回空表，不影响列表本身。
 */
export async function readCommitChapterHints(projectDir: string, limit = 100): Promise<Map<string, number>> {
  return chapterHintsFromFileChanges(await readCommitFileChanges(projectDir, limit));
}

/** 一个提交里改动的一个文件：status 取 git 的 A(新增)/M(修改)/D(删除)/T 等首字母。 */
export interface CommitFileChange {
  readonly status: string;
  readonly path: string;
}

/**
 * 每个提交改了哪些文件（一次 git log --name-status 拿全，新→旧）：操作历史据此补章号、列「查看改动」。
 * 读不到（非 git 目录、git 失败）返回空表，不影响列表本身。
 */
export async function readCommitFileChanges(projectDir: string, limit = 100): Promise<Map<string, CommitFileChange[]>> {
  const changes = new Map<string, CommitFileChange[]>();
  const out = await withProjectLock(projectDir, () =>
    git(projectDir, ["log", `-${limit}`, "--name-status", "--no-renames", "--pretty=format:@@%H"]),
  ).catch(() => "");
  let current: CommitFileChange[] | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("@@")) {
      current = [];
      changes.set(line.slice(2).trim(), current);
      continue;
    }
    const match = /^([A-Z])[0-9]*\t(.+)$/u.exec(line);
    if (current && match) current.push({ status: match[1]!, path: match[2]!.trim() });
  }
  return changes;
}

/** 只认项目根下的 chapters/NNNN.md（.story-engine-tx 事务归档里的副本不算），每个提交取第一个。 */
export function chapterHintsFromFileChanges(changes: ReadonlyMap<string, readonly CommitFileChange[]>): Map<string, number> {
  const hints = new Map<string, number>();
  for (const [id, files] of changes) {
    for (const file of files) {
      const match = /^chapters\/(\d+)\.md$/u.exec(file.path);
      if (match) { hints.set(id, Number(match[1])); break; }
    }
  }
  return hints;
}

/**
 * 老的定稿存档（标签只有 agent:commit_apply、没带章号）补章号：定稿前存档点之后紧跟的「落盘收尾」提交里有 chapters/NNNN.md。
 * entries 是 git log 原始顺序（新→旧），须在过滤掉落盘收尾条目之前调用。
 */
export function attachCommitChapterDetails(
  entries: readonly SnapshotEntry[],
  hints: ReadonlyMap<string, number>,
): SnapshotEntry[] {
  return entries.map((entry, index) => {
    if (entry.label !== "agent:commit_apply") return entry;
    const newer = index > 0 ? entries[index - 1] : undefined;
    const chapter = (newer && isPostWriteSettlementSnapshot(newer.label) ? hints.get(newer.id) : undefined) ?? hints.get(entry.id);
    return chapter ? { ...entry, label: `agent:commit_apply:第${chapter}章` } : entry;
  });
}

export function isPostWriteSettlementSnapshot(label: string): boolean {
  return label.startsWith(POST_WRITE_LABEL_PREFIX);
}

/** 逐步撤销时要跳过的工程产物：恢复产物 + 落盘收尾 commit。 */
function isUndoSkippableArtifact(label: string): boolean {
  return isRestoreArtifact(label) || isPostWriteSettlementSnapshot(label);
}

/** 最近 limit 个提交的内容树 hash（id → tree），撤销据此认出「恢复到：X」恢复的是哪个存档点。 */
async function readCommitTrees(projectDir: string, limit: number): Promise<Map<string, string>> {
  const out = await git(projectDir, ["log", `-${limit}`, "--pretty=format:%H %T"]).catch(() => "");
  const trees = new Map<string, string>();
  for (const line of out.split("\n")) {
    const [id, tree] = line.trim().split(" ");
    if (id && tree) trees.set(id, tree);
  }
  return trees;
}

/** 工作树是否有未跟踪文件（工具新写的草稿/资料在下一次快照前是 untracked，git diff 看不到，须单独探）。 */
async function hasUntrackedFiles(projectDir: string): Promise<boolean> {
  const out = await git(projectDir, ["ls-files", "--others", "--exclude-standard"]);
  return out.length > 0;
}

/** 工作树是否有任何未提交改动（含未跟踪文件）——决定写操作后是否需要补一条落盘收尾 commit。 */
async function hasUncommittedChanges(projectDir: string): Promise<boolean> {
  const out = await git(projectDir, ["status", "--porcelain"]);
  return out.trim().length > 0;
}

/** 快照 id 的内容是否与当前工作树不同（含未跟踪文件：有 untracked 即视为不同——比任何已提交快照都多东西）。 */
async function snapshotDiffersFromWorkingTree(projectDir: string, id: string, untracked: boolean): Promise<boolean> {
  if (untracked) return true;
  try {
    // 对话目录不参与「有没有可撤销改动」的判定：旧书里曾被跟踪的会话文件在摘索引后与旧快照永远有差异，不排除会让
    // 「没东西可撤」被误判成「有」、把一次 no-op 恢复报成撤销。
    await git(projectDir, ["diff", "--quiet", id, "--", ".", ...EXCLUDE_PATHSPECS]);
    return false; // exit 0：无差异
  } catch {
    return true; // 非零：有差异
  }
}

const UNDO_TOOL_LABELS: Record<string, string> = {
  commit_apply: "定稿",
  foundation_write: "改设定本",
  generate_draft: "出稿",
  revise_draft: "修改工作稿",
  generate_chapter_steering: "章节方向",
  generate_worldbuilding: "补全世界观",
  generate_character_enrichment: "补全角色",
  generate_asset_enrichment: "补全道具与资源",
  generate_location_enrichment: "补全地点",
  generate_matrix_enrichment: "补全角色关系",
  generate_character_relationships: "整理角色关系",
  generate_writing_rules_enrichment: "重新整理写作规则",
  generate_alias_table: "补全别名表",
  edit_fact_ledger: "记录故事事实",
  set_foreshadowing_importance: "伏笔重要度",
  resolve_thread: "线索收口",
  clean_legacy_threads: "线索清理",
  group_related_leads: "线索归并",
  manage_ledger: "改账",
};

export type SnapshotKind = "commit" | "draft" | "bible" | "restore";

/** 写类工具 → 操作历史筛选分类。没列的（出稿、修订、章节方向和各路正文存档点）算「正文改动」。 */
const TOOL_KINDS: Record<string, SnapshotKind> = {
  commit_apply: "commit",
  foundation_write: "bible",
  generate_worldbuilding: "bible",
  generate_character_enrichment: "bible",
  generate_asset_enrichment: "bible",
  generate_location_enrichment: "bible",
  generate_matrix_enrichment: "bible",
  generate_character_relationships: "bible",
  generate_writing_rules_enrichment: "bible",
  generate_alias_table: "bible",
  edit_fact_ledger: "bible",
  set_foreshadowing_importance: "bible",
  resolve_thread: "bible",
  clean_legacy_threads: "bible",
  group_related_leads: "bible",
  manage_ledger: "bible",
};

/** 核心写命令 → 操作历史分类。 */
const CORE_COMMAND_KINDS: Record<string, SnapshotKind> = {
  "chapter.commit": "commit",
  "chapter.retitle": "commit",
  "decision.record": "bible",
  "book.import": "bible",
  "book.importText": "commit",
  "draft.applyGenerated": "draft",
  "draft.adoptCandidate": "draft",
  "card.write": "bible",
  "card.fill": "bible",
  "cards.import": "bible",
  "settle.apply": "commit",
};

/** 早于命令名进标签时（P3～P7 之间）核心打的存档点，整串认。 */
const LEGACY_CORE_LABEL_KINDS: Record<string, SnapshotKind> = {
  "导入老书的账": "bible",
};

const CORE_LABEL_PREFIX = "core:";

/** 核心命令打存档点的标签：core:<命令名>:<核心给的人话>。 */
export function coreSnapshotLabel(command: string, label: string): string {
  return `${CORE_LABEL_PREFIX}${command}:${label}`;
}

/** 交给核心 runCommand / ensureBookOnCore 的存档回调（标签带上命令名）。 */
export function coreSnapshotFor(projectDir: string): (label: string, command: string) => Promise<void> {
  return (label, command) => createSnapshot(projectDir, coreSnapshotLabel(command, label)).then(() => undefined);
}

function splitHead(rest: string): readonly [string, string] {
  const sep = rest.indexOf(":");
  return sep >= 0 ? [rest.slice(0, sep), rest.slice(sep + 1)] : [rest, ""];
}

/**
 * 存档点属于哪一类：按原始标签里写入方的工具名 / 核心命令名查表（agent:<toolId>[:细节]、core:<命令>:<人话>），
 * 恢复产物看自家前缀。不看人话标签里的字眼（细节里可能就有「定稿」「角色」这些字，重构 P7「不猜」）。
 */
export function snapshotKindOf(label: string): SnapshotKind {
  if (label.startsWith("恢复到：") || label === "恢复前自动快照") return "restore";
  if (label.startsWith(CORE_LABEL_PREFIX)) return CORE_COMMAND_KINDS[splitHead(label.slice(CORE_LABEL_PREFIX.length))[0]] ?? "draft";
  if (!label.startsWith("agent:")) return LEGACY_CORE_LABEL_KINDS[label] ?? "draft";
  return TOOL_KINDS[splitHead(label.slice("agent:".length))[0]] ?? "draft";
}

/**
 * 把快照 label（agent:<toolId> / 恢复产物 / 自定义）转成给用户看的中文动作名。
 * 操作历史面板经路由层用它把原始 git subject 人话化（snapshots.ts），undo 也用它回报。
 * 恢复产物形如「恢复到：agent:commit_apply」——前缀剥开后对内层再 humanize，杜绝中间露出 agent: 工程标签。
 */
export function humanizeUndoLabel(label: string): string {
  // 不猜白名单：自家格式
  const restoreMatch = /^恢复到：(.+)$/u.exec(label);
  if (restoreMatch) return `恢复到：${humanizeUndoLabel(restoreMatch[1]!)}`;
  if (label === "恢复前自动快照") return "恢复前的自动存档";
  if (label.startsWith(CORE_LABEL_PREFIX)) return splitHead(label.slice(CORE_LABEL_PREFIX.length))[1] || label;
  const match = /^agent:(.+)$/u.exec(label);
  if (match) {
    // 标签可带细节后缀：agent:<tool>:<detail>（如 agent:foundation_write:建角色 顾长风）。
    // 按**首个**冒号拆，tool 人话化 + 带上细节，让操作历史能分辨同类多次写入（rerun2 P2：几十条「资料写入」不可辨）。
    const rest = match[1]!;
    const sep = rest.indexOf(":");
    const tool = sep >= 0 ? rest.slice(0, sep) : rest;
    const detail = sep >= 0 ? rest.slice(sep + 1).trim() : "";
    const base = UNDO_TOOL_LABELS[tool] ?? tool;
    return detail ? `${base}：${detail}` : base;
  }
  return label;
}

/**
 * 撤销「上一步真实改动」：恢复到最近一个『内容与当前工作树不同、且非撤销产物』的检查点。
 * 每个 agent 写操作前都建检查点（runWithSnapshot/createSnapshot），故恢复到最近一个 differing 检查点即撤销上一步；
 * 跳过恢复操作自身的产物，使「连续撤销」逐步回退、不卡在原地。无可撤销改动 → null（诚实，调用方据此如实回报）。
 * restoreSnapshot 会先存档当前态，故「撤销」本身也能被再撤销，历史永不丢。
 *
 * R7.2：带 turnHint（前端「上一个有写盘回合的首个快照」= 该回合第一次写盘前）时优先整回合回退——
 * 作者说「撤销上一步」指的是上一回合的全部改动，默认按工具步回退会把一回合改的两处只撤掉最后一处。
 * 锚点不在回看窗口里 / 与当前工作树一致（已撤过）→ 落回默认逐步回退，viaTurnHint=false 如实标记。
 */
export interface TurnUndoHint {
  /** 上一个有写盘回合第一次写盘前的快照 id（git commit）。 */
  readonly snapshotId: string;
  /** 该回合写盘改动的处数，供调用方回执「只撤了最后 1 处」时说清 N。 */
  readonly changes: number;
}

export async function undoLastChange(
  projectDir: string,
  turnHint?: TurnUndoHint,
): Promise<{
  readonly undoneLabel: string;
  readonly restored: SnapshotEntry;
  /** 这次撤销实际退回的文件（R4.2：回执要写清，不能只说「只撤了这一步」）。 */
  readonly reverted: readonly CommitFileChange[];
  /** 其中「撤的那一步之后才写的」——连带退回，回执要单独说明。 */
  readonly revertedLater: readonly CommitFileChange[];
  /** true=按前端带的整回合锚点回退；false=默认逐步回退（hint 缺失/失效，或已撤到锚点继续往前走）。 */
  readonly viaTurnHint: boolean;
} | null> {
  await ensureSnapshotRepo(projectDir);
  const snaps = await listSnapshots(projectDir, 200);
  const untracked = await hasUntrackedFiles(projectDir);
  if (turnHint && snaps.some((snap) => snap.id === turnHint.snapshotId)) {
    // 与当前工作树一致（这回合已整回合撤过）→ 不重复 no-op 恢复，落回默认逻辑继续往前走（连续撤销）。
    if (await snapshotDiffersFromWorkingTree(projectDir, turnHint.snapshotId, untracked)) {
      const outcome = await restoreSnapshot(projectDir, turnHint.snapshotId);
      return { undoneLabel: "上一回合全部改动", ...outcome, viaTurnHint: true };
    }
  }
  const trees = await readCommitTrees(projectDir, 200);
  let lostRestoreTarget = false;
  const findTarget = async (followRestores: boolean): Promise<SnapshotEntry | undefined> => {
    // 连续撤销要接着往回走：遇到「恢复到：X」就跳到它恢复的那个存档点 X 之下再找。
    // 否则第三次撤销会把第一次撤掉的那步又恢复回来（在两个状态之间来回跳，2026-10-07 真机实锤）。
    // 认 X 用「标签相同 + 内容树相同」，裁剪历史改写了提交 hash 也认得出。
    let skipTo: { readonly label: string; readonly tree: string } | null = null;
    for (const snap of snaps) {
      if (skipTo) {
        if (snap.label === skipTo.label && trees.get(snap.id) === skipTo.tree) skipTo = null;
        continue;
      }
      // 不猜白名单：自家格式
      const restored = /^恢复到：(.+)$/u.exec(snap.label);
      if (followRestores && restored) {
        const tree = trees.get(snap.id);
        if (tree) skipTo = { label: restored[1]!, tree };
        continue;
      }
      if (isUndoSkippableArtifact(snap.label)) continue;
      if (await snapshotDiffersFromWorkingTree(projectDir, snap.id, untracked)) return snap;
    }
    if (skipTo) lostRestoreTarget = true;
    return undefined;
  };
  // 恢复目标在回看窗口外认不出时，才退回老规则（最近一个与当前不同的存档点），不误报「没有可撤销的」；
  // 认出来了、只是下面没有更早的改动 = 真到头了，如实返回 null。
  const target = (await findTarget(true)) ?? (lostRestoreTarget ? await findTarget(false) : undefined);
  if (!target) return null;
  const { restored, reverted, revertedLater } = await restoreSnapshot(projectDir, target.id);
  return { undoneLabel: humanizeUndoLabel(target.label), restored, reverted, revertedLater, viaTurnHint: false };
}

// ---------------------------------------------------------------------------
// 磁盘治理：历史裁剪（append-only「历史永不丢」保留，但旧史折叠成 base 提交，给磁盘一个收口）
// ---------------------------------------------------------------------------

/** 默认保留窗口：对齐 undoLastChange 的撤销回看窗口（200），裁掉它之外的历史不破坏撤销语义。 */
export const SNAPSHOT_PRUNE_DEFAULT_KEEP = 200;
/** keep 下限夹逼：防误传小值把历史裁光。 */
export const SNAPSHOT_PRUNE_MIN_KEEP = 20;

const PRUNE_BASE_LABEL_PREFIX = "base: 已裁剪";
// 不猜白名单：自家格式
const PRUNE_BASE_LABEL_PATTERN = new RegExp(`^${PRUNE_BASE_LABEL_PREFIX} (\\d+) 条更早快照$`, "u");

export interface SnapshotPruneOptions {
  /** 保留最近多少条快照（默认 200，下限夹逼到 20） */
  readonly keep?: number;
  /** true 只预览不落盘；缺省即 true（保守），真裁须显式传 false */
  readonly dryRun?: boolean;
  /** bundle 备份目录，默认 ~/.story-engine/snapshot-backups/（在项目目录之外） */
  readonly backupDir?: string;
}

export interface SnapshotPruneResult {
  readonly dryRun: boolean;
  readonly keep: number;
  /** 裁前 HEAD 链全部提交数（含既有 base 提交） */
  readonly totalBefore: number;
  /** 本次折进 base 的更早快照条数；0 = no-op（dry-run 时为预计值） */
  readonly prunedCount: number;
  /** 裁后提交总数（dry-run 为预计值）= totalBefore - prunedCount + 1 */
  readonly totalAfter: number;
  /** 净释放的提交数 = prunedCount - 1（被裁条目折成一条 base） */
  readonly freedCommits: number;
  /** 真裁时新建的 base 提交 id */
  readonly baseCommitId?: string;
  /** 真裁时裁前完整历史的 bundle 备份路径 */
  readonly backupBundlePath?: string;
  /** 非致命降级警告：update-ref 成功（裁剪已完成）后 reflog expire / gc 回收失败时如实写在这里 */
  readonly warnings?: readonly string[];
}

function clampPruneKeep(keep: number | undefined): number {
  if (keep === undefined || !Number.isFinite(keep)) return SNAPSHOT_PRUNE_DEFAULT_KEEP;
  return Math.max(SNAPSHOT_PRUNE_MIN_KEEP, Math.trunc(keep));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const GIT_IN_FLIGHT_MARKERS = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "REBASE_HEAD",
  "rebase-merge",
  "rebase-apply",
  "index.lock",
] as const;

/** 裁剪前健康校验：git 可用（rev-parse 不过即抛）、在分支上（游离 HEAD 拒绝）、无 in-flight 合并/变基/拣选/锁。 */
async function assertRepoHealthyForPrune(projectDir: string): Promise<string> {
  const gitDir = await git(projectDir, ["rev-parse", "--absolute-git-dir"]);
  let branch = "";
  try {
    branch = await git(projectDir, ["symbolic-ref", "-q", "--short", "HEAD"]);
  } catch {
    branch = "";
  }
  if (!branch) throw new Error("快照仓库不在分支上（游离 HEAD），拒绝裁剪历史。");
  for (const marker of GIT_IN_FLIGHT_MARKERS) {
    if (await pathExists(join(gitDir, marker))) {
      throw new Error(`快照仓库存在未完成的 git 操作（${marker}），拒绝裁剪历史。`);
    }
  }
  return branch;
}

interface RawCommitMeta {
  readonly id: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly authorTs: string;
  readonly committerName: string;
  readonly committerEmail: string;
  readonly committerTs: string;
  readonly message: string;
}

const LOG_META_FORMAT = "%H%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%B%x1e";

function parseLogMeta(out: string): RawCommitMeta[] {
  const commits: RawCommitMeta[] = [];
  for (const chunk of out.split("\x1e")) {
    const record = chunk.replace(/^\n+/u, "");
    if (!record.trim()) continue;
    const [id, authorName, authorEmail, authorTs, committerName, committerEmail, committerTs, ...rest] = record.split("\x1f");
    commits.push({
      id: id ?? "",
      authorName: authorName ?? "",
      authorEmail: authorEmail ?? "",
      authorTs: authorTs ?? "",
      committerName: committerName ?? "",
      committerEmail: committerEmail ?? "",
      committerTs: committerTs ?? "",
      message: rest.join("\x1f").replace(/\n+$/u, ""),
    });
  }
  return commits;
}

/** commit-tree 不读仓库 config 的 user.*，作者/提交者/时间戳全靠 env 注入——重放保留链时按原提交逐个带过去。 */
function commitEnv(commit: RawCommitMeta): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: commit.authorName || "StoryEngine",
    GIT_AUTHOR_EMAIL: commit.authorEmail || "snapshot@story-engine.local",
    GIT_AUTHOR_DATE: `${commit.authorTs} +0000`,
    GIT_COMMITTER_NAME: commit.committerName || "StoryEngine",
    GIT_COMMITTER_EMAIL: commit.committerEmail || "snapshot@story-engine.local",
    GIT_COMMITTER_DATE: `${commit.committerTs} +0000`,
  };
}

function snapshotBackupBundlePath(projectDir: string, backupDir: string): string {
  const projectHash = createHash("sha1").update(projectDir).digest("hex").slice(0, 8);
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  return join(backupDir, `snapshot-backup-${projectHash}-${stamp}.bundle`);
}

/**
 * 把快照 git 史裁到最近 keep 条：更早的 prunedCount 条压成一条 orphan base 提交
 * （承载被裁边界提交的完整 tree，消息「base: 已裁剪 N 条更早快照」），保留窗口内的撤销链逐条可用；
 * 更旧的不可逐条撤销，但 base 本身是合法恢复目标（完整状态不丢），裁前完整历史另有 bundle 备份兜底。
 *
 * 安全边界：全程只动 git 引用与对象库，绝不 checkout/reset——工作树（正稿文件）分毫不动。
 * 真裁前先把裁前完整历史打成 bundle 存到项目目录之外；引用用 CAS 更新（持锁期间 HEAD 被移动即失败中止）。
 * 只有 update-ref 本身（及其之前的建链步骤）失败才回滚分支引用到裁前 HEAD——此时旧链分毫未动，回滚是
 * no-op 级安全，bundle 仅作对象级兜底；update-ref 成功即视为裁剪完成（新链完整合法），其后的
 * reflog expire + gc 失败绝不回滚引用（旧链对象可能已被 gc 部分回收，回滚会让 HEAD 指向丢失对象、
 * 把可用仓库搞坏），只降级为 warning 写进返回值，磁盘晚点回收无妨。keep 不足 / 已有 base 之上真实快照数
 * ≤ keep 时 no-op（重复 prune 天然幂等）。reflog expire + gc 之后旧链才真正不可达、磁盘才真正回收。
 */
export async function pruneSnapshots(projectDir: string, options: SnapshotPruneOptions = {}): Promise<SnapshotPruneResult> {
  const keep = clampPruneKeep(options.keep);
  const dryRun = options.dryRun !== false;
  return withProjectLock(projectDir, async () => {
    await recoverProjectCommitTransactions(projectDir);
    await ensureRepoUnlocked(projectDir);
    const branch = await assertRepoHealthyForPrune(projectDir);

    const revs = (await git(projectDir, ["rev-list", "--reverse", "HEAD"])).split("\n").filter(Boolean);
    const rootSubject = await git(projectDir, ["log", "-1", "--pretty=format:%s", revs[0]!]);
    const rootIsBase = PRUNE_BASE_LABEL_PATTERN.test(rootSubject);
    // 既有 base 只占 1 条位、不参与「是否够裁」计数——重复 prune 因此是 no-op（幂等）。
    const snapshotCount = revs.length - (rootIsBase ? 1 : 0);
    if (snapshotCount <= keep) {
      return { dryRun, keep, totalBefore: revs.length, prunedCount: 0, totalAfter: revs.length, freedCommits: 0 };
    }
    const prunedCount = snapshotCount - keep;
    const firstPrunedIndex = rootIsBase ? 1 : 0;
    const boundaryId = revs[firstPrunedIndex + prunedCount - 1]!;
    // 裁后新链 = 保留窗口（revs.length - prunedCount - (rootIsBase ? 1 : 0)）+ 1 条新 base；
    // rootIsBase 时旧 base 一并出链（被新 base 顶替），别再把它算进裁后总数（复审实锤的 off-by-one）。
    const totalAfter = revs.length - prunedCount + (rootIsBase ? 0 : 1);
    const freedCommits = revs.length - totalAfter;

    if (dryRun) {
      return { dryRun, keep, totalBefore: revs.length, prunedCount, totalAfter, freedCommits };
    }

    const backupDir = options.backupDir ?? join(resolveGlobalDataDir(), "snapshot-backups");
    await mkdir(backupDir, { recursive: true });
    const bundlePath = snapshotBackupBundlePath(projectDir, backupDir);
    await git(projectDir, ["bundle", "create", bundlePath, "HEAD"]);

    const priorFolded = rootIsBase ? Number(PRUNE_BASE_LABEL_PATTERN.exec(rootSubject)?.[1] ?? 0) : 0;
    const baseLabel = `${PRUNE_BASE_LABEL_PREFIX} ${priorFolded + prunedCount} 条更早快照`;
    const boundaryMeta = parseLogMeta(await git(projectDir, ["log", "-1", `--pretty=format:${LOG_META_FORMAT}`, boundaryId]))[0]!;
    const baseTree = await git(projectDir, ["rev-parse", `${boundaryId}^{tree}`]);
    const baseCommitId = await git(projectDir, ["commit-tree", baseTree, "-m", baseLabel], commitEnv(boundaryMeta));

    // boundary..HEAD 恰为保留窗口（boundary 自身被裁、不入新链）
    const kept = parseLogMeta(await git(projectDir, ["log", "--reverse", `--pretty=format:${LOG_META_FORMAT}`, `${boundaryId}..HEAD`]));
    const oldHead = revs[revs.length - 1]!;
    const branchRef = `refs/heads/${branch}`;
    // update-ref 是全程唯一移动引用的步骤：它失败 = 旧链分毫未动（CAS 校验 oldHead，持锁期间 HEAD 被移动即拒绝），
    // 此时回滚到 oldHead 是 no-op 级安全；它成功即视为裁剪完成，之后的回收步骤失败不得再碰引用。
    try {
      let parent = baseCommitId;
      for (const commit of kept) {
        const tree = await git(projectDir, ["rev-parse", `${commit.id}^{tree}`]);
        parent = await git(projectDir, ["commit-tree", tree, "-p", parent, "-m", commit.message], commitEnv(commit));
      }
      await git(projectDir, ["update-ref", branchRef, parent, oldHead]);
    } catch (error) {
      await git(projectDir, ["update-ref", branchRef, oldHead]).catch(() => undefined);
      throw new Error(`快照历史裁剪失败，已恢复到裁前状态；裁前完整历史备份：${bundlePath}。原始错误：${error instanceof Error ? error.message : String(error)}`);
    }
    // 裁剪已完成：reflog expire / gc 只负责磁盘回收，失败降级为 warning（旧链对象暂留磁盘、仓库保持可用）。
    const warnings: string[] = [];
    try {
      await git(projectDir, ["reflog", "expire", "--expire=now", "--all"]);
      await git(projectDir, ["gc", "--prune=now", "--quiet"]);
    } catch (error) {
      warnings.push(`快照历史裁剪已完成，但旧对象回收失败（磁盘暂不释放，不影响仓库可用性，可稍后重试）：${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      dryRun,
      keep,
      totalBefore: revs.length,
      prunedCount,
      totalAfter,
      freedCommits,
      baseCommitId,
      backupBundlePath: bundlePath,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  });
}
