// @vitest-environment node
// 栅栏、暂停入口、派生发布（写作版本 P2a 设计 6.2、6.3）。
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bookEpochWrite, draftSave, readBookEpoch, runCommand, withBookLock } from "@actalk/story-core";
import { createStoryProject } from "../../book/project-store.js";
import { makeHomeTempDir } from "../home-test-tmp.js";
import { __resetExecutionsForTests, OperationStopped, registerExecution, type OperationContext } from "./context.js";
import { checkFence, fencePrecondition, pauseOperation, publishDerived, withFence } from "./fence.js";
import { __resetOperationStoreForTests, acceptOperation, changeOperation, readOperation, type OperationRecord } from "./store.js";

let root: string;
let book: string;

beforeEach(async () => {
  __resetOperationStoreForTests();
  __resetExecutionsForTests();
  root = await makeHomeTempDir("operations-fence-");
  ({ projectDir: book } = await createStoryProject({ rootDir: root, title: "栅栏", genre: "悬疑", protagonistName: "林远" }));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** 受理一次、跑起来（runEpoch 1），返回它的上下文。 */
async function running(key = "chat:m1:1", chapter = 1): Promise<{ readonly context: OperationContext; readonly record: OperationRecord }> {
  const accepted = await acceptOperation(book, {
    requestKey: key, issuedAt: new Date().toISOString(), kind: "draft.change", mode: "write", params: {}, recipeVersion: 1,
    origin: { kind: "chat", messageId: key }, writeScope: { chapters: [chapter] },
  }, { bookEpoch: () => readBookEpoch(book) });
  if (!accepted.ok || !("record" in accepted)) throw new Error(JSON.stringify(accepted));
  const record = await changeOperation(book, accepted.record.opId, (current) => ({ ...current, state: "running", runEpoch: 1 }));
  const execution = registerExecution(book, accepted.record.opId, 1);
  return {
    record: record!,
    context: { bookDir: book, opId: accepted.record.opId, runEpoch: 1, bookEpoch: record!.bookEpoch, signal: execution.signal, lane: "foreground" },
  };
}

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

describe("栅栏", () => {
  it("在跑、runEpoch 对、纪元没换：过；取消后、纪元换了、书不在了、signal 打断了：不过", async () => {
    const { context } = await running();
    expect(await withBookLock(book, () => checkFence(context))).toBeUndefined();

    await changeOperation(book, context.opId, (current) => ({ ...current, state: "cancelled", runEpoch: 2 }));
    expect(await withBookLock(book, () => checkFence(context))).toMatchObject({ code: "operation_stopped" });

    const second = await running("chat:m2:1", 2);
    await mkdir(join(book, "store-control"), { recursive: true });
    await writeFile(join(book, "store-control/epoch.json"), bookEpochWrite(new Date()).content);
    expect(await withBookLock(book, () => checkFence(second.context))).toMatchObject({ code: "book_epoch_changed" });

    const moved = `${book}-moved`;
    await rename(book, moved);
    expect(await checkFence(second.context)).toMatchObject({ code: "book_gone" });
    await rename(moved, book);

    const third = await running("chat:m3:1", 3);
    const controller = new AbortController();
    controller.abort();
    expect(await withBookLock(book, () => checkFence({ ...third.context, signal: controller.signal }))).toMatchObject({ code: "operation_stopped" });
  });

  it("取消和写抢：worker 拿着书锁、过了栅栏在写时发取消 → 取消等写完；之后的写过不了栅栏", async () => {
    const { context } = await running();
    const writing = deferred();
    const release = deferred();
    const first = withFence(context, async () => {
      writing.resolve();
      await release.promise;
      await writeFile(join(book, "first.txt"), "写完了");
    });
    await writing.promise;
    let cancelled = false;
    const cancel = changeOperation(book, context.opId, (current) => ({ ...current, state: "cancelled", runEpoch: current.runEpoch + 1 })).then(() => { cancelled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cancelled).toBe(false);
    release.resolve();
    await first;
    await cancel;
    expect(await readFile(join(book, "first.txt"), "utf-8")).toBe("写完了");
    await expect(withFence(context, async () => writeFile(join(book, "second.txt"), "不该写"))).rejects.toBeInstanceOf(OperationStopped);
    await expect(stat(join(book, "second.txt"))).rejects.toThrow();
  });

  it("核心命令带栅栏：取消之后零写入", async () => {
    const { context } = await running();
    await changeOperation(book, context.opId, (current) => ({ ...current, state: "cancelled", runEpoch: 2 }));
    const outcome = await runCommand(book, draftSave, { chapter: 1, body: "旧 worker 的稿", baseVersion: null }, {
      caller: "author", op: { opId: context.opId, stepId: "apply" }, precondition: fencePrecondition(context),
    });
    expect(outcome).toMatchObject({ ok: false, code: "operation_stopped" });
    await expect(stat(join(book, "drafts/fast/chapter-0001.md"))).rejects.toThrow();
  });
});

describe("暂停入口", () => {
  it("先停住本次执行（signal 立刻打断），再换成 paused、runEpoch + 1；旧 runEpoch 再暂停、取消之后暂停都不动", async () => {
    const { context } = await running();
    const paused = pauseOperation(book, context.opId, 1, "attempt_unknown");
    expect(context.signal.aborted).toBe(true);
    expect(await paused).toMatchObject({ state: "paused", pauseReason: "attempt_unknown", runEpoch: 2 });
    expect(await pauseOperation(book, context.opId, 1, "budget")).toBeUndefined();
    const stored = await readOperation(book, context.opId);
    expect(stored).toMatchObject({ kind: "record", record: { pauseReason: "attempt_unknown", runEpoch: 2 } });

    const other = await running("chat:m2:1", 2);
    await changeOperation(book, other.context.opId, (current) => ({ ...current, state: "cancelled", runEpoch: 2 }));
    expect(await pauseOperation(book, other.context.opId, 1, "budget")).toBeUndefined();
    expect(await readOperation(book, other.context.opId)).toMatchObject({ record: { state: "cancelled" } });
  });

  it("暂停和写抢：worker 拿着书锁在写时判出要暂停 → 那一笔写完，之后零写入；已暂停在换状态之后才报", async () => {
    const { context } = await running();
    const writing = deferred();
    const release = deferred();
    const first = withFence(context, async () => {
      writing.resolve();
      await release.promise;
      await writeFile(join(book, "first.txt"), "写完了");
    });
    await writing.promise;
    let reported = false;
    const pausing = pauseOperation(book, context.opId, 1, "attempt_unknown").then((record) => { reported = record?.state === "paused"; });
    expect(context.signal.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reported).toBe(false);
    release.resolve();
    await first;
    await pausing;
    expect(reported).toBe(true);
    expect(await readFile(join(book, "first.txt"), "utf-8")).toBe("写完了");
    await expect(withFence(context, async () => writeFile(join(book, "second.txt"), "x"))).rejects.toBeInstanceOf(OperationStopped);
  });
});

describe("派生发布", () => {
  it("算的途中书又改过：不发布、说一句；书不在了：不发布、不建目录", async () => {
    const gate = deferred();
    const computing = deferred();
    let published = 0;
    const pending = publishDerived(book, async () => {
      computing.resolve();
      await gate.promise;
      return { sourceVersion: 0, value: 1 };
    }, async () => { published += 1; });
    await computing.promise;
    const { cardWrite } = await import("@actalk/story-core");
    expect(await runCommand(book, cardWrite, { ops: [{ op: "rules.set", field: "minWords", value: 900 }] }, { caller: "author", idempotencyKey: "x" })).toMatchObject({ ok: true });
    gate.resolve();
    expect(await pending).toMatchObject({ published: false });
    expect(published).toBe(0);

    const moved = `${book}-moved`;
    await rename(book, moved);
    expect(await publishDerived(book, async () => ({ sourceVersion: 1, value: 1 }), async () => { published += 1; })).toMatchObject({ published: false });
    await expect(stat(book)).rejects.toThrow();
    await rename(moved, book);
    expect(published).toBe(0);
  });
});
