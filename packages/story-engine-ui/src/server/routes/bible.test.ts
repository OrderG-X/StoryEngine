// @vitest-environment node
//
// 设定本路由（重构 P9）：GET /api/bible 读设定视图（读路径不写盘）；POST /api/cards 作者改设定卡
// （作者档 card.write，改前存档、可撤销；requestId 是这次点击的幂等键，连点两次只改一次）。
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chapterCommit, runCommand, type BibleView } from "@actalk/story-core";
import { createStoryProject } from "../book/project-store.js";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { listSnapshots } from "../lib/snapshot.js";
import { registerBibleRoutes } from "./bible.js";
import { callRoute } from "./test-helpers.js";

let rootDir: string;
beforeEach(async () => {
  rootDir = await makeHomeTempDir("bible-route-");
});
afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

const cardsPath = (projectDir: string): string => join(projectDir, "ledger", "cards.json");
const readCardsText = (projectDir: string): Promise<string> => readFile(cardsPath(projectDir), "utf-8");
const getBible = (projectDir: string) => callRoute(registerBibleRoutes, "GET", `/api/bible?project=${encodeURIComponent(projectDir)}`);
const postCards = (body: Record<string, unknown>) => callRoute(registerBibleRoutes, "POST", "/api/cards", body);

async function newBook(): Promise<string> {
  const { projectDir } = await createStoryProject({ rootDir, title: "设定本路由", genre: "悬疑", logline: "雾港的信。", protagonistName: "沈青禾" });
  return projectDir;
}

describe("GET /api/bible", () => {
  it("返回设定视图：卡、故事设定、主角，账里出场还没建卡的列进 uncarded", async () => {
    const projectDir = await newBook();
    const committed = await runCommand(projectDir, chapterCommit, {
      chapter: 1,
      text: "# 第1章\n\n沈青禾推开钟楼的门，老周没有拦她。",
      entries: [
        { kind: "presence", review: "auto", name: "沈青禾", nameUsed: "沈青禾", viewpoint: true, quote: "沈青禾推开钟楼的门" },
        { kind: "presence", review: "auto", name: "周守义", nameUsed: "老周", quote: "老周没有拦她" },
      ],
    }, { caller: "author", idempotencyKey: "c1" });
    expect(committed.ok).toBe(true);
    const before = await readCardsText(projectDir);

    const response = await getBible(projectDir);

    expect(response.statusCode).toBe(200);
    expect(response.payload.ok).toBe(true);
    const bible = response.payload.bible as BibleView;
    expect(bible.protagonist).toBe("沈青禾");
    expect(bible.story.map(({ label, value }) => ({ label, value }))).toEqual([
      { label: "题材", value: "悬疑" },
      { label: "一句话", value: "雾港的信。" },
    ]);
    expect(bible.characters.map((entry) => ({ name: entry.card.name, chapters: entry.appearances?.chapters }))).toEqual([
      { name: "沈青禾", chapters: [1] },
    ]);
    expect(bible.uncarded.map((entry) => ({ name: entry.name, aliases: entry.aliases, character: entry.character }))).toEqual([
      { name: "周守义", aliases: ["老周"], character: true },
    ]);
    // 读路径不写盘。
    expect(await readCardsText(projectDir)).toBe(before);
  });

  it("老书还没有设定卡：从老设定文件现拼给界面看，不替作者落盘", async () => {
    const projectDir = join(rootDir, "old-book");
    await mkdir(join(projectDir, "story"), { recursive: true });
    await writeFile(join(projectDir, "project.json"), JSON.stringify({ id: "old", title: "老书", createdAt: "", updatedAt: "" }));
    await writeFile(join(projectDir, "story", "character-bible.json"), JSON.stringify({
      version: "v0",
      characters: [{ id: "lin", name: "林澈", role: "主角", identity: "旧城区幸存者" }],
    }));

    const response = await getBible(projectDir);

    expect(response.statusCode).toBe(200);
    const bible = response.payload.bible as BibleView;
    expect(bible.protagonist).toBe("林澈");
    expect(bible.characters[0]?.card.fields.map(({ label, value }) => ({ label, value }))).toEqual([{ label: "身份", value: "旧城区幸存者" }]);
    await expect(access(cardsPath(projectDir))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("没给书、书不在家目录里、方法不对：如实拒掉", async () => {
    expect(await callRoute(registerBibleRoutes, "GET", "/api/bible")).toMatchObject({ statusCode: 400, payload: { ok: false } });
    expect(await getBible("/etc")).toMatchObject({ statusCode: 400, payload: { ok: false, error: "不安全的项目路径" } });
    expect(await callRoute(registerBibleRoutes, "POST", "/api/bible", {})).toMatchObject({ statusCode: 405 });
    expect(await callRoute(registerBibleRoutes, "GET", "/api/cards")).toMatchObject({ statusCode: 405 });
  });
});

describe("POST /api/cards（作者改设定卡）", () => {
  it("改成了：返回改了什么（只有名字）和存档点，设定卡真写上了、可撤销", async () => {
    const projectDir = await newBook();

    const response = await postCards({
      projectPath: projectDir,
      requestId: "click-1",
      ops: [
        { op: "card.create", kind: "character", name: "苏晴", aliases: ["阿晴"], fields: [{ label: "身份", value: "记者" }] },
        { op: "relation.set", a: "苏晴", b: "沈青禾", label: "同事" },
        { op: "rules.set", field: "targetWords", value: 2400 },
      ],
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload.ok).toBe(true);
    const lines = response.payload.lines as string[];
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("")).toContain("苏晴");
    expect(lines.join("")).not.toMatch(/\bk-\d|\br-\d/u);
    expect(response.payload.snapshotId).toMatch(/^[0-9a-f]{40}$/u);
    expect(response.payload).not.toHaveProperty("replayed");

    const cards = JSON.parse(await readCardsText(projectDir));
    const su = cards.cards.find((card: { name: string }) => card.name === "苏晴");
    expect(su).toMatchObject({ kind: "character", aliases: ["阿晴"], by: "author", fields: [expect.objectContaining({ label: "身份", value: "记者", by: "author" })] });
    expect(cards.relations).toHaveLength(1);
    expect(cards.rules.targetWords).toMatchObject({ value: 2400, by: "author" });

    // 存档点就是这次改动之前那一刻：撤销能回到改之前。
    const snapshots = await listSnapshots(projectDir);
    expect(snapshots.map((entry) => entry.id)).toContain(response.payload.snapshotId);
    expect(snapshots.find((entry) => entry.id === response.payload.snapshotId)?.label).toContain("card.write");
  });

  it("同一个 requestId 点第二次：不重复改，如实说是重放（不给新的撤销点）", async () => {
    const projectDir = await newBook();
    const body = {
      projectPath: projectDir,
      requestId: "double-click",
      ops: [
        { op: "card.create", kind: "character", name: "苏晴" },
        { op: "exemplar.add", text: "雨下了一夜，港口的灯一盏一盏灭了。" },
      ],
    };

    const first = await postCards(body);
    expect(first).toMatchObject({ statusCode: 200, payload: { ok: true } });
    const afterFirst = await readCardsText(projectDir);

    const second = await postCards(body);

    expect(second.statusCode).toBe(200);
    expect(second.payload).toMatchObject({ ok: true, replayed: true, lines: first.payload.lines });
    expect(second.payload).not.toHaveProperty("snapshotId");
    expect(await readCardsText(projectDir)).toBe(afterFirst);
    const cards = JSON.parse(afterFirst);
    expect(cards.cards.filter((card: { name: string }) => card.name === "苏晴")).toHaveLength(1);
    expect(cards.rules.exemplars).toHaveLength(1);

    // 换一个 requestId 才是新的一次改动（建同名卡被如实拒掉）。
    const third = await postCards({ ...body, requestId: "another-click" });
    expect(third).toMatchObject({ statusCode: 409, payload: { ok: false } });
  });

  it.each([
    ["ops 不是数组", { ops: "建一张卡" }],
    ["ops 是空的", { ops: [] }],
    ["不认识的 op", { ops: [{ op: "card.explode", card: "沈青禾" }] }],
    ["缺字段", { ops: [{ op: "card.create", name: "苏晴" }] }],
  ])("格式不对（%s）：400，一个字不写", async (_label, patch) => {
    const projectDir = await newBook();
    const before = await readCardsText(projectDir);

    const response = await postCards({ projectPath: projectDir, requestId: "bad", ...patch });

    expect(response.statusCode).toBe(400);
    expect(response.payload).toMatchObject({ ok: false, error: "没改设定：要改的内容格式不对。" });
    expect(await readCardsText(projectDir)).toBe(before);
  });

  it("指错了卡：409 如实说没改，设定卡一个字不动、不给撤销点", async () => {
    const projectDir = await newBook();
    const before = await readCardsText(projectDir);

    const response = await postCards({
      projectPath: projectDir,
      requestId: "wrong-card",
      ops: [
        { op: "rules.set", field: "targetWords", value: 2400 },
        { op: "field.set", card: "不存在的人", label: "身份", value: "记者" },
      ],
    });

    expect(response.statusCode).toBe(409);
    expect(response.payload.ok).toBe(false);
    expect(typeof response.payload.code).toBe("string");
    expect(String(response.payload.error)).toMatch(/^没改设定：第 2 步：/u);
    // 一批要么全做、要么全不做：前面那步目标字数也没写上。
    expect(await readCardsText(projectDir)).toBe(before);
    expect(response.payload).not.toHaveProperty("snapshotId");
  });

  it("缺 requestId（没有幂等键）、书不在家目录里：不改", async () => {
    const projectDir = await newBook();
    const before = await readCardsText(projectDir);
    const ops = [{ op: "card.create", kind: "character", name: "苏晴" }];

    const noKey = await postCards({ projectPath: projectDir, ops });
    expect(noKey).toMatchObject({ statusCode: 400, payload: { ok: false, error: "没改设定：这次改动缺少防重复的编号。" } });
    expect(await postCards({ requestId: "x", ops })).toMatchObject({ statusCode: 400, payload: { ok: false, error: "没改设定：没说是哪本书。" } });

    const unsafe = await postCards({ projectPath: "/etc", requestId: "x", ops });
    expect(unsafe).toMatchObject({ statusCode: 400, payload: { ok: false, error: "不安全的项目路径" } });

    expect(await readCardsText(projectDir)).toBe(before);
  });
});
