import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { recoverProjectCommitTransactions, withProjectCommitLock } from "@actalk/story-engine";

import { resolveGitCommand, resolveGlobalDataDir } from "./data-dirs.js";

const execFileAsync = promisify(execFile);

export interface SnapshotEntry {
  /** git commit hash，恢复时用 */
  readonly id: string;
  /** 操作描述，如"入库前快照：第12章" */
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
    ...args,
  ];
  const { stdout } = env === undefined
    ? await execFileAsync(resolveGitCommand(), argv)
    : await execFileAsync(resolveGitCommand(), argv, { encoding: "utf-8", env: { ...process.env, ...env } });
  return stdout.trim();
}

async function withProjectLock<T>(projectDir: string, fn: () => Promise<T>): Promise<T> {
  return withProjectCommitLock(projectDir, fn);
}

function parseLogLine(line: string): SnapshotEntry {
  const [id, ts, ...rest] = line.split("\t");
  return { id: id ?? "", timestamp: Number(ts ?? 0), label: rest.join("\t") };
}

/** 不加锁的内部版本，供已持锁的导出函数复用，避免同模块重入死锁。 */
async function ensureRepoUnlocked(projectDir: string): Promise<void> {
  try {
    await access(join(projectDir, ".git"));
    return;
  } catch {
    // 还不是仓库，初始化
  }
  await git(projectDir, ["init"]);
  await git(projectDir, ["config", "user.name", "StoryEngine"]);
  await git(projectDir, ["config", "user.email", "snapshot@story-engine.local"]);
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

export async function listSnapshots(projectDir: string, limit = 100): Promise<SnapshotEntry[]> {
  return withProjectLock(projectDir, async () => {
    await ensureRepoUnlocked(projectDir);
    const out = await git(projectDir, ["log", `-${limit}`, `--pretty=format:${LOG_FORMAT}`]);
    return out ? out.split("\n").map(parseLogLine) : [];
  });
}

/**
 * 恢复到目标快照。先校验目标存在，再把当前状态自动存档（可反悔），
 * 然后删掉目标之后新增的文件、还原全部内容，最后记一条"恢复到：X"。
 * 历史永不丢失，恢复操作本身也能被恢复。
 */
export async function restoreSnapshot(projectDir: string, id: string): Promise<SnapshotEntry> {
  return withProjectLock(projectDir, async () => {
    if (!/^[0-9a-f]{40}$/.test(id)) {
      throw new Error("无效的快照 id");
    }
    // Recovery must happen before git add/commit/checkout; otherwise a partial
    // formal transaction becomes part of the pre-restore history and may be
    // resurrected by a later undo.
    await recoverProjectCommitTransactions(projectDir);
    await ensureRepoUnlocked(projectDir);
    // 先解析目标：失败即抛，不污染历史
    const target = parseLogLine(await git(projectDir, ["log", "-1", `--pretty=format:${LOG_FORMAT}`, id]));
    await git(projectDir, ["add", "-A"]);
    await git(projectDir, ["commit", "--allow-empty", "-m", "恢复前自动快照"]);
    // --no-renames：禁用 rename 侦测，改名产生的新文件按 A 计，否则会被判为 R 而残留
    const addedSince = await git(projectDir, ["diff", "--name-only", "--no-renames", "--diff-filter=A", `${id}..HEAD`]);
    for (const file of addedSince.split("\n").filter(Boolean)) {
      await unlink(join(projectDir, file)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
    await git(projectDir, ["checkout", id, "--", "."]);
    await git(projectDir, ["add", "-A"]);
    await git(projectDir, ["commit", "--allow-empty", "-m", `恢复到：${target.label}`]);
    return parseLogLine(await git(projectDir, ["log", "-1", `--pretty=format:${LOG_FORMAT}`]));
  });
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
export function isPostWriteSettlementSnapshot(label: string): boolean {
  return label.startsWith(POST_WRITE_LABEL_PREFIX);
}

/** 逐步撤销时要跳过的工程产物：恢复产物 + 落盘收尾 commit。 */
function isUndoSkippableArtifact(label: string): boolean {
  return isRestoreArtifact(label) || isPostWriteSettlementSnapshot(label);
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
    await git(projectDir, ["diff", "--quiet", id, "--"]);
    return false; // exit 0：无差异
  } catch {
    return true; // 非零：有差异
  }
}

const UNDO_TOOL_LABELS: Record<string, string> = {
  commit_apply: "定稿",
  foundation_write: "更新故事资料",
  generate_draft: "出稿",
  revise_draft: "修改草稿",
  generate_chapter_steering: "章节方向",
  generate_worldbuilding: "完善世界观",
  generate_character_enrichment: "完善角色",
  generate_asset_enrichment: "完善道具与资源",
  generate_location_enrichment: "完善地点",
  generate_matrix_enrichment: "完善角色关系",
  generate_character_relationships: "完善人物关系",
  generate_writing_rules_enrichment: "重新整理写作规则",
  generate_alias_table: "完善别名表",
  edit_fact_ledger: "记录故事事实",
  set_foreshadowing_importance: "伏笔重要度",
  resolve_thread: "线索收口",
  clean_legacy_threads: "线索清理",
  group_related_leads: "线索归并",
};

/**
 * 把快照 label（agent:<toolId> / 恢复产物 / 自定义）转成给用户看的中文动作名。
 * 操作历史面板经路由层用它把原始 git subject 人话化（snapshots.ts），undo 也用它回报。
 * 恢复产物形如「恢复到：agent:commit_apply」——前缀剥开后对内层再 humanize，杜绝中间露出 agent: 工程标签。
 */
export function humanizeUndoLabel(label: string): string {
  const restoreMatch = /^恢复到：(.+)$/u.exec(label);
  if (restoreMatch) return `恢复到：${humanizeUndoLabel(restoreMatch[1]!)}`;
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
 */
export async function undoLastChange(
  projectDir: string,
): Promise<{ readonly undoneLabel: string; readonly restored: SnapshotEntry } | null> {
  await ensureSnapshotRepo(projectDir);
  const snaps = await listSnapshots(projectDir, 200);
  const untracked = await hasUntrackedFiles(projectDir);
  let target: SnapshotEntry | undefined;
  for (const snap of snaps) {
    if (isUndoSkippableArtifact(snap.label)) continue;
    if (await snapshotDiffersFromWorkingTree(projectDir, snap.id, untracked)) {
      target = snap;
      break;
    }
  }
  if (!target) return null;
  const restored = await restoreSnapshot(projectDir, target.id);
  return { undoneLabel: humanizeUndoLabel(target.label), restored };
}

// ---------------------------------------------------------------------------
// 磁盘治理：历史裁剪（append-only「历史永不丢」保留，但旧史折叠成 base 提交，给磁盘一个收口）
// ---------------------------------------------------------------------------

/** 默认保留窗口：对齐 undoLastChange 的撤销回看窗口（200），裁掉它之外的历史不破坏撤销语义。 */
export const SNAPSHOT_PRUNE_DEFAULT_KEEP = 200;
/** keep 下限夹逼：防误传小值把历史裁光。 */
export const SNAPSHOT_PRUNE_MIN_KEEP = 20;

const PRUNE_BASE_LABEL_PREFIX = "base: 已裁剪";
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
      throw new Error(`快照历史裁剪失败，已回滚到裁前状态；裁前完整历史备份：${bundlePath}。原始错误：${error instanceof Error ? error.message : String(error)}`);
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
