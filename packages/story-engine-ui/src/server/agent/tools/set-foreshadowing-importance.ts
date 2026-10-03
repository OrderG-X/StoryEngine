/**
 * set_foreshadowing_importance — 写类工具：把用户对某条伏笔/线索的大小分级覆盖
 * 持久化到 .story-engine-ui/foreshadowing-overrides.json。
 *
 * 展示侧：shownSize = override ?? 引擎派生的 size（引擎只管默认，UI 应用覆盖）。
 * 绝不碰 hooks.json / threads.json（引擎不感知 override）。
 * 铁律：直接做 + 可撤销（writeTool 前置快照）；绝不静默失败（ok 字段如实回报）。
 */
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { readHookPool, readThreadPool } from "@actalk/story-engine";

import { coerceEnum } from "./lenient-args.js";
import { writeFileAtomic } from "../../lib/project-io.js";
import { scrubLocalAbsolutePaths } from "../../lib/local-path-scrubber.js";
import { writeTool } from "../withSnapshot.js";

/** UI 侧伏笔大小覆盖表的相对路径（相对于 projectDir）。 */
export const FORESHADOWING_OVERRIDES_RELATIVE_PATH = ".story-engine-ui/foreshadowing-overrides.json";

type Importance = "major" | "minor";
type OverridesMap = Record<string, Importance>;

/** 读覆盖表，文件不存在视为空表 {}；存在但损坏 → 抛错（修 P1·4：绝不把坏文件当空表覆盖丢已有覆盖）。 */
async function readOverrides(projectDir: string): Promise<OverridesMap> {
  let raw: string;
  try {
    raw = await readFile(join(projectDir, FORESHADOWING_OVERRIDES_RELATIVE_PATH), "utf-8");
  } catch (error) {
    if ((error as { code?: string })?.code === "ENOENT") return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("foreshadowing-overrides.json 内容损坏（不是合法 JSON），已停止以免覆盖；请先修复或删除该文件。");
  }
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    return parsed as OverridesMap;
  }
  return {};
}

/** 原子写覆盖表（mkdir -p 后写入）。 */
async function writeOverrides(projectDir: string, overrides: OverridesMap): Promise<void> {
  const dir = join(projectDir, ".story-engine-ui");
  await mkdir(dir, { recursive: true });
  await writeFileAtomic(
    join(projectDir, FORESHADOWING_OVERRIDES_RELATIVE_PATH),
    `${JSON.stringify(overrides, null, 2)}\n`,
  );
}

/** 读 hook/thread 池，区分 ENOENT（新书没文件=空，合理）与真读失败（权限/锁/损坏，须诚实回报）。 */
async function readPoolTitles(projectDir: string): Promise<Map<string, string>> {
  const isEnoent = (e: unknown): boolean => (e as { code?: string })?.code === "ENOENT";
  const [hookPool, threadPool] = await Promise.all([
    readHookPool(projectDir).catch((e) => { if (isEnoent(e)) return { hooks: [] }; throw e; }),
    readThreadPool(projectDir).catch((e) => { if (isEnoent(e)) return { threads: [] }; throw e; }),
  ]);
  // 存真标题（缺失存空串而非回落 id——绝不让裸 id 借标题路径漏进 summary）；has(id) 仍可做存在性校验。
  const titleById = new Map<string, string>();
  for (const h of hookPool.hooks) titleById.set(h.id, h.title?.trim() ?? "");
  for (const t of threadPool.threads) titleById.set(t.id, t.title?.trim() ?? "");
  return titleById;
}

/** 核心逻辑（不依赖 writeTool 框架，可单测）。 */
export async function setForeshadowingImportanceLogic(input: {
  readonly projectDir: string;
  readonly id: string;
  readonly importance: "major" | "minor";
}): Promise<{ readonly ok: boolean; readonly summary: string }> {
  const { projectDir, importance } = input;
  // 模型无关·canonical key：校验/写盘/summary 全用 trim 后的 key。
  // 治谎报 bug：旧逻辑校验用 id.trim() 却写盘/summary 用原始 id → 带空白 id 写进带空白的键 →
  // 展示按 canonical id 查不到 → 页面不变却 ok:true（标了等于没标，违铁律④）。
  const key = input.id?.trim() ?? "";
  if (!key) {
    return { ok: false, summary: "id 不能为空：请传入伏笔或线索的 id。" };
  }

  // 区分「没文件=空，合理」与「真读失败」——读失败别误判成「id 不存在」（旧 .catch(()=>空) 把读错塌成空表）。
  let titleById: Map<string, string>;
  try {
    titleById = await readPoolTitles(projectDir);
  } catch (error) {
    return { ok: false, summary: `核对伏笔/线索资料失败（${scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error))}），没改任何东西；请稍后重试或检查资料文件。` };
  }

  // 校验 id 真存在，否则覆盖了一个不存在的 id → ok:true 但页面无变化＝静默失败。
  if (!titleById.has(key)) {
    return { ok: false, summary: `没找到 id=「${key}」的伏笔或线索——请先从资料里确认它的真实 id（如 hook-3 / thread-xxx）再标记，避免标了个不存在的、页面不变。` };
  }

  try {
    const overrides = await readOverrides(projectDir);
    overrides[key] = importance;
    await writeOverrides(projectDir, overrides);

    const label = importance === "major" ? "大伏笔" : "小线索";
    // summary 用标题不用裸 id（模型无关·绝不泄露裸 id）；标题为空（旧书/损坏数据）也用中性词、绝不回落裸 id。
    const title = titleById.get(key);
    const display = title && title.length > 0 ? `「${title}」` : "这条";
    return {
      ok: true,
      summary: `已把${display}标记为${label}（可对我说「把它改回」撤销）。`,
    };
  } catch (error) {
    return {
      ok: false,
      summary: `写入伏笔覆盖失败：${scrubLocalAbsolutePaths(error instanceof Error ? error.message : String(error))}`,
    };
  }
}

const inputSchema = z.object({
  id: z.string().min(1).describe("伏笔（hook）或线索（thread）的 id，如 hook-3 / thread-betrayal。"),
  // 模型无关：枚举大小写宽容（模型常传 "Major"）。
  importance: coerceEnum(z.enum(["major", "minor"]).describe(
    "major=大伏笔（高权重展示）；minor=小线索（低权重展示）。",
  )),
});

const outputSchema = z.object({
  snapshotId: z.string().describe("写前快照 id，可一键撤销本次覆盖。"),
  ok: z.boolean().describe("是否成功写入；false 时 summary 含原因。"),
  summary: z.string().describe("自然语言结果，供回答用户。"),
});

export const setForeshadowingImportanceTool = writeTool({
  id: "set_foreshadowing_importance",
  description:
    "当用户说『把 XX 当大伏笔 / 这条不重要 / 把 XX 降成小线索 / XX 是关键伏笔』时调用：" +
    "把用户对某条伏笔或线索的大小分级覆盖（major=大伏笔 / minor=小线索）持久化，" +
    "面板展示时 shownSize = 本次覆盖（引擎只派生默认、不感知覆盖）。写前自动快照、可一键撤销。",
  inputSchema,
  outputSchema,
  run: async ({ input, projectDir }) => {
    const result = await setForeshadowingImportanceLogic({
      projectDir,
      id: input.id,
      importance: input.importance,
    });
    return result;
  },
});
