// @vitest-environment node
/**
 * 属性 3 · 新角色处理（"longform memory hub" 的候选自动登记，2026-06-24 反转）— UI package。
 *
 * 历史：破例③ Task 8 曾让 commit_apply 走 convertCandidatesToMatrixUpdates 把新角色自动登记为
 * status:"candidate"。但正则猜的候选会把『耳边轻声』类碎片污染进矩阵；2026-06-24 用户拍板
 * 「新人物只告知、不替我写盘」→ 停掉自动登记，新出现人物改由入库后 extractAndAppendFacts 抽取、
 * 拼进 summary 告知用户，由用户决定建卡。
 *
 * 本探针现在锁定『反转后的契约』：
 *   - 章节含新人物林静 → 入库后 character-matrix / buildStateOverview 都【不】自动出现林静候选；
 *   - 误抓词（对方/保安）依旧不被登记（防污染）。
 *
 * 不连网（fact-ledger mock 掉）、确定性、可回归。
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildStateOverview,
  createStoryProject,
  readCharacterMatrixLedger,
} from "@actalk/story-engine";
import { applyCommitToolLogic } from "./commit-apply.js";
import { buildCommitPreviewToolOutput } from "./commit-preview.js";
import { __resetCommitPreviewStore } from "./commit-preview-store.js";


// ── Helpers ───────────────────────────────────────────────────────────────────

async function makeProject(title: string, mainChar = "林远"): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "phase2-attr3-probe-"));
  const { projectDir } = await createStoryProject({
    rootDir,
    title,
    genre: "都市",
    premise: "主角进入权力中心。",
    mainCharacterName: mainChar,
  });
  return projectDir;
}

async function writeDraft(projectDir: string, chapter: number, content: string): Promise<void> {
  await writeFile(
    join(projectDir, "drafts", "fast", `chapter-${String(chapter).padStart(4, "0")}.md`),
    content,
    "utf-8",
  );
}

/**
 * 草稿含新人物"林静"（二字名、非主角、过 isLikelyNewCharacterName 启发式）。
 * 关键模式：「看见林静」匹配 extractPossibleCharacterMentions pattern 2。
 * 正文量 ≥ 300 汉字（重复基础句到 12 次），确保字数门槛。
 */
function draftWithNewCharacter(chapter: number, mainChar: string): string {
  const pad = Array.from(
    { length: 12 },
    () => `${mainChar}在会议室外停下脚步，反复掂量手里那份账册的分量，盘算着接下来每一步该怎么走。`,
  ).join("");
  const body = [
    `${mainChar}推开会议室的门，一眼看见林静站在走廊对面，手里拿着一叠文件。`,
    `林静点头示意，把文件推过来，低声说了几个字。`,
    `${mainChar}接过文件，重新盘算着接下来每一步。`,
    `林静看了他一眼，没有再开口。`,
    pad,
  ].join("");
  return `# 第${chapter}章\n\n${body}\n`;
}

/**
 * 草稿仅含误抓词"对方"和"保安"，不含真实新人物名。
 * 同样保证 ≥ 300 汉字。
 */
function draftWithNoiseOnly(chapter: number, mainChar: string): string {
  const pad = Array.from(
    { length: 12 },
    () => `${mainChar}在会议室外停下脚步，反复掂量手里那份账册的分量，盘算着接下来每一步该怎么走。`,
  ).join("");
  const body = [
    `${mainChar}推开会议室的门，对方站在走廊对面，手里拿着一叠文件。`,
    `对方点头示意，保安把文件推过来，低声说了几个字。`,
    `${mainChar}接过文件，重新盘算着接下来每一步。`,
    `对方看了他一眼，没有再开口。`,
    pad,
  ].join("");
  return `# 第${chapter}章\n\n${body}\n`;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  __resetCommitPreviewStore();
});

describe("属性 3：新角色处理（2026-06-24 反转：自动登记 → 告知，用户拍板）", () => {
  it("章节含新人物林静 → 入库后 character-matrix 不再自动登记（改为告知用户）", async () => {
    const projectDir = await makeProject("新人物不自动登记", "林远");
    await writeDraft(projectDir, 1, draftWithNewCharacter(1, "林远"));

    const preview = await buildCommitPreviewToolOutput({ projectDir, chapter: 1 });
    expect(preview.canCommit).toBe(true);

    const out = await applyCommitToolLogic({ projectDir, chapter: 1, previewToken: preview.previewToken! });
    expect(out.committed).toBe(true);

    const matrix = await readCharacterMatrixLedger(projectDir);
    const linJing = matrix.entries.find((entry) => entry.name === "林静");
    expect(linJing, "林静不应被自动写进 character-matrix（改为入库后告知用户）").toBeUndefined();
  });

  it("buildStateOverview 的 characterMatrix 不再因入库新增 candidate", async () => {
    const projectDir = await makeProject("矩阵不自动新增候选", "林远");
    await writeDraft(projectDir, 1, draftWithNewCharacter(1, "林远"));

    const preview = await buildCommitPreviewToolOutput({ projectDir, chapter: 1 });
    const out = await applyCommitToolLogic({ projectDir, chapter: 1, previewToken: preview.previewToken! });
    expect(out.committed).toBe(true);

    const overview = await buildStateOverview({ projectDir, chapter: 1 });
    const linJingInOverview = overview.characterMatrix.characters.find((c) => c.name === "林静");
    expect(linJingInOverview, "林静不应作为 candidate 透出").toBeUndefined();
  });

  it("误抓词（对方/保安）不被登记（防污染依旧）", async () => {
    const projectDir = await makeProject("噪声防污染测试", "林远");
    await writeDraft(projectDir, 1, draftWithNoiseOnly(1, "林远"));

    const preview = await buildCommitPreviewToolOutput({ projectDir, chapter: 1 });
    expect(preview.canCommit).toBe(true);

    const out = await applyCommitToolLogic({ projectDir, chapter: 1, previewToken: preview.previewToken! });
    expect(out.ok).toBe(true);
    expect(out.committed).toBe(true);

    const matrix = await readCharacterMatrixLedger(projectDir);
    const duifang = matrix.entries.find((e) => e.name.includes("对方"));
    const baoan = matrix.entries.find((e) => e.name.includes("保安"));

    expect(duifang, '"对方"不应被登记').toBeUndefined();
    expect(baoan, '"保安"不应被登记').toBeUndefined();
  });
});
