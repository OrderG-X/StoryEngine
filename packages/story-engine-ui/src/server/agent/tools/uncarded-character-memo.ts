/**
 * 反复出场未建卡角色备忘（确定性，不赌模型记性）。
 *
 * 50 章耐力跑实测：老陈/老赵贯穿全书 40+ 章，系统每章只重复一句「新出现人物：… 要建卡就说一声」，
 * 弱模型不会自己升级语气，用户也从没接茬——50 章下来角色卡仍只有主角 1 张。
 * 这里补一个确定性升级：同一个未建卡名字在【多个不同章】反复出现并达到阈值时，
 * 入库摘要里点名建议一次（只点名一次，不每章唠叨；建卡本身仍等用户点头，符合唯一控制面）。
 *
 * 备忘落在 .story-engine-ui/uncarded-character-memo.json（UI 侧旁路数据，不进引擎状态）。
 * 名字建了卡后不再出现在 newCharacters 里，备忘条目自然停止累积。
 */
import { mkdir, readFile } from "node:fs/promises";
import { writeFileAtomic } from "../../lib/project-io.js";
import { dirname, join } from "node:path";

export const RECURRING_UNCARDED_THRESHOLD = 3;
/** 备忘最多记这么多名字（防模型幻觉人名把文件撑爆）；超出时丢«最早停止出现»的。 */
const MAX_TRACKED_NAMES = 200;

interface MemoEntry {
  /** 出现过的章号（去重、升序）。 */
  chapters: number[];
  /** 已在第几章升级点名过（点过不再重复）。 */
  escalatedAt?: number;
}

interface MemoFile {
  version: 1;
  names: Record<string, MemoEntry>;
}

export function uncardedCharacterMemoPath(projectDir: string): string {
  return join(projectDir, ".story-engine-ui", "uncarded-character-memo.json");
}

async function readMemo(projectDir: string): Promise<MemoFile> {
  let raw: string;
  try {
    raw = await readFile(uncardedCharacterMemoPath(projectDir), "utf-8");
  } catch (error) {
    // 只有「文件不存在」才当全新备忘；EACCES/EIO 等真实 IO 错误如实抛出（复审 P2：
    // 一概归零会把权限故障静默洗成「重新计数」，调用方已有自扛的 catch，不会伤入库）。
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return { version: 1, names: {} };
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
      && (parsed as MemoFile).names && typeof (parsed as MemoFile).names === "object"
    ) {
      const names: Record<string, MemoEntry> = {};
      for (const [name, entry] of Object.entries((parsed as MemoFile).names)) {
        if (!entry || typeof entry !== "object") continue;
        const chapters = Array.isArray(entry.chapters)
          ? [...new Set(entry.chapters.filter((c): c is number => Number.isInteger(c) && c > 0))].sort((a, b) => a - b)
          : [];
        names[name] = { chapters, ...(Number.isInteger(entry.escalatedAt) ? { escalatedAt: entry.escalatedAt } : {}) };
      }
      return { version: 1, names };
    }
  } catch {
    // 坏 JSON → 从零开始（备忘是提醒辅助数据，损坏重建不伤故事状态）
  }
  return { version: 1, names: {} };
}

async function writeMemo(projectDir: string, memo: MemoFile): Promise<void> {
  const path = uncardedCharacterMemoPath(projectDir);
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, `${JSON.stringify(memo, null, 2)}\n`);
}

/**
 * 记录本章新出现的未建卡名字，返回本次达到阈值、应升级点名的名字（每个名字只会返回一次）。
 * names 为空时零 IO 直接返回。
 */
export async function updateUncardedCharacterMemo(
  projectDir: string,
  chapter: number,
  names: readonly string[],
): Promise<readonly string[]> {
  const cleaned = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
  if (cleaned.length === 0) return [];

  const memo = await readMemo(projectDir);
  const escalate: string[] = [];
  for (const name of cleaned) {
    const entry = memo.names[name] ?? { chapters: [] };
    if (!entry.chapters.includes(chapter)) entry.chapters = [...entry.chapters, chapter].sort((a, b) => a - b);
    memo.names[name] = entry;
    if (entry.chapters.length >= RECURRING_UNCARDED_THRESHOLD && entry.escalatedAt === undefined) {
      entry.escalatedAt = chapter;
      escalate.push(name);
    }
  }
  // 容量兜底：按«最后出现章»由旧到新丢弃超额条目
  const entries = Object.entries(memo.names);
  if (entries.length > MAX_TRACKED_NAMES) {
    entries.sort((a, b) => (a[1].chapters.at(-1) ?? 0) - (b[1].chapters.at(-1) ?? 0));
    memo.names = Object.fromEntries(entries.slice(entries.length - MAX_TRACKED_NAMES));
  }
  await writeMemo(projectDir, memo);
  return escalate;
}

/**
 * 把升级点名折进入库摘要（面向用户：无工具名、无裸 id，铁律④）。names 为空原样返回。
 */
export function appendRecurringUncardedToSummary(summary: string, names: readonly string[]): string {
  if (names.length === 0) return summary;
  const quoted = names.map((name) => `「${name}」`).join("、");
  return `${summary} ${quoted}已经在好几章里反复出场、但还没有正式角色卡——建卡后状态和关系才会被系统跟踪，不建的话长篇里容易写漂。要建就说「给${names[0]}建卡」。`;
}
