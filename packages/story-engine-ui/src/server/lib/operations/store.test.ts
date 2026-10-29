// @vitest-environment node
// 操作记录：受理去重、写位、墓碑、锁序（写作版本 P2a 设计第二节）。
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withBookLock } from "@actalk/story-core";
import { makeHomeTempDir } from "../home-test-tmp.js";
import {
  __resetOperationStoreForTests,
  acceptOperation,
  changeOperation,
  isScheduledHere,
  OperationTransitionError,
  operationDir,
  opIdFor,
  pruneOperations,
  readOperation,
  withRecordLock,
  type OperationRequest,
} from "./store.js";

let book: string;
const epoch = async () => "epoch-1";
const NOW = new Date("2026-10-29T08:00:00.000Z");

beforeEach(async () => {
  book = await makeHomeTempDir("operations-store-");
  __resetOperationStoreForTests();
});
afterEach(async () => {
  await rm(book, { recursive: true, force: true });
});

const request = (over: Partial<OperationRequest> = {}): OperationRequest => ({
  requestKey: "chat:m1:1",
  issuedAt: NOW.toISOString(),
  kind: "draft.change",
  mode: "write",
  params: { chapter: 3 },
  recipeVersion: 1,
  origin: { kind: "chat", messageId: "m1", chapter: 3 },
  writeScope: { chapters: [3] },
  ...over,
});

const accept = (over: Partial<OperationRequest> = {}) => acceptOperation(book, request(over), { bookEpoch: epoch, now: NOW });

describe("受理", () => {
  it("写成一份 queued 记录、本进程登记；同键重送回原操作", async () => {
    const first = await accept();
    if (!first.ok || !("record" in first)) throw new Error(JSON.stringify(first));
    expect(first).toMatchObject({ existing: false, record: { state: "queued", runEpoch: 0, bookEpoch: "epoch-1", eventSeq: 1, writeScope: { chapters: [3] } } });
    expect(first.record.opId).toBe(opIdFor("chat:m1:1"));
    expect(isScheduledHere(book, first.record.opId)).toBe(true);
    expect(await accept()).toMatchObject({ ok: true, existing: true, record: { opId: first.record.opId } });
  });

  it("对话键只认键：同一条消息重发、模型这次提交得不一样也回原操作；按钮键换参拒绝", async () => {
    await accept();
    expect(await accept({ params: { chapter: 3, extra: true } })).toMatchObject({ ok: true, existing: true });
    const button = { requestKey: "button:b1", origin: { kind: "button" as const, messageId: "b1" }, writeScope: { chapters: [] } };
    expect(await accept(button)).toMatchObject({ ok: true, existing: false });
    expect(await accept({ ...button, params: { chapter: 4 } })).toMatchObject({ ok: false, code: "request_conflict" });
  });

  it("目录在、记录坏了 = 崩在受理中途：照常受理、整份覆盖", async () => {
    const opId = opIdFor("chat:m1:1");
    await mkdir(operationDir(book, opId), { recursive: true });
    await writeFile(join(operationDir(book, opId), "operation.json"), "{半截");
    expect(await readOperation(book, opId)).toEqual({ kind: "invalid" });
    expect(await accept()).toMatchObject({ ok: true, existing: false });
    expect((await readOperation(book, opId)).kind).toBe("record");
  });

  it("记录键对不上目录（别处拷来的）：算坏的", async () => {
    const opId = opIdFor("chat:m1:1");
    const first = await accept();
    if (!first.ok || !("record" in first)) throw new Error("没受理");
    await mkdir(operationDir(book, "op-other"), { recursive: true });
    await writeFile(join(operationDir(book, "op-other"), "operation.json"), await readFile(join(operationDir(book, opId), "operation.json"), "utf-8"));
    expect(await readOperation(book, "op-other")).toEqual({ kind: "invalid" });
  });

  it("请求太旧拒；缺标记拒；书不在拒", async () => {
    expect(await accept({ issuedAt: "2025-01-01T00:00:00.000Z" })).toMatchObject({ ok: false, code: "request_expired" });
    expect(await accept({ requestKey: " " })).toMatchObject({ ok: false, code: "invalid_request" });
    await rm(book, { recursive: true, force: true });
    expect(await accept()).toMatchObject({ ok: false, code: "book_gone" });
    await expect(readdir(book)).rejects.toThrow();
    await mkdir(book, { recursive: true });
  });
});

describe("写位", () => {
  it("queued / running 占位；等作者、暂停不占；终态不占", async () => {
    const first = await accept();
    if (!first.ok || !("record" in first)) throw new Error("没受理");
    expect(await accept({ requestKey: "chat:m2:1" })).toMatchObject({ ok: false, code: "target_busy", occupant: { opId: first.record.opId } });
    // 别的章不挡。
    expect(await accept({ requestKey: "chat:m3:1", writeScope: { chapters: [4] } })).toMatchObject({ ok: true });
    await changeOperation(book, first.record.opId, (current) => ({ ...current, state: "running", runEpoch: 1 }));
    expect(await accept({ requestKey: "chat:m2:1" })).toMatchObject({ ok: false, code: "target_busy" });
    await changeOperation(book, first.record.opId, (current) => ({ ...current, state: "waiting_author" }));
    expect(isScheduledHere(book, first.record.opId)).toBe(false);
    expect(await accept({ requestKey: "chat:m2:1" })).toMatchObject({ ok: true, existing: false });
  });
});

describe("改状态", () => {
  it("终态不再改；不允许的转换抛错；eventSeq 递增；writeScope、键改不了", async () => {
    const first = await accept();
    if (!first.ok || !("record" in first)) throw new Error("没受理");
    const opId = first.record.opId;
    const running = await changeOperation(book, opId, (current) => ({ ...current, state: "running", runEpoch: 1, writeScope: { chapters: [9] } }));
    expect(running).toMatchObject({ state: "running", eventSeq: 2, writeScope: { chapters: [3] } });
    await changeOperation(book, opId, (current) => ({ ...current, state: "succeeded" }));
    await expect(changeOperation(book, opId, (current) => ({ ...current, state: "running" }))).rejects.toBeInstanceOf(OperationTransitionError);
    await expect(changeOperation(book, opId, (current) => ({ ...current, result: "改结果" }))).rejects.toBeInstanceOf(OperationTransitionError);
  });

  it("锁序：拿着记录锁再要书锁直接抛错（不互等）", async () => {
    const first = await accept();
    if (!first.ok || !("record" in first)) throw new Error("没受理");
    await expect(withRecordLock(book, first.record.opId, () => changeOperation(book, first.record.opId, () => undefined))).rejects.toThrow("锁序错了");
    // 书锁 → 记录锁照常。
    await withBookLock(book, () => withRecordLock(book, first.record.opId, async () => undefined));
  });
});

describe("清理和墓碑", () => {
  it("结束超 30 天的清目录、留墓碑；同键重送回放墓碑、不重新开工；墓碑超 400 天删", async () => {
    const first = await accept();
    if (!first.ok || !("record" in first)) throw new Error("没受理");
    const opId = first.record.opId;
    await mkdir(join(operationDir(book, opId), "steps"), { recursive: true });
    await writeFile(join(operationDir(book, opId), "steps", "write.json"), "{}");
    await changeOperation(book, opId, (current) => ({ ...current, state: "cancelled" }), NOW);
    const later = new Date(NOW.getTime() + 31 * 24 * 3600 * 1000);
    expect(await pruneOperations(book, () => "停掉了", later)).toEqual({ cleared: [opId] });
    expect(await readdir(operationDir(book, opId))).toEqual(["operation.json"]);
    const replay = await acceptOperation(book, request(), { bookEpoch: epoch, now: later });
    expect(replay).toMatchObject({ ok: true, tombstone: { opId, state: "cancelled", summary: "停掉了" } });
    const muchLater = new Date(later.getTime() + 401 * 24 * 3600 * 1000);
    await pruneOperations(book, () => "", muchLater);
    expect((await readOperation(book, opId)).kind).toBe("absent");
  });

  it("没结束的不清（等作者、暂停也不清）", async () => {
    const first = await accept();
    if (!first.ok || !("record" in first)) throw new Error("没受理");
    await changeOperation(book, first.record.opId, (current) => ({ ...current, state: "paused", pauseReason: "budget" }), NOW);
    expect(await pruneOperations(book, () => "", new Date(NOW.getTime() + 90 * 24 * 3600 * 1000))).toEqual({ cleared: [] });
  });
});
