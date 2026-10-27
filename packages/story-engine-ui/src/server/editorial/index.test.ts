// @vitest-environment node
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeHomeTempDir } from "../lib/home-test-tmp.js";
import {
  CHECKER_ROLE,
  LEDGER_ROLE,
  PLANNER_ROLE,
  catchUpReaders,
  isReaderCatchUpQueued,
  maybeStartReadersCatchUp,
  readReaderProgress,
  readReadersCatchUpStatus,
  warmUpReaders,
} from "./index.js";
import { READER_WINDOW_MAX_CHARS, ensureReaderWindow, type BrainCallModel } from "./reader-window.js";

async function makeBook(chapters: number): Promise<string> {
  const dir = await makeHomeTempDir("brain-index-");
  await mkdir(join(dir, "chapters"), { recursive: true });
  for (let chapter = 1; chapter <= chapters; chapter += 1) {
    await writeFile(join(dir, "chapters", `${String(chapter).padStart(4, "0")}.md`), `# 第${chapter}章\n\n正文${chapter}。\n`, "utf-8");
  }
  return dir;
}

const notes = async (dir: string, role: string) => (await readdir(join(dir, "agents", role, "notes")).catch(() => [] as string[])).filter((name) => name.endsWith(".json")).sort();

afterEach(() => {
  vi.restoreAllMocks();
});

describe("预热 / 补读（R3 后三个角色都常开，没有开关）", () => {
  it("预热：三个角色的笔记都补到刚定稿的这一章", async () => {
    const dir = await makeBook(3);
    await warmUpReaders(dir, 2, { callModel: async () => "笔记" });
    expect(await notes(dir, "checker")).toEqual(["0001.json", "0002.json"]);
    expect(await notes(dir, "ledger")).toEqual(["0001.json", "0002.json"]);
    expect(await notes(dir, "planner")).toEqual(["0001.json", "0002.json"]);
  });

  it("补笔记失败：不抛错（只 warn），已有的笔记不受影响", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dir = await makeBook(3);
    let count = 0;
    const flaky: BrainCallModel = async () => {
      count += 1;
      if (count === 2) throw new Error("限流了");
      return "笔记";
    };
    await expect(warmUpReaders(dir, 3, { callModel: flaky })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await notes(dir, "planner")).toEqual(["0001.json"]);
  });

  it("catchUpReaders 点名只补指定的角色", async () => {
    const dir = await makeBook(2);
    await catchUpReaders(dir, 2, { callModel: async () => "笔记", roles: ["checker"] });
    expect(await notes(dir, "checker")).toEqual(["0001.json", "0002.json"]);
    expect(await notes(dir, "ledger")).toEqual([]);
    expect(await notes(dir, "planner")).toEqual([]);
  });
});

describe("三个角色共用一条补读队列（按角色依次补，不并发）", () => {
  it("任何时刻最多一个模型调用在飞；定稿后预热按 planner → checker → ledger 依次补完（定稿后多半接着拟下一章的纲）", async () => {
    const dir = await makeBook(2);
    let inFlight = 0;
    let maxInFlight = 0;
    const roles: string[] = [];
    const callModel: BrainCallModel = async (messages) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      roles.push(messages[0]!.content.includes("连续性编辑") ? "checker" : messages[0]!.content.includes("记账员") ? "ledger" : "planner");
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight -= 1;
      return "笔记";
    };
    await warmUpReaders(dir, 2, { callModel });
    expect(maxInFlight).toBe(1); // 没有两个角色的补读同时打模型
    expect(roles).toEqual(["planner", "planner", "checker", "checker", "ledger", "ledger"]); // 一个角色补完才轮到下一个
    expect(await notes(dir, "checker")).toEqual(["0001.json", "0002.json"]);
    expect(await notes(dir, "ledger")).toEqual(["0001.json", "0002.json"]);
    expect(await notes(dir, "planner")).toEqual(["0001.json", "0002.json"]);
  });

  it("同一本书同一组角色，已排队的一轮目标不低于这次要的 → 不重排；跑完就撤", async () => {
    const dir = await makeBook(2);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow: BrainCallModel = async () => { await gate; return "笔记"; };
    const first = warmUpReaders(dir, 2, { callModel: slow });
    await vi.waitFor(() => expect(isReaderCatchUpQueued(dir, ["checker", "ledger", "planner"], 2)).toBe(true), { timeout: 5_000 });
    expect(isReaderCatchUpQueued(dir, ["checker", "ledger", "planner"], 1)).toBe(true); // 目标更低也算盖住
    expect(isReaderCatchUpQueued(dir, ["checker"], 2)).toBe(false); // 角色不同不算
    const callsBefore = (await notes(dir, "checker")).length + (await notes(dir, "ledger")).length + (await notes(dir, "planner")).length;
    await warmUpReaders(dir, 2, { callModel: slow }); // 重触发：直接回，不排第二轮
    release();
    await first;
    expect((await notes(dir, "checker")).length + (await notes(dir, "ledger")).length + (await notes(dir, "planner")).length).toBeGreaterThan(callsBefore);
    expect(isReaderCatchUpQueued(dir, ["checker", "ledger", "planner"], 2)).toBe(false); // 跑完撤了
  });
});

describe("补读追上读的途中新定稿的章（R5.3）", () => {
  // 这条用例重：三个角色 × 59 章共 177 次假模型调用，全量并发跑时 5 秒默认超时会误伤（单独跑不超）。
  it("补读到第 58 章途中定稿第 59 章：结束三个角色都有 0059.json、进度 x/59、同一章笔记不重复写", { timeout: 30_000 }, async () => {
    const dir = await makeBook(58);
    // 每个角色每章写笔记的模型调用次数——同一角色同一章调了两次就是重复读。
    const noteCalls = new Map<string, number>();
    let warmAfter59: Promise<void> | undefined;
    let finalized = false;
    const callModel: BrainCallModel = async (messages) => {
      const chapter = Number(/第 (\d+) 章/u.exec(messages.at(-1)!.content)?.[1] ?? 0);
      const role = messages[0]!.content.includes("连续性编辑") ? "checker" : messages[0]!.content.includes("记账员") ? "ledger" : "planner";
      if (chapter > 0) {
        noteCalls.set(`${role}:${chapter}`, (noteCalls.get(`${role}:${chapter}`) ?? 0) + 1);
        // 任一角色读到第 30 章时作者定稿第 59 章：落章文件 + 走真路径的定稿预热（commit-apply 同款入口）。
        if (!finalized && chapter >= 30) {
          finalized = true;
          await writeFile(join(dir, "chapters", "0059.md"), "# 第59章\n\n正文59。\n", "utf-8");
          warmAfter59 = warmUpReaders(dir, 59, { callModel });
        }
      }
      return `第${chapter}章笔记`;
    };
    await catchUpReaders(dir, 58, { callModel });
    await warmAfter59; // 预热那轮也走完（排在后面，笔记已齐时它不读任何章）
    // 三个角色都追到第 59 章：笔记文件在、进度行同款数据源显示 59/59。
    for (const role of ["checker", "ledger", "planner"]) {
      const files = await notes(dir, role);
      expect(files).toContain("0059.json");
      expect(files).toHaveLength(59);
      await expect(readReaderProgress(dir, role)).resolves.toMatchObject({ reading: false, done: 59, total: 59 });
    }
    const status = await readReadersCatchUpStatus(dir);
    expect(status.reading).toBe(false);
    expect(status.roles.map((role) => [role.done, role.total])).toEqual([[59, 59], [59, 59], [59, 59]]);
    // 全程每个角色每章只写一次笔记（记账员复验里漏得最狠，专门点它）。
    expect(noteCalls.get("ledger:59")).toBe(1);
    expect(noteCalls.get("checker:59")).toBe(1);
    expect(noteCalls.get("planner:59")).toBe(1);
    expect(noteCalls.size).toBe(3 * 59);
    expect([...noteCalls.values()].every((count) => count === 1)).toBe(true);
  });

  it("读的途中不触发预热也会追：一轮跑完时自己看已定稿章数，变多了接着读到新末尾", async () => {
    const dir = await makeBook(4);
    let finalized = false;
    const callModel: BrainCallModel = async (messages) => {
      const chapter = Number(/第 (\d+) 章/u.exec(messages.at(-1)!.content)?.[1] ?? 0);
      if (!finalized && chapter >= 2) {
        finalized = true;
        await writeFile(join(dir, "chapters", "0005.md"), "# 第5章\n\n正文5。\n", "utf-8");
      }
      return `第${chapter}章笔记`;
    };
    await catchUpReaders(dir, 4, { callModel }); // 没有任何预热触发，只靠补读自己追
    for (const role of ["checker", "ledger", "planner"]) {
      expect(await notes(dir, role)).toHaveLength(5);
      await expect(readReaderProgress(dir, role)).resolves.toMatchObject({ reading: false, done: 5, total: 5 });
    }
  });
});

describe("开书时看一眼要不要补（maybeStartReadersCatchUp）", () => {
  it("没读齐 → 后台接着补齐三个角色；读齐了再来直接回；没有定稿章节的书不排", async () => {
    const dir = await makeBook(3);
    await maybeStartReadersCatchUp(dir, { callModel: async () => "笔记" }); // 没笔记 → 排上
    await vi.waitFor(async () => {
      for (const role of ["checker", "ledger", "planner"]) {
        await expect(readReaderProgress(dir, role)).resolves.toMatchObject({ reading: false, done: 3, total: 3 });
      }
    }, { timeout: 5_000 });
    // 读齐了：再来一次直接回（进度文件不动，说明没再排）
    const before = await readFile(join(dir, "agents", "checker", "progress.json"), "utf-8");
    await maybeStartReadersCatchUp(dir, { callModel: async () => "笔记" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await readFile(join(dir, "agents", "checker", "progress.json"), "utf-8")).toBe(before);
    // 没有定稿章节的书：不排
    const empty = await makeHomeTempDir("brain-index-empty-");
    await maybeStartReadersCatchUp(empty, { callModel: async () => "笔记" });
    expect(await readReaderProgress(empty, "checker")).toBeUndefined();
  });

  it("定稿全撤了、盘上还留着上一轮没收尾的「在读」→ 开书标回不在读（2026-10-23 桌面包走查：一直挂「核账员 0/1」）", async () => {
    const dir = await makeHomeTempDir("brain-index-undone-");
    await mkdir(join(dir, "agents", "checker"), { recursive: true });
    await writeFile(join(dir, "agents", "checker", "progress.json"), JSON.stringify({ role: "checker", reading: true, done: 0, total: 1, updatedAt: "" }));
    await maybeStartReadersCatchUp(dir, { callModel: async () => "笔记" });
    await expect(readReaderProgress(dir, "checker")).resolves.toMatchObject({ reading: false, done: 0, total: 0 });
    expect(await readReaderProgress(dir, "ledger")).toBeUndefined();
  });

  it("R4.3 开书那次概况就带进度：排进队后、返回之前，第一个要读的角色已经标成 reading", async () => {
    const dir = await makeBook(3);
    // 模型卡住不动（补读在队里慢慢排）：maybeStartReadersCatchUp 自己必须先落 progress 再返回，
    // 不然开书概况读到的还是「没在读」，要等刷新页面才看得到进度。
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow: BrainCallModel = async () => { await gate; return "笔记"; };
    await maybeStartReadersCatchUp(dir, { callModel: slow });
    // 返回那一刻：第一个要读的角色（checker）已在读，0/3（一章还没读完是事实，不装）。
    await expect(readReaderProgress(dir, "checker")).resolves.toMatchObject({ reading: true, done: 0, total: 3 });
    // 后面排队的角色此刻还没标（它们排在 checker 后面）。
    await expect(readReaderProgress(dir, "ledger")).resolves.toBeUndefined();
    await expect(readReaderProgress(dir, "planner")).resolves.toBeUndefined();
    release();
    await vi.waitFor(async () => {
      await expect(readReaderProgress(dir, "planner")).resolves.toMatchObject({ reading: false, done: 3, total: 3 });
    }, { timeout: 5_000 });
  });
});

describe("长书窗口封顶（P7 两百章验收）", () => {
  it("三个跟读角色读到两百章，窗口都不超过预算（靠卷笔记；笔记按真书实测的一千三百字）", async () => {
    const dir = await makeBook(200);
    const callModel: BrainCallModel = async (messages) => {
      const volume = (messages[messages.length - 1]?.content ?? "").includes("缩写成卷笔记");
      return (volume ? "卷" : "记").repeat(volume ? 1400 : 1300);
    };
    for (const role of [CHECKER_ROLE, PLANNER_ROLE, LEDGER_ROLE]) {
      const out = await ensureReaderWindow({ projectDir: dir, role, upTo: 200, callModel });
      const size = out.messages.reduce((sum, message) => sum + message.content.length, 0);
      expect(size, role.id).toBeLessThanOrEqual(READER_WINDOW_MAX_CHARS);
      expect(out.volumesBuilt, role.id).toBeGreaterThan(0);
    }
  }, 60_000);
});
