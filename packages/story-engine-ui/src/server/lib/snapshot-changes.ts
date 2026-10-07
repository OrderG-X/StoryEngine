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
};

/**
 * 操作历史里的条目名：存档点标签写的是「X前快照」，而这一行代表的就是操作 X 本身（按钮是「恢复到这之前」），
 * 所以去掉「前快照」、章号放后面，和「定稿：第58章」同一个说法。只用于列表展示，撤销逻辑仍认原始标签。
 */
export function humanizeHistoryLabel(label: string): string {
  // 恢复到某个存档点 = 回到那一步操作之前。
  const restore = /^恢复到：(.+)$/u.exec(label.trim());
  if (restore) return `恢复到「${humanizeHistoryLabel(restore[1]!)}」之前`;
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
