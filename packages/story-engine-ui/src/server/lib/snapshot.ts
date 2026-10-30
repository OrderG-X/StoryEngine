import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { recoverTransactions, REVISION_PATH, SAVED_COPIES_DIR, withBookLock } from "@actalk/story-core";

import { resolveGitCommand, resolveGlobalDataDir } from "./data-dirs.js";

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
 * 快照用 `git add -A` 把项目目录整个卷进去；对话、事务目录、统计这些不是写作状态，不进存档（存档只当撤销、整本恢复
 * 取前像的地方，写作版本 P2a 起撤销 / 恢复只按撤销范围的白名单写回，不从存档整份 checkout）。
 * 做法：写进 `<gitdir>/info/exclude`（不碰用户可见的 .gitignore）；旧书里已被跟踪的 `git rm --cached` 摘出索引（磁盘不动）。
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

/** 新核心的写盘事务目录：核心自己收拾，和旧引擎的 .story-engine-tx 同理。 */
const CORE_TX_DIR = ".story-core-tx";
const CORE_TX_MARKER = "# story-engine-ui: 新核心事务目录不入快照（核心自管）";
/** 新核心留证的东西（坏事务、镜像前的老文件原样）：撤销不能把它们抹掉。 */
const CORE_KEPT_DIR = ".story-core-kept";
const CORE_KEPT_MARKER = "# story-engine-ui: 新核心留证目录不入快照（撤销不抹证据）";
/** 收拾半截事务时另存的（P1 第 19 轮 AG3）：作者还没处理的稿，撤销不能把它们抹掉。 */
const CORE_SAVED_DIR = SAVED_COPIES_DIR;
const CORE_SAVED_MARKER = "# story-engine-ui: 恢复前另存的稿不入快照（撤销不抹作者的稿）";
/** 书的写入代次（写作版本 P1a）：撤销 / 恢复不能把它翻回去，恢复完换一个新的（按恢复前算的预览一律作废）。 */
const CORE_REVISION_DIR = dirname(REVISION_PATH);
const CORE_REVISION_MARKER = "# story-engine-ui: 写入代次不入快照（撤销不回退代次）";
/** 写作统计（P10）：撤销不回退统计，恢复后重数。 */
const WORD_STATS_DIR = ".story-engine-ui/stats";
const WORD_STATS_MARKER = "# story-engine-ui: 写作统计不入快照（撤销不回退统计）";

/** 快照排除的目录（info/exclude 一行）。 */
const SNAPSHOT_EXCLUSIONS: readonly { readonly dir: string; readonly line: string; readonly marker: string }[] = [
  { dir: SNAPSHOT_EXCLUDED_CHAT_SESSIONS_DIR, line: CHAT_SESSIONS_EXCLUDE_LINE, marker: CHAT_SESSIONS_EXCLUDE_MARKER },
  { dir: SNAPSHOT_EXCLUDED_TX_DIR, line: TX_EXCLUDE_LINE, marker: TX_EXCLUDE_MARKER },
  { dir: METRICS_EXCLUDE_DIR, line: `/${METRICS_EXCLUDE_DIR}/`, marker: METRICS_EXCLUDE_MARKER },
  { dir: AGENTS_EXCLUDE_DIR, line: `/${AGENTS_EXCLUDE_DIR}/`, marker: AGENTS_EXCLUDE_MARKER },
  { dir: CORE_TX_DIR, line: `/${CORE_TX_DIR}/`, marker: CORE_TX_MARKER },
  { dir: CORE_KEPT_DIR, line: `/${CORE_KEPT_DIR}/`, marker: CORE_KEPT_MARKER },
  { dir: CORE_SAVED_DIR, line: `/${CORE_SAVED_DIR}/`, marker: CORE_SAVED_MARKER },
  { dir: WORD_STATS_DIR, line: `/${WORD_STATS_DIR}/`, marker: WORD_STATS_MARKER },
  { dir: CORE_REVISION_DIR, line: `/${CORE_REVISION_DIR}/`, marker: CORE_REVISION_MARKER },
];

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

/** 一个提交的内容树号（回执记它，撤销从这里取前像）。 */
async function treeOfUnlocked(projectDir: string, commit: string): Promise<string> {
  return git(projectDir, ["rev-parse", `${commit}^{tree}`]);
}

/**
 * 写之前那一刻的树号，不进操作历史（写作版本 P2a）：不打存档点的命令（通读记账、存稿）、一批里第二条起的命令，回执也要树号。
 * 工作树和上一个存档一样就用它的树；不一样就打一个「落盘收尾」提交（操作历史、撤销都跳过它）留住这棵树（裁剪重建提交链照样留着）。
 */
async function hiddenTreeUnlocked(projectDir: string, label: string): Promise<string> {
  await ensureRepoUnlocked(projectDir);
  if (await hasUncommittedChanges(projectDir)) await createSnapshotUnlocked(projectDir, `${POST_WRITE_LABEL_PREFIX}${label}`);
  return treeOfUnlocked(projectDir, "HEAD");
}

/**
 * 存档类入口（建存档点、存档里写、恢复、裁剪）先收拾上次写到一半的事务；有收拾不了的就停下、不动稿、不报成功
 * （P1 第 22 轮 AJ3：恢复接口不看收拾结果，作者刚选的那版之后又被那份没退完的事务退掉）。老格式收拾不了照样抛。
 */
async function settleOrStop(projectDir: string): Promise<void> {
  const recovery = await recoverTransactions(projectDir);
  if (recovery.problems.length > 0) {
    throw Object.assign(new Error("上次写到一半的记录收拾不了，先不动这本书，免得丢数据。"), { code: "TX_RESIDUE" });
  }
}

/** 写入前调用：把当前全部状态存为一个快照。 */
export async function createSnapshot(projectDir: string, label: string): Promise<SnapshotEntry> {
  return withProjectLock(projectDir, async () => {
    await settleOrStop(projectDir);
    await ensureRepoUnlocked(projectDir);
    return createSnapshotUnlocked(projectDir, label);
  });
}

/** 交给核心 runCommand 的存档回调：返回写之前那一刻的树号；`"tree"` = 只要树号、不打存档点（核心 RunOptions.snapshot）。 */
export type CoreSnapshot = (label: string, command: string, mode?: "tree") => Promise<string>;

/**
 * 「真要写盘才打存档点」（重构 P9）：fn 拿到一个存档回调交给核心 runCommand——核心在书锁里、算出确实要写之后才调它，
 * 指错了、没变化、按钮点第二次（回执重放）都不打，操作历史里不会多出什么都没改的一条。
 * 一批里多条命令只打第一次（一批改动撤销一步）；有 fixedLabel 就用它，没有就用核心给的命令名 + 人话。
 * 每次都返回写之前那一刻的树号（第二条起、只要树号的打不进操作历史的存档，hiddenTreeUnlocked）。
 * 整段在同一把书锁里，写完照 runWithSnapshot 落盘收尾，撤销不会插进中间。
 */
export async function runWithLazySnapshot<T>(
  projectDir: string,
  fn: (snapshot: CoreSnapshot) => Promise<T>,
  fixedLabel?: string,
): Promise<{ readonly snapshotId?: string; readonly result: T }> {
  return withProjectLock(projectDir, async () => {
    // 老格式事务（升级前崩溃留下的）先收拾，再进核心命令：收拾会换写入代次，核心随后核依据就对得上真相；
    // 留到要打存档点才收拾，核心已经照没收拾的半截真相核过依据了（第 4 轮复核 R9）。
    await settleOrStop(projectDir);
    let taken: SnapshotEntry | undefined;
    const result = await fn(async (label, command, mode) => {
      if (taken || mode === "tree") return hiddenTreeUnlocked(projectDir, coreSnapshotLabel(command, label));
      await ensureRepoUnlocked(projectDir);
      taken = await createSnapshotUnlocked(projectDir, fixedLabel ?? coreSnapshotLabel(command, label));
      return treeOfUnlocked(projectDir, taken.id);
    });
    if (taken && (await hasUncommittedChanges(projectDir))) {
      await createSnapshotUnlocked(projectDir, `${POST_WRITE_LABEL_PREFIX}${taken.label}`);
    }
    return { ...(taken ? { snapshotId: taken.id } : {}), result };
  });
}

/** 一个存档点的树号和标签（整本恢复按它算）；存档点不在了（裁剪换过号、号不对）返回 undefined。 */
export async function snapshotInfoOf(projectDir: string, id: string): Promise<{ readonly tree: string; readonly label: string } | undefined> {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(id)) return undefined;
  return withProjectLock(projectDir, async () => {
    await ensureRepoUnlocked(projectDir);
    const tree = await git(projectDir, ["rev-parse", "--verify", "--quiet", `${id}^{tree}`]).catch(() => "");
    if (!tree) return undefined;
    const label = await git(projectDir, ["log", "-1", "--pretty=format:%s", id]);
    return { tree, label };
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
 * 落盘收尾 commit 前缀（afterfix #2）：写完把产物即时收进 git 的那条工程 commit（也留住回执要的树号，hiddenTreeUnlocked）。
 * 不是作者的动作：操作历史据此过滤、不显这条。
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

/** 工作树是否有任何未提交改动（含未跟踪文件）——决定写操作后是否需要补一条落盘收尾 commit。 */
async function hasUncommittedChanges(projectDir: string): Promise<boolean> {
  const out = await git(projectDir, ["status", "--porcelain"]);
  return out.trim().length > 0;
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
  "ledger.migrate": "bible",
  "draft.applyGenerated": "draft",
  "draft.adoptCandidate": "draft",
  "card.write": "bible",
  "card.fill": "bible",
  "cards.import": "bible",
  "settle.apply": "commit",
  "history.apply": "restore",
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

/** 交给核心 runCommand / ensureBookOnCore 的存档回调（标签带上命令名），返回写之前那一刻的树号。 */
export function coreSnapshotFor(projectDir: string): CoreSnapshot {
  return (label, command, mode) => withProjectLock(projectDir, async () => {
    if (mode === "tree") {
      await settleOrStop(projectDir);
      return hiddenTreeUnlocked(projectDir, coreSnapshotLabel(command, label));
    }
    const entry = await createSnapshot(projectDir, coreSnapshotLabel(command, label));
    return treeOfUnlocked(projectDir, entry.id);
  });
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

// ---------------------------------------------------------------------------
// 磁盘治理：历史裁剪（写作版本 P2a 片 4C，设计 8.3：先算、再做，对账只认两个号）
// ---------------------------------------------------------------------------

/** 默认保留最近多少条存档。 */
export const SNAPSHOT_PRUNE_DEFAULT_KEEP = 200;
/** keep 下限夹逼：防误传小值把历史裁光。 */
export const SNAPSHOT_PRUNE_MIN_KEEP = 20;

const PRUNE_BASE_LABEL_PREFIX = "base: 已裁剪";
// 不猜白名单：自家格式
const PRUNE_BASE_LABEL_PATTERN = new RegExp(`^${PRUNE_BASE_LABEL_PREFIX} (\\d+) 条更早快照$`, "u");

export function clampPruneKeep(keep: number | undefined): number {
  if (keep === undefined || !Number.isFinite(keep) || keep <= 0) return SNAPSHOT_PRUNE_DEFAULT_KEEP;
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

/** 裁前完整历史的备份放哪（项目目录外）：按书和这次裁剪定，同一次裁剪重来还是这个文件。 */
export function snapshotBackupBundlePath(projectDir: string, key: string, backupDir = join(resolveGlobalDataDir(), "snapshot-backups")): string {
  const projectHash = createHash("sha1").update(projectDir).digest("hex").slice(0, 8);
  const keyHash = createHash("sha1").update(key).digest("hex").slice(0, 12);
  return join(backupDir, `snapshot-backup-${projectHash}-${keyHash}.bundle`);
}

/** 算好的一次裁剪（存进操作的检查点）：裁前链头、分界、确定的新链头。 */
export interface PrunePlan {
  readonly keep: number;
  readonly branch: string;
  readonly oldHead: string;
  /** 被裁的最后一条（新 base 承载它的树）。 */
  readonly boundaryId: string;
  readonly newHead: string;
  /** 裁前提交数（含既有 base）。 */
  readonly totalBefore: number;
  /** 折进 base 的条数。 */
  readonly prunedCount: number;
  readonly totalAfter: number;
}

export type PrunePlanOutcome =
  | { readonly kind: "noop"; readonly keep: number; readonly totalBefore: number }
  | { readonly kind: "plan"; readonly plan: PrunePlan };

/**
 * 按分界重建新链：更早的折成一条 base（承载分界的树，消息「base: 已裁剪 N 条更早快照」），保留窗口逐条按原树、原作者 / 提交时间、
 * 原说明重放。同样的分界算出同样的新链（提交号是确定的）。只写 git 对象（没有引用指着之前都是悬空的），不动引用、不动工作树。
 */
async function buildPrunedChain(projectDir: string, boundaryId: string, rootSubject: string, prunedCount: number): Promise<string> {
  const priorFolded = PRUNE_BASE_LABEL_PATTERN.test(rootSubject) ? Number(PRUNE_BASE_LABEL_PATTERN.exec(rootSubject)?.[1] ?? 0) : 0;
  const baseLabel = `${PRUNE_BASE_LABEL_PREFIX} ${priorFolded + prunedCount} 条更早快照`;
  const boundaryMeta = parseLogMeta(await git(projectDir, ["log", "-1", `--pretty=format:${LOG_META_FORMAT}`, boundaryId]))[0]!;
  const baseTree = await git(projectDir, ["rev-parse", `${boundaryId}^{tree}`]);
  let parent = await git(projectDir, ["commit-tree", baseTree, "-m", baseLabel], commitEnv(boundaryMeta));
  // boundary..oldHead 恰为保留窗口（boundary 自身被裁、不入新链）
  const kept = parseLogMeta(await git(projectDir, ["log", "--reverse", `--pretty=format:${LOG_META_FORMAT}`, `${boundaryId}..HEAD`]));
  for (const commit of kept) {
    const tree = await git(projectDir, ["rev-parse", `${commit.id}^{tree}`]);
    parent = await git(projectDir, ["commit-tree", tree, "-p", parent, "-m", commit.message], commitEnv(commit));
  }
  return parent;
}

/**
 * 算一次裁剪（不动引用、不动工作树）：存档数不超过 keep（既有 base 不算一条）就不用裁；否则定分界、算出确定的新链头。
 */
export async function planPrune(projectDir: string, keepInput?: number): Promise<PrunePlanOutcome> {
  const keep = clampPruneKeep(keepInput);
  return withProjectLock(projectDir, async () => {
    await settleOrStop(projectDir);
    await ensureRepoUnlocked(projectDir);
    const branch = await assertRepoHealthyForPrune(projectDir);
    const revs = (await git(projectDir, ["rev-list", "--reverse", "HEAD"])).split("\n").filter(Boolean);
    const rootSubject = await git(projectDir, ["log", "-1", "--pretty=format:%s", revs[0]!]);
    const rootIsBase = PRUNE_BASE_LABEL_PATTERN.test(rootSubject);
    // 既有 base 只占 1 条位、不参与「是否够裁」计数——重复裁剪因此不用再裁。
    const snapshotCount = revs.length - (rootIsBase ? 1 : 0);
    if (snapshotCount <= keep) return { kind: "noop", keep, totalBefore: revs.length };
    const prunedCount = snapshotCount - keep;
    const boundaryId = revs[(rootIsBase ? 1 : 0) + prunedCount - 1]!;
    // 裁后新链 = 保留窗口 + 1 条新 base；rootIsBase 时旧 base 一并出链（被新 base 顶替）。
    const totalAfter = revs.length - prunedCount + (rootIsBase ? 0 : 1);
    const newHead = await buildPrunedChain(projectDir, boundaryId, rootSubject, prunedCount);
    return { kind: "plan", plan: { keep, branch, oldHead: revs[revs.length - 1]!, boundaryId, newHead, totalBefore: revs.length, prunedCount, totalAfter } };
  });
}

export type PruneApplyOutcome =
  | { readonly kind: "done"; readonly warnings: readonly string[] }
  /** 存档链在算好之后动过（又多了存档、别处改过）：一处没动，重新算。 */
  | { readonly kind: "moved" };

/**
 * 照算好的裁：书锁里看分支现在指着谁，只认两个号（设计 8.3）——
 * - 新链头：已经裁完（之前崩在回收那步），只补回收；
 * - 裁前链头：按同一个分界重建，核出来的链头 = 记下的新链头（对不上停下、如实说），裁前完整历史打成备份（项目目录外），
 *   再比较交换移引用；
 * - 都不是：存档链在这期间动过，一处不动。
 * 引用移成了就算裁完：之后的 reflog expire / gc 只管回收磁盘，失败只记一句，绝不再碰引用。全程不动工作树。
 */
export async function applyPrune(projectDir: string, plan: PrunePlan, bundlePath: string): Promise<PruneApplyOutcome> {
  return withProjectLock(projectDir, async () => {
    await settleOrStop(projectDir);
    const branch = await assertRepoHealthyForPrune(projectDir);
    if (branch !== plan.branch) return { kind: "moved" };
    const branchRef = `refs/heads/${branch}`;
    const head = await git(projectDir, ["rev-parse", branchRef]);
    if (head !== plan.newHead) {
      if (head !== plan.oldHead) return { kind: "moved" };
      const revs = (await git(projectDir, ["rev-list", "--reverse", "HEAD"])).split("\n").filter(Boolean);
      const rootSubject = await git(projectDir, ["log", "-1", "--pretty=format:%s", revs[0]!]);
      const rebuilt = await buildPrunedChain(projectDir, plan.boundaryId, rootSubject, plan.prunedCount);
      if (rebuilt !== plan.newHead) throw new Error("重建出来的存档链和算好的对不上，没裁。");
      await mkdir(dirname(bundlePath), { recursive: true });
      await git(projectDir, ["bundle", "create", bundlePath, "HEAD"]);
      // 比较交换：引用还是裁前链头才移（不是就失败、一处没动）。
      await git(projectDir, ["update-ref", branchRef, plan.newHead, plan.oldHead]);
    }
    const warnings: string[] = [];
    try {
      await git(projectDir, ["reflog", "expire", "--expire=now", "--all"]);
      await git(projectDir, ["gc", "--prune=now", "--quiet"]);
    } catch (error) {
      warnings.push(`裁好了，但旧存档占的空间这次没收回来（不影响使用，下次裁剪再收）：${error instanceof Error ? error.message : String(error)}`);
    }
    return { kind: "done", warnings };
  });
}
