/**
 * 操作历史「查看改动」：把一个存档点之后紧跟着落盘的文件，翻成作者看得懂的几行话。
 *
 * 存档点是「操作之前」打的（标签写的是接下来要做的事），操作写出的文件落在比它新的下一个提交里
 * （通常是「落盘收尾」，没有收尾时就是下一个存档点）。「恢复到：…」例外：它本身就是恢复的结果。
 * 纯确定性、题材中立；角色只报名字，解析不到用中性说法，绝不吐 char-xxxx。
 */
import { humanizeUndoLabel, type CommitFileChange, type SnapshotEntry } from "./snapshot.js";

/** 资料文件 → 设定本里的叫法（顺序即展示顺序）。 */
const AREA_FILES: readonly (readonly [RegExp, string])[] = [
  [/^story\/character-bible\.json$/u, "角色设定"],
  [/^story\/character-matrix\.json$/u, "角色关系"],
  [/^story\/(?:threads|hooks)\.json$/u, "伏笔与线索"],
  [/^timeline\/events\.json$/u, "时间线"],
  [/^story\/arc-goals\.json$/u, "主线目标"],
  [/^(?:story\/world-bible|world\/core)\.json$/u, "世界观"],
  [/^world\/state\.json$/u, "世界状态"],
  [/^story\/location-bible\.json$/u, "地点"],
  [/^story\/assets\.json$/u, "道具与资源"],
  [/^story\/writing-rules\.json$/u, "写作规则"],
  [/^time\/calendar\.json$/u, "故事日历"],
  [/^story\/fact-ledger\.json$/u, "硬事实账本"],
  [/^(?:story\/(?:bible|core)|project)\.json$/u, "书的基本设定"],
];

const MAX_LINES = 8;

function chapterList(numbers: readonly number[]): string {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  return `第 ${sorted.join("、")} 章`;
}

function nameList(names: readonly string[]): string {
  const unique = [...new Set(names)];
  return unique.length > 3 ? `${unique.slice(0, 3).join("、")} 等 ${unique.length} 个角色` : unique.join("、");
}

/**
 * 一组改动文件 → 人话行。内部文件（工作台记录、诊断、事务归档、对话）不列。
 * nameById：角色 id → 名字；解析不到的角色并成「其他角色」。
 */
export function describeSnapshotChanges(
  files: readonly CommitFileChange[],
  nameById: ReadonlyMap<string, string>,
): string[] {
  const committed = { added: [] as number[], changed: [] as number[], removed: [] as number[] };
  const drafts: number[] = [];
  const plans: number[] = [];
  const newCharacters: string[] = [];
  const updatedCharacters: string[] = [];
  let unknownCharacter = false;
  const areas = new Set<string>();

  for (const { status, path } of files) {
    const chapter = /^chapters\/(\d+)\.md$/u.exec(path);
    if (chapter) {
      const n = Number(chapter[1]);
      (status === "A" ? committed.added : status === "D" ? committed.removed : committed.changed).push(n);
      continue;
    }
    const plan = /^drafts\/plans\/chapter-(\d+)\.json$/u.exec(path);
    if (plan) {
      plans.push(Number(plan[1]));
      continue;
    }
    const draft = /^drafts\/[^/]+\/chapter-(\d+)\.md$/u.exec(path);
    if (draft) {
      drafts.push(Number(draft[1]));
      continue;
    }
    const character = /^characters\/([^/]+)\/([^/]+)$/u.exec(path);
    if (character) {
      const name = nameById.get(character[1]!);
      if (!name) { unknownCharacter = true; continue; }
      if (status === "A" && character[2] === "core.json") newCharacters.push(name);
      else updatedCharacters.push(name);
      continue;
    }
    const area = AREA_FILES.find(([pattern]) => pattern.test(path));
    if (area) areas.add(area[1]);
  }

  const lines: string[] = [];
  if (committed.added.length) lines.push(`正文：${chapterList(committed.added)}写入定稿`);
  if (committed.changed.length) lines.push(`正文：${chapterList(committed.changed)}的定稿有改动`);
  if (committed.removed.length) lines.push(`正文：${chapterList(committed.removed)}的定稿被移除`);
  if (drafts.length) lines.push(`工作稿：${chapterList(drafts)}有改动`);
  if (plans.length) lines.push(`章纲：${chapterList(plans)}有改动`);
  if (newCharacters.length) lines.push(`新增角色：${nameList(newCharacters)}`);
  const updated = updatedCharacters.filter((name) => !newCharacters.includes(name));
  if (updated.length) lines.push(`角色：${nameList(updated)} 的资料有更新`);
  else if (unknownCharacter && !newCharacters.length) lines.push("角色资料有更新");
  // 新增/更新了角色时，角色册本身的改动不再单列一行。
  if (newCharacters.length || updated.length || unknownCharacter) areas.delete("角色设定");
  for (const [, label] of AREA_FILES) {
    if (areas.has(label)) { lines.push(`${label}有更新`); areas.delete(label); }
  }
  return lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES - 1), `还有 ${lines.length - MAX_LINES + 1} 处改动`] : lines;
}

/**
 * 给操作历史的每个存档点配上「这之后改了什么」。entries 是 git log 原始顺序（新→旧，含落盘收尾），
 * 须在过滤落盘收尾之前调用。认不出改动的条目不带 changes 字段（界面就不出「查看改动」）。
 */
export function attachSnapshotChanges(
  entries: readonly SnapshotEntry[],
  filesById: ReadonlyMap<string, readonly CommitFileChange[]>,
  nameById: ReadonlyMap<string, string>,
): (SnapshotEntry & { readonly changes?: readonly string[] })[] {
  return entries.map((entry, index) => {
    const newer = index > 0 ? entries[index - 1] : undefined;
    let files: readonly CommitFileChange[] | undefined;
    if (entry.label.startsWith("恢复到：")) files = filesById.get(entry.id);
    // 「恢复前自动快照」之后紧跟的就是恢复本身——改动记在「恢复到：…」那条上，这里不重复列。
    else if (newer && !newer.label.startsWith("恢复到：")) files = filesById.get(newer.id);
    const changes = files ? describeSnapshotChanges(files, nameById) : [];
    return changes.length ? { ...entry, changes } : entry;
  });
}

const OP_NAMES: Readonly<Record<string, string>> = {
  "抽卡选用候选": "选用候选稿",
  "工作稿生成": "生成工作稿",
  "草稿生成": "生成工作稿",
  "自动去AI味": "自动去 AI 味",
  "入库": "定稿",
  "修订应用": "应用修改",
  "一键去 AI 味": "一键去 AI 味",
};

/* ---------------------------------------------------------------------------
 * 撤销/恢复回执（R4.2·验收 3.2）：把「这次实际退回了什么」翻成人话。
 *
 * 真机实锤：撤销把首稿之后新增的第 5 章草稿一并删了，工具只说「只撤了这一步」，
 * 模型顺着编了一句「第 5 章草稿没受影响」。回执必须列出实际退回的每样东西，
 * 超出所撤步骤本身的单独说明，并告诉作者去哪找回。纯函数、题材中立、不吐裸 id。
 * ------------------------------------------------------------------------- */

/** 撤销回执用的短语（与 AREA_FILES 同一批路径，但更短：回执里是名词不是整句）。顺序即展示顺序。 */
const REVERT_AREA_FILES: readonly (readonly [RegExp, string])[] = [
  [/^story\/character-bible\.json$/u, "角色名册"],
  [/^story\/character-matrix\.json$/u, "角色关系"],
  [/^story\/(?:threads|hooks)\.json$/u, "线索"],
  [/^timeline\/events\.json$/u, "时间线"],
  [/^story\/arc-goals\.json$/u, "主线目标"],
  [/^(?:story\/(?:bible|core)|project)\.json$/u, "书的基本设定"],
  [/^(?:story\/world-bible|world\/core)\.json$/u, "世界观"],
  [/^world\/state\.json$/u, "世界状态"],
  [/^story\/location-bible\.json$/u, "地点设定"],
  [/^story\/assets\.json$/u, "道具与资源"],
  [/^story\/writing-rules\.json$/u, "写作规则"],
  [/^time\/calendar\.json$/u, "故事日历"],
  [/^story\/fact-ledger\.json$/u, "账本"],
];

/** 回执短语条数上限：超出折成「等 N 项」，不刷屏。 */
const REVERT_MAX_ITEMS = 8;

/**
 * 「这次退回了什么」的名词短语列表（纯函数）：chapters 下的章文件→「第 N 章定稿」、工作稿
 * drafts/<目录>/chapter-N→「第 N 章工作稿」、章纲 drafts/plans/chapter-N→「第 N 章章纲」、
 * characters/<id>/ 下→「角色卡：名字」（认不出的 id 不吐，说「角色卡资料」）、story/*.json 等资料区→短语。
 * D 状态（目标里有、后来被删，恢复把它找回来）加「（重新找回）」标注。同章多文件去重。
 */
export function describeRevertedPaths(
  files: readonly CommitFileChange[],
  nameById: ReadonlyMap<string, string>,
): string[] {
  const committed = new Set<number>();
  const drafts = new Set<number>();
  const plans = new Set<number>();
  const recovered = new Set<string>(); // 「（重新找回）」标注的原始短语
  const characterNames = new Set<string>();
  let unknownCharacter = false;
  const areas = new Set<string>();
  let others = 0;

  for (const { status, path } of files) {
    const chapter = /^chapters\/(\d+)\.md$/u.exec(path);
    if (chapter) {
      const n = Number(chapter[1]);
      committed.add(n);
      if (status === "D") recovered.add(`第 ${n} 章定稿`);
      continue;
    }
    const plan = /^drafts\/plans\/chapter-(\d+)\.json$/u.exec(path);
    if (plan) {
      const n = Number(plan[1]);
      plans.add(n);
      if (status === "D") recovered.add(`第 ${n} 章章纲`);
      continue;
    }
    const draft = /^drafts\/[^/]+\/chapter-(\d+)\.md$/u.exec(path);
    if (draft) {
      const n = Number(draft[1]);
      drafts.add(n);
      if (status === "D") recovered.add(`第 ${n} 章工作稿`);
      continue;
    }
    const character = /^characters\/([^/]+)\/([^/]+)$/u.exec(path);
    if (character) {
      const name = nameById.get(character[1]!);
      if (!name) { unknownCharacter = true; continue; }
      characterNames.add(name);
      continue;
    }
    const area = REVERT_AREA_FILES.find(([pattern]) => pattern.test(path));
    if (area) areas.add(area[1]);
    else others += 1;
  }

  const items: string[] = [];
  const withRecover = (phrase: string) => (recovered.has(phrase) ? `${phrase}（重新找回）` : phrase);
  for (const n of [...committed].sort((a, b) => a - b)) items.push(withRecover(`第 ${n} 章定稿`));
  for (const n of [...drafts].sort((a, b) => a - b)) items.push(withRecover(`第 ${n} 章工作稿`));
  for (const n of [...plans].sort((a, b) => a - b)) items.push(withRecover(`第 ${n} 章章纲`));
  const names = [...characterNames];
  if (names.length > 0) items.push(`角色卡：${names.length > 3 ? `${names.slice(0, 3).join("、")} 等 ${names.length} 张` : names.join("、")}`);
  else if (unknownCharacter) items.push("角色卡资料");
  // 角色卡本身动了，角色名册（character-bible.json）的随动改动不再单列（与 describeSnapshotChanges 同规矩）。
  if (names.length > 0 || unknownCharacter) areas.delete("角色名册");
  for (const [, label] of REVERT_AREA_FILES) {
    if (areas.has(label)) { items.push(label); areas.delete(label); }
  }
  if (others > 0) items.push(`其他文件 ${others} 个`);
  return items.length > REVERT_MAX_ITEMS
    ? [...items.slice(0, REVERT_MAX_ITEMS - 1), `等 ${items.length} 项`]
    : items;
}

/**
 * 撤销/恢复回执全文（纯函数）：写清撤的是哪一步、实际退回了什么、哪些是这步之后写的一并退回了、去哪找回。
 * revertedLater ⊆ reverted；主清单只列「这一步本身」的部分，连带退回的单独一句说清，不重复罗列。
 */
export function buildRestoreReceipt(input: {
  /** 「已撤销上一步（X）」里的 X；恢复存档点时传「已恢复到『X』之前」这类前缀已备好的整句标题。 */
  readonly title: string;
  readonly reverted: readonly CommitFileChange[];
  readonly revertedLater: readonly CommitFileChange[];
  readonly nameById: ReadonlyMap<string, string>;
}): string {
  const stepFiles = input.reverted.filter((file) => !input.revertedLater.some((later) => later.path === file.path));
  const stepItems = describeRevertedPaths(stepFiles, input.nameById);
  const laterItems = describeRevertedPaths(input.revertedLater, input.nameById);
  const parts: string[] = [input.title];
  parts.push(stepItems.length > 0 ? `这次退回：${stepItems.join("、")}。` : "这次没有文件被退回。");
  if (laterItems.length > 0) parts.push(`这步之后写的${laterItems.join("、")}也一并退回了。`);
  parts.push("要找回，去「历史」页点「恢复前的自动存档」。");
  return parts.join("");
}

/**
 * 操作历史里的条目名：存档点标签写的是「X前快照」，而这一行代表的就是操作 X 本身（按钮是「恢复到这之前」），
 * 所以去掉「前快照」、章号放后面，和「定稿：第58章」同一个说法。只用于列表展示，撤销逻辑仍认原始标签。
 */
export function humanizeHistoryLabel(label: string): string {
  // 恢复到某个存档点 = 回到那一步操作之前。
  const restore = /^恢复到：(.+)$/u.exec(label.trim());
  if (restore) return `恢复到「${humanizeHistoryLabel(restore[1]!)}」之前`;
  if (label.trim() === "初始快照") return "建书时的初始状态";
  const text = humanizeUndoLabel(label);
  const op = (name: string) => OP_NAMES[name.trim()] ?? name.trim();
  const chapterFirst = /^第\s*(\d+)\s*章(.+?)前快照$/u.exec(text);
  if (chapterFirst) return `${op(chapterFirst[2]!)}：第${chapterFirst[1]}章`;
  const withDetail = /^(.+?)前快照[：:](.+)$/u.exec(text);
  if (withDetail) return `${op(withDetail[1]!)}：${withDetail[2]!.trim()}`;
  const plain = /^(.+?)前快照$/u.exec(text);
  if (plain) return op(plain[1]!);
  return text;
}
