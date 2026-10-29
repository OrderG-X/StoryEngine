// @vitest-environment node
// 模型调用记账：beforeSend 核身份和额度、结算、结果不明暂停（写作版本 P2a 设计第四节）。
import { readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBookEpoch } from "@actalk/story-core";
import { createStoryProject } from "../../book/project-store.js";
import { makeHomeTempDir } from "../home-test-tmp.js";
import { beforeSend, BudgetExceededError, countsTowardBudget, listAttempts, unsettledUnknowns, usedBudget } from "./attempts.js";
import { __resetExecutionsForTests, OperationStopped, registerExecution, type OperationContext } from "./context.js";
import { __resetOperationStoreForTests, acceptOperation, changeOperation, operationDir, readOperation } from "./store.js";

let root: string;
let book: string;
const target = { provider: "测试", model: "m", quotaGroup: "g" };

beforeEach(async () => {
  __resetOperationStoreForTests();
  __resetExecutionsForTests();
  root = await makeHomeTempDir("operations-attempts-");
  ({ projectDir: book } = await createStoryProject({ rootDir: root, title: "记账", genre: "悬疑", protagonistName: "林远" }));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function running(key = "chat:m1:1", limit = 5): Promise<OperationContext> {
  const accepted = await acceptOperation(book, {
    requestKey: key, issuedAt: new Date().toISOString(), kind: "inspect.run", mode: "inspect", params: {}, recipeVersion: 1,
    origin: { kind: "chat", messageId: key }, writeScope: { chapters: [] }, budget: { limit },
  }, { bookEpoch: () => readBookEpoch(book) });
  if (!accepted.ok || !("record" in accepted)) throw new Error(JSON.stringify(accepted));
  const record = await changeOperation(book, accepted.record.opId, (current) => ({ ...current, state: "running", runEpoch: 1 }));
  const execution = registerExecution(book, accepted.record.opId, 1);
  return { bookDir: book, opId: accepted.record.opId, runEpoch: 1, bookEpoch: record!.bookEpoch, signal: execution.signal, lane: "foreground", step: { id: "check", exec: "1:check:1" } };
}

describe("发之前", () => {
  it("落一份 sending 再放行；结算改成 settled、带类别和计费；只结一次", async () => {
    const context = await running();
    const ticket = await beforeSend(context, target);
    expect(await listAttempts(book, context.opId)).toMatchObject([{ attemptId: ticket.attemptId, state: "sending", stepId: "check", exec: "1:check:1", runEpoch: 1 }]);
    await ticket.settle({ class: "ok", status: 200, usage: { totalTokens: 10 } });
    await ticket.settle({ class: "unknown" });
    expect(await listAttempts(book, context.opId)).toMatchObject([{ state: "settled", class: "ok", billing: "known", counted: true, usage: { totalTokens: 10 } }]);
  });

  it("额度：sending 和占额度的算；没发出去、429 不算；到上限 → 暂停（budget）、抛错、不落 attempt", async () => {
    const context = await running("chat:m1:1", 3);
    const a = await beforeSend(context, target);
    await a.settle({ class: "not_sent", note: "连不上" });
    const b = await beforeSend(context, target);
    await b.settle({ class: "rejected", status: 429 });
    await beforeSend(context, target);
    const c = await beforeSend(context, target);
    await c.settle({ class: "rejected", status: 500 });
    expect(usedBudget(await listAttempts(book, context.opId))).toBe(2);
    await beforeSend(context, target);
    await expect(beforeSend(context, target)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(await listAttempts(book, context.opId)).toHaveLength(5);
    expect(context.signal.aborted).toBe(true);
    expect(await readOperation(book, context.opId)).toMatchObject({ record: { state: "paused", pauseReason: "budget", runEpoch: 2 } });
  });

  it("停了、换了 runEpoch：不落 attempt、不放行", async () => {
    const context = await running();
    await changeOperation(book, context.opId, (current) => ({ ...current, state: "cancelled", runEpoch: 2 }));
    await expect(beforeSend(context, target)).rejects.toBeInstanceOf(OperationStopped);
    const controller = new AbortController();
    controller.abort();
    const other = await running("chat:m2:1");
    await expect(beforeSend({ ...other, signal: controller.signal }, target)).rejects.toBeInstanceOf(OperationStopped);
    expect(await listAttempts(book, context.opId)).toHaveLength(0);
    expect(await listAttempts(book, other.opId)).toHaveLength(0);
  });
});

describe("结果不明", () => {
  it("结成 unknown → 暂停（attempt_unknown）；之后别的调用放不出去", async () => {
    const context = await running();
    const ticket = await beforeSend(context, target);
    await ticket.settle({ class: "unknown", note: "流断了" });
    expect(await readOperation(book, context.opId)).toMatchObject({ record: { state: "paused", pauseReason: "attempt_unknown" } });
    await expect(beforeSend(context, target)).rejects.toBeInstanceOf(OperationStopped);
    const attempts = await listAttempts(book, context.opId);
    expect(unsettledUnknowns(attempts, [])).toHaveLength(1);
    expect(unsettledUnknowns(attempts, [ticket.attemptId])).toHaveLength(0);
  });

  it("取消之后照样能结（只改那一个 attempt 文件，不动记录）", async () => {
    const context = await running();
    const ticket = await beforeSend(context, target);
    await changeOperation(book, context.opId, (current) => ({ ...current, state: "cancelled", runEpoch: 2 }));
    await ticket.settle({ class: "cancelled" });
    expect(await listAttempts(book, context.opId)).toMatchObject([{ state: "settled", class: "cancelled", billing: "unknown", counted: true }]);
    expect(await readOperation(book, context.opId)).toMatchObject({ record: { state: "cancelled", runEpoch: 2 } });
  });

  it("书搬走了再结：不报错、不在原处建目录", async () => {
    const context = await running();
    const ticket = await beforeSend(context, target);
    const moved = `${book}-moved`;
    await rename(book, moved);
    await expect(ticket.settle({ class: "ok" })).resolves.toBeUndefined();
    await expect(stat(book)).rejects.toThrow();
    expect(await readdir(join(moved, operationDir(book, context.opId).slice(book.length + 1), "attempts"))).toHaveLength(1);
  });
});

describe("占额度", () => {
  it("没发出去、429 不占；别的都占", () => {
    expect(countsTowardBudget({ class: "not_sent" })).toBe(false);
    expect(countsTowardBudget({ class: "rejected", status: 429 })).toBe(false);
    expect(countsTowardBudget({ class: "rejected", status: 401 })).toBe(true);
    expect(countsTowardBudget({ class: "unusable" })).toBe(true);
    expect(countsTowardBudget({ class: "policy_abort" })).toBe(true);
  });
});
