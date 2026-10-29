// @vitest-environment node
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import { __resetOperationStoreForTests, acceptOperation, changeOperation, type OperationState } from "../lib/operations/store.js";
import { BACKFILL_KIND, type BackfillRange } from "../lib/reader-backfill.js";
import { registerReaderProgressRoutes } from "./reader-progress.js";
import { callRoute } from "./test-helpers.js";

beforeEach(() => {
  __resetOperationStoreForTests();
});

async function bookWithChapters(prefix: string, chapters: number): Promise<string> {
  const dir = await makeHomeTempDir(prefix);
  await mkdir(join(dir, "chapters"), { recursive: true });
  for (let chapter = 1; chapter <= chapters; chapter += 1) {
    await writeFile(join(dir, "chapters", `${String(chapter).padStart(4, "0")}.md`), `# 第${chapter}章\n\n正文。\n`, "utf-8");
  }
  return dir;
}

/** 受理一次后台补读（不跑），按需要换成某个状态、停在某一步。 */
async function backfill(dir: string, ranges: readonly BackfillRange[], options: { readonly state?: OperationState; readonly currentStep?: string } = {}): Promise<void> {
  const accepted = await acceptOperation(dir, {
    requestKey: `test-${Math.random()}`,
    issuedAt: new Date().toISOString(),
    kind: BACKFILL_KIND,
    params: { ranges },
    recipeVersion: 1,
    origin: { kind: "background" },
    writeScope: { chapters: [] },
    budget: { limit: 100 },
  }, { bookEpoch: async () => "e1" });
  if (!accepted.ok || !("record" in accepted)) throw new Error("没受理");
  if (!options.state && !options.currentStep) return;
  await changeOperation(dir, accepted.record.opId, (current) => ({ ...current, state: "running", ...(options.currentStep ? { currentStep: options.currentStep } : {}) }));
  if (options.state && options.state !== "running") await changeOperation(dir, accepted.record.opId, (current) => ({ ...current, state: options.state! }));
}

const get = (dir: string) => callRoute(registerReaderProgressRoutes, "GET", `/api/reader-progress?project=${encodeURIComponent(dir)}`);

describe("GET /api/reader-progress（R4.3 在读前文轻量轮询；写作版本 P2a 起从后台补读的操作记录出）", () => {
  it("没有在跑的后台补读：reading:false（前端收到就停轮询），roles 形状照给", async () => {
    const dir = await bookWithChapters("reader-progress-idle-", 3);
    await backfill(dir, [{ role: "checker", from: 1, to: 3 }], { state: "succeeded" });
    const { statusCode, payload } = await get(dir);
    expect(statusCode).toBe(200);
    expect(payload).toEqual({
      ok: true,
      reading: false,
      roles: [
        { role: "checker", reading: false, done: 0, total: 0 },
        { role: "ledger", reading: false, done: 0, total: 0 },
        { role: "planner", reading: false, done: 0, total: 0 },
      ],
    });
  });

  it("在跑：当前步骤那个角色在读（读到当前章的前一章），前面的读完、后面的排队", async () => {
    const dir = await bookWithChapters("reader-progress-live-", 58);
    await backfill(dir, [
      { role: "ledger", from: 41, to: 58 },
      { role: "checker", from: 1, to: 58 },
      { role: "planner", from: 9, to: 58 },
    ], { currentStep: "checker:35" });
    const { statusCode, payload } = await get(dir);
    expect(statusCode).toBe(200);
    expect(payload).toEqual({
      ok: true,
      reading: true,
      roles: [
        { role: "checker", reading: true, done: 34, total: 58 },
        { role: "ledger", reading: false, done: 58, total: 58 },
        { role: "planner", reading: false, done: 8, total: 58 },
      ],
    });
  });

  it("在跑：读到当前那章的前一章；排着还没跑：第一个角色在读、读到 from − 1", async () => {
    const dir = await bookWithChapters("reader-progress-part-", 20);
    await backfill(dir, [{ role: "planner", from: 5, to: 20 }], { currentStep: "planner:11" });
    expect((await get(dir)).payload).toMatchObject({ reading: true, roles: [{ role: "checker", reading: false }, { role: "ledger", reading: false }, { role: "planner", reading: true, done: 10, total: 20 }] });
    const queued = await bookWithChapters("reader-progress-queued-", 20);
    await backfill(queued, [{ role: "ledger", from: 5, to: 20 }]);
    expect((await get(queued)).payload).toMatchObject({ reading: true, roles: [{ role: "checker", reading: false }, { role: "ledger", reading: true, done: 4, total: 20 }, { role: "planner", reading: false }] });
  });

  it("R5.3 分母跟定稿走：冻结的是开读时的 58，chapters/ 已定稿到 0059 → total 现算成 59", async () => {
    const dir = await bookWithChapters("reader-progress-chase-", 59);
    await backfill(dir, [{ role: "checker", from: 1, to: 58 }], { currentStep: "checker:35" });
    const { payload } = await get(dir);
    expect(payload.reading).toBe(true);
    expect((payload.roles as unknown[])[0]).toEqual({ role: "checker", reading: true, done: 34, total: 59 });
  });

  it("不同角色各在一份里补（提交口按角色排）：各按含它的那份算", async () => {
    const dir = await bookWithChapters("reader-progress-two-", 30);
    await backfill(dir, [{ role: "checker", from: 1, to: 30 }], { currentStep: "checker:12" });
    await backfill(dir, [{ role: "planner", from: 1, to: 30 }]);
    expect((await get(dir)).payload).toEqual({
      ok: true,
      reading: true,
      roles: [
        { role: "checker", reading: true, done: 11, total: 30 },
        { role: "ledger", reading: false, done: 0, total: 0 },
        { role: "planner", reading: true, done: 0, total: 30 },
      ],
    });
  });

  it("停着（paused）的不算在读，但如实标停着、读到哪（不当成读完了）", async () => {
    const dir = await bookWithChapters("reader-progress-paused-", 5);
    await backfill(dir, [{ role: "checker", from: 1, to: 5 }], { state: "paused", currentStep: "checker:3" });
    const { payload } = await get(dir);
    expect(payload.reading).toBe(false);
    expect((payload.roles as unknown[])[0]).toEqual({ role: "checker", reading: false, done: 2, total: 5, paused: "interrupted" });
  });

  it("老书没开过编辑部：reading:false、三角色 0/0，不炸", async () => {
    const dir = await makeHomeTempDir("reader-progress-fresh-");
    const { statusCode, payload } = await get(dir);
    expect(statusCode).toBe(200);
    expect(payload).toMatchObject({ ok: true, reading: false });
    expect((payload.roles as { role: string }[]).map((role) => role.role)).toEqual(["checker", "ledger", "planner"]);
  });

  it("缺项目路径 400；路径不安全 400", async () => {
    expect((await callRoute(registerReaderProgressRoutes, "GET", "/api/reader-progress")).statusCode).toBe(400);
    expect((await callRoute(registerReaderProgressRoutes, "GET", "/api/reader-progress?project=../outside")).statusCode).toBe(400);
  });

  it("只收 GET", async () => {
    const { statusCode } = await callRoute(registerReaderProgressRoutes, "POST" as "GET", "/api/reader-progress?project=/tmp/x");
    expect(statusCode).toBe(405);
  });
});
