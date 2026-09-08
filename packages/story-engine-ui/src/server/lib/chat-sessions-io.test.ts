import { mkdtemp, mkdir, readFile, readdir, rm, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readChatSessionIndex, createChatSession, readChatSession, renameChatSession,
  deleteChatSession, setActiveChatSession, saveChatSessionMessages,
  createChatSessionTransaction, switchChatSessionTransaction, deleteChatSessionTransaction,
  chatSessionsDir, chatSessionPath, failNextChatSessionIndexWriteForTests,
} from "./chat-sessions-io.js";
import { computeArchiveCursor, archiveOldMessages, unarchiveLast } from "./chat-sessions-io.js";
import {
  chatSessionArchivePath,
  computeHotWindowStart,
  HOT_WINDOW_BYTE_LIMIT,
  HOT_WINDOW_MAX_MESSAGES,
  HOT_WINDOW_MIN_MESSAGES,
  loadChatSessionForDisplay,
  settleInterruptedToolSteps,
  writeChatSession,
  type StoredMessage,
} from "./chat-sessions-io.js";

function longMsg(i: number) {
  // 每条约 200 个中文字 ~134 token,凑出可超预算的历史
  return { id: `m-${i}`, role: i % 2 === 0 ? "user" : "assistant", content: "字".repeat(200) } as const;
}

async function tmpProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "chat-sessions-"));
}

describe("chat-sessions-io CRUD", () => {
  it("无 index 时 readChatSessionIndex 自建一条空会话并设为 active", async () => {
    const dir = await tmpProject();
    const index = await readChatSessionIndex(dir);
    expect(index.sessions).toHaveLength(1);
    expect(index.activeSessionId).toBe(index.sessions[0].id);
    const session = await readChatSession(dir, index.activeSessionId);
    expect(session?.messages).toEqual([]);
    expect(session?.archivedCount).toBe(0);
  });

  it("create 追加会话、setActive 切换、rename 改名", async () => {
    const dir = await tmpProject();
    const first = (await readChatSessionIndex(dir)).activeSessionId;
    const second = await createChatSession(dir, "支线讨论");
    let index = await readChatSessionIndex(dir);
    expect(index.sessions).toHaveLength(2);
    expect(index.activeSessionId).toBe(second.id); // create 自动设为 active
    index = await setActiveChatSession(dir, first);
    expect(index.activeSessionId).toBe(first);
    index = await renameChatSession(dir, second.id, "改个名");
    expect(index.sessions.find((s) => s.id === second.id)?.name).toBe("改个名");
  });

  it("save 落 messages 可重读", async () => {
    const dir = await tmpProject();
    const id = (await readChatSessionIndex(dir)).activeSessionId;
    await saveChatSessionMessages(dir, id, [
      { id: "user-1", role: "user", content: "第一句" },
      { id: "assistant-1", role: "assistant", content: "回应" },
    ]);
    const session = await readChatSession(dir, id);
    expect(session?.messages.map((m) => m.content)).toEqual(["第一句", "回应"]);
  });

  it("save→read 保留 turnSnapshots（刷新后「撤销到此」仍可渲染）", async () => {
    const dir = await tmpProject();
    const id = (await readChatSessionIndex(dir)).activeSessionId;
    await saveChatSessionMessages(dir, id, [
      {
        id: "assistant-with-snap",
        role: "assistant",
        content: "已写入。",
        turnSnapshots: [{ toolName: "foundation_write", snapshotId: "snap-abc", chapterNumber: 1 }],
        aiReviewReport: { ok: true, summary: "审稿完成" },
      },
    ]);
    const session = await readChatSession(dir, id);
    const msg = session?.messages[0];
    expect(msg?.turnSnapshots).toEqual([
      { toolName: "foundation_write", snapshotId: "snap-abc", chapterNumber: 1 },
    ]);
    // agentTimelineModel.canUndo 条件：turnSnapshots.length > 0
    expect((msg?.turnSnapshots?.length ?? 0) > 0).toBe(true);
    expect(msg?.aiReviewReport).toEqual({ ok: true, summary: "审稿完成" });
  });

  it("删 active 自动转移；删到空自动建空会话；index 永远 >=1 且 active 有效", async () => {
    const dir = await tmpProject();
    const a = (await readChatSessionIndex(dir)).activeSessionId;
    const b = await createChatSession(dir, "B");
    let index = await deleteChatSession(dir, b.id); // 删的是 active(B)
    expect(index.sessions).toHaveLength(1);
    expect(index.activeSessionId).toBe(a);
    index = await deleteChatSession(dir, a); // 删到空
    expect(index.sessions).toHaveLength(1); // 自动补一条
    expect(index.sessions.some((s) => s.id === index.activeSessionId)).toBe(true);
  });

  it("transaction create/switch/delete return the committed active session and index in one lock", async () => {
    const dir = await tmpProject();
    const first = (await readChatSessionIndex(dir)).activeSessionId;
    const created = await createChatSessionTransaction(dir, "B");
    expect(created.index.activeSessionId).toBe(created.session.id);

    const switched = await switchChatSessionTransaction(dir, first);
    expect(switched.index.activeSessionId).toBe(first);
    expect(switched.session.id).toBe(first);

    const deleted = await deleteChatSessionTransaction(dir, first);
    expect(deleted.index.activeSessionId).toBe(created.session.id);
    expect(deleted.session.id).toBe(created.session.id);
    expect(await readChatSession(dir, first)).toBeNull();
  });

  it("transaction validation failure leaves active/session files unchanged", async () => {
    const dir = await tmpProject();
    const before = await readChatSessionIndex(dir);
    const activeBefore = await readChatSession(dir, before.activeSessionId);

    await expect(switchChatSessionTransaction(dir, "missing")).rejects.toThrow("会话不存在");
    await expect(deleteChatSessionTransaction(dir, "missing")).rejects.toThrow("会话不存在");

    expect(await readChatSessionIndex(dir)).toEqual(before);
    expect(await readChatSession(dir, before.activeSessionId)).toEqual(activeBefore);
  });

  it("create transaction removes the new session and preserves index when index write fails", async () => {
    const dir = await tmpProject();
    const before = await readChatSessionIndex(dir);
    const filesBefore = await readdir(chatSessionsDir(dir));
    failNextChatSessionIndexWriteForTests(dir);

    await expect(createChatSessionTransaction(dir, "will rollback")).rejects.toThrow("模拟 index 写入失败");

    expect(await readChatSessionIndex(dir)).toEqual(before);
    expect(await readdir(chatSessionsDir(dir))).toEqual(filesBefore);
  });

  it("原子写中途失败（rename 受阻）→ 抛错且不留 .tmp- 残留，原目标分毫未动", async () => {
    const dir = await tmpProject();
    await mkdir(chatSessionsDir(dir), { recursive: true });
    // 非空目录占住目标路径：rename(文件 → 非空目录) 必败，注入原子写收尾故障
    const blockedPath = chatSessionPath(dir, "ghost");
    await mkdir(join(blockedPath, "blocker"), { recursive: true });
    const ts = new Date().toISOString();

    await expect(writeChatSession(dir, {
      id: "ghost", name: "故障注入", messages: [], archivedCount: 0, createdAt: ts, updatedAt: ts,
    })).rejects.toThrow();

    const leftovers = (await readdir(chatSessionsDir(dir))).filter((name) => name.includes(".tmp-"));
    expect(leftovers).toEqual([]);
    expect(await readdir(blockedPath)).toEqual(["blocker"]);
  });

  it("delete refuses before mutation when the remaining active session is unreadable", async () => {
    const dir = await tmpProject();
    const active = (await readChatSessionIndex(dir)).activeSessionId;
    const target = await createChatSession(dir, "target");
    await setActiveChatSession(dir, active);
    const before = await readChatSessionIndex(dir);
    await rm(chatSessionPath(dir, active));

    await expect(deleteChatSessionTransaction(dir, target.id)).rejects.toThrow("活跃会话不可读");

    expect(await readChatSessionIndex(dir)).toEqual(before);
    expect(await readChatSession(dir, target.id)).not.toBeNull();
  });
});

async function seedChapterWorkspace(dir: string, chapter: number, contents: string[]) {
  const cw = join(dir, ".story-engine-ui", "chapter-workspaces");
  await mkdir(cw, { recursive: true });
  const pad = String(chapter).padStart(4, "0");
  const messages = contents.map((c, i) => ({ id: `m-${chapter}-${i}`, role: i % 2 === 0 ? "user" : "assistant", content: c }));
  await fsWriteFile(join(cw, `chapter-${pad}.json`), JSON.stringify({ chapter, messages }), "utf-8");
}

describe("chat-sessions-io 迁移", () => {
  it("多章 chapter-workspaces 按章升序拼成一条会话,逐条不丢", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chat-migrate-"));
    await seedChapterWorkspace(dir, 2, ["二章问", "二章答"]);
    await seedChapterWorkspace(dir, 1, ["一章问", "一章答"]);
    const index = await readChatSessionIndex(dir);
    expect(index.sessions).toHaveLength(1);
    const session = await readChatSession(dir, index.activeSessionId);
    const userTexts = session!.messages.filter((m) => m.role === "user").map((m) => m.content);
    expect(userTexts).toEqual(["一章问", "二章问"]); // 升序、零丢失
    expect(session!.name).toContain("按章");
  });

  it("无旧数据 → 建一条空会话", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chat-migrate-empty-"));
    const index = await readChatSessionIndex(dir);
    expect(index.sessions).toHaveLength(1);
    expect((await readChatSession(dir, index.activeSessionId))?.messages).toEqual([]);
  });

  it("index 已存在 → 幂等跳过迁移", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chat-migrate-idem-"));
    await seedChapterWorkspace(dir, 1, ["旧"]);
    const first = await readChatSessionIndex(dir);
    await seedChapterWorkspace(dir, 2, ["更旧"]); // 迁移后再塞,不应再被合并
    const second = await readChatSessionIndex(dir);
    expect(second.activeSessionId).toBe(first.activeSessionId);
    expect(second.sessions).toHaveLength(1);
  });
});

describe("chat-sessions-io 归档游标", () => {
  it("computeArchiveCursor 把活跃段压到 <=55% 预算,且至少保留最近 6 条", () => {
    const messages = Array.from({ length: 40 }, (_, i) => longMsg(i));
    const budget = 2000;
    const cursor = computeArchiveCursor(messages, budget);
    expect(cursor).toBeGreaterThan(0);
    expect(messages.length - cursor).toBeGreaterThanOrEqual(6);
  });

  it("消息很短不触阈值 → 游标为 0", () => {
    const messages = [
      { id: "m-1", role: "user", content: "嗨" },
      { id: "m-2", role: "assistant", content: "你好" },
    ] as const;
    expect(computeArchiveCursor([...messages], 96000)).toBe(0);
  });

  it("archive 只增游标 + 记 prevArchivedCount;unarchive 精确还原;messages 一条不删", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chat-archive-"));
    const id = (await readChatSessionIndex(dir)).activeSessionId;
    const messages = Array.from({ length: 40 }, (_, i) => longMsg(i));
    await saveChatSessionMessages(dir, id, messages as unknown);
    const res = await archiveOldMessages(dir, id, 2000);
    expect(res.archivedCount).toBeGreaterThan(0);
    expect(res.tokensAfter).toBeLessThan(res.tokensBefore);
    const after = await readChatSession(dir, id);
    expect(after?.messages).toHaveLength(40); // 没删,只动游标
    expect(after?.prevArchivedCount).toBe(0);
    const un = await unarchiveLast(dir, id);
    expect(un.archivedCount).toBe(0);
    expect((await readChatSession(dir, id))?.messages).toHaveLength(40);
  });
});

// 冷热分层 + 僵尸步骤结算（50 章耐力跑实测：250 条消息 1.4MB 撞保存墙；重载后字幕永挂「正在定稿…」）
describe("chat-sessions-io 冷热分层（loadChatSessionForDisplay）", () => {
  /** 约 8KB 的肥消息（贴近真实：内嵌工具步骤/报告的消息平均 ~6KB）。 */
  function fatMsg(i: number): StoredMessage {
    return { id: `fat-${i}`, role: "assistant", content: "实".repeat(2700) } as unknown as StoredMessage;
  }

  it("computeHotWindowStart：字节预算从尾往前切；小历史整窗保留", () => {
    expect(computeHotWindowStart([])).toBe(0);
    expect(computeHotWindowStart(Array.from({ length: 10 }, (_, i) => fatMsg(i)))).toBe(0);
    // 200 条 × ~8KB ≈ 1.6MB：热窗只留尾部 ~640KB
    const many = Array.from({ length: 200 }, (_, i) => fatMsg(i));
    const start = computeHotWindowStart(many);
    expect(start).toBeGreaterThan(0);
    const keptBytes = many.slice(start).reduce((sum, m) => sum + Buffer.byteLength(JSON.stringify(m), "utf8"), 0);
    expect(keptBytes).toBeLessThanOrEqual(HOT_WINDOW_BYTE_LIMIT);
    expect(many.length - start).toBeGreaterThanOrEqual(HOT_WINDOW_MIN_MESSAGES);
  });

  it("computeHotWindowStart：条数上限与最少保留两头兜底", () => {
    const tiny = Array.from({ length: HOT_WINDOW_MAX_MESSAGES + 50 }, (_, i) => ({ id: `t-${i}`, role: "user", content: "短" }));
    expect(computeHotWindowStart(tiny)).toBe(50); // 再小也不留超过上限条数
    const huge = Array.from({ length: HOT_WINDOW_MIN_MESSAGES + 5 }, (_, i) => ({ id: `h-${i}`, role: "user", content: "巨".repeat(200_000) }));
    expect(computeHotWindowStart(huge)).toBe(5); // 单条再大也至少保留最近 MIN 条
  });

  it("打开超窗会话 → 旧消息溢写冷归档（jsonl 可回读）、热文件只留尾窗、游标左移、重开幂等", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chat-spill-"));
    const id = (await readChatSessionIndex(dir)).activeSessionId;
    const messages = Array.from({ length: 120 }, (_, i) => fatMsg(i));
    await saveChatSessionMessages(dir, id, messages as unknown);
    await archiveOldMessages(dir, id, 2000); // 先制造一个非零 archivedCount 游标

    const before = await readChatSession(dir, id);
    const cursorBefore = before!.archivedCount;
    const loaded = await loadChatSessionForDisplay(dir, id);
    // 热窗头部必须有可见的归档标记（绝不静默搬走历史
    expect(loaded!.messages[0].id).toBe("sys-cold-archive");
    expect(loaded!.messages[0].content).toMatch(/更早的 \d+ 条对话已归档/u);
    const business = loaded!.messages.filter((m) => m.id !== "sys-cold-archive");
    const spilled = 120 - business.length;
    expect(spilled).toBeGreaterThan(0);
    expect(loaded!.coldArchivedCount).toBe(spilled);
    expect(loaded!.windowEpoch).toBe(1);
    // 热窗内容 = 原消息尾窗，顺序不变
    expect(business[0].id).toBe(`fat-${spilled}`);
    expect(business.at(-1)!.id).toBe("fat-119");
    // 游标随溢出量左移、不为负（标记插头部时非零游标 +1 保持边界语义）
    const expectedCursor = Math.max(0, cursorBefore - spilled);
    expect(loaded!.archivedCount).toBe(expectedCursor > 0 ? expectedCursor + 1 : 0);
    // 冷归档 jsonl：恰好是溢出的那段、可逐行回读
    const archived = (await readFile(chatSessionArchivePath(dir, id), "utf-8")).trim().split("\n").map((line) => JSON.parse(line) as { id: string });
    expect(archived).toHaveLength(spilled);
    expect(archived[0].id).toBe("fat-0");
    expect(archived.at(-1)!.id).toBe(`fat-${spilled - 1}`);
    // 热文件确实变小了
    const hotRaw = await readFile(chatSessionPath(dir, id), "utf-8");
    expect(Buffer.byteLength(hotRaw, "utf8")).toBeLessThan(900 * 1024);
    // 幂等：再开一次不再溢写、标记不重复、纪元不再涨
    const again = await loadChatSessionForDisplay(dir, id);
    expect(again!.messages).toHaveLength(loaded!.messages.length);
    expect(again!.messages.filter((m) => m.id === "sys-cold-archive")).toHaveLength(1);
    expect(again!.windowEpoch).toBe(1);
    expect((await readFile(chatSessionArchivePath(dir, id), "utf-8")).trim().split("\n")).toHaveLength(spilled);
  }, 20_000);

  it("窗口纪元对账：带过期纪元的保存被拒（旧页/他页全量回写），最新纪元照常保存", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chat-epoch-"));
    const id = (await readChatSessionIndex(dir)).activeSessionId;
    await saveChatSessionMessages(dir, id, Array.from({ length: 120 }, (_, i) => fatMsg(i)) as unknown);
    const loaded = await loadChatSessionForDisplay(dir, id); // 溢写 → epoch=1
    expect(loaded!.windowEpoch).toBe(1);

    // 旧标签页手里的过期副本（epoch=0、全量 200 条）回写 → 拒绝
    await expect(
      saveChatSessionMessages(dir, id, Array.from({ length: 120 }, (_, i) => fatMsg(i)) as unknown, 0),
    ).rejects.toThrow(/过期副本/);
    // 新页副本（epoch=1）正常保存
    await expect(
      saveChatSessionMessages(dir, id, loaded!.messages as unknown, 1),
    ).resolves.toBeUndefined();
    // 不带纪元（兼容路径）放行
    await expect(
      saveChatSessionMessages(dir, id, loaded!.messages as unknown),
    ).resolves.toBeUndefined();
  }, 20_000);

  it("窗口内小会话打开 → 零改动（文件不重写、updatedAt 不变）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chat-noop-"));
    const id = (await readChatSessionIndex(dir)).activeSessionId;
    await saveChatSessionMessages(dir, id, [{ id: "m-1", role: "user", content: "你好" }] as unknown);
    const before = await readChatSession(dir, id);
    const loaded = await loadChatSessionForDisplay(dir, id);
    expect(loaded!.updatedAt).toBe(before!.updatedAt);
    expect(loaded!.messages).toHaveLength(1);
  });
});

describe("settleInterruptedToolSteps（僵尸 running 步骤结算）", () => {
  it("running → partial + 诚实备注 + 补 endedAt；completed/failed 原样", () => {
    const messages = [
      {
        id: "a-1", role: "assistant", content: "干活中",
        toolSteps: [
          { id: "s1", label: "定稿", toolName: "commit_apply", status: "running", startedAt: 100 },
          { id: "s2", label: "写正文", toolName: "generate_draft", status: "completed", startedAt: 50, endedAt: 90 },
        ],
      },
    ] as unknown as StoredMessage[];
    const { messages: settled, settled: count } = settleInterruptedToolSteps(messages);
    expect(count).toBe(1);
    const steps = (settled[0] as unknown as { toolSteps: Record<string, unknown>[] }).toolSteps;
    expect(steps[0].status).toBe("partial");
    expect(typeof steps[0].endedAt).toBe("number");
    expect(String(steps[0].detail)).toContain("结果未回传");
    expect(steps[1].status).toBe("completed");
  });

  it("无 running 步骤 → 原引用返回（零成本）", () => {
    const messages = [{ id: "u-1", role: "user", content: "写下一章" }] as unknown as StoredMessage[];
    const { messages: out, settled } = settleInterruptedToolSteps(messages);
    expect(settled).toBe(0);
    expect(out[0]).toBe(messages[0]);
  });

  it("防误清守卫：空消息列表不得覆盖非空历史（加载失败后的自动保存误清，50 章书实测被炸）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chat-wipe-guard-"));
    const id = (await readChatSessionIndex(dir)).activeSessionId;
    await saveChatSessionMessages(dir, id, [
      { id: "m-1", role: "user", content: "写下一章" },
      { id: "m-2", role: "assistant", content: "好，正在写。" },
    ] as unknown);

    await expect(saveChatSessionMessages(dir, id, [] as unknown)).rejects.toThrow(/已拒绝保存/);
    // 历史完好
    expect((await readChatSession(dir, id))?.messages).toHaveLength(2);
    // 空会话保存空数组（如新书首次自动保存）照常放行
    const fresh = await createChatSession(dir, "空会话");
    await expect(saveChatSessionMessages(dir, fresh.id, [] as unknown)).resolves.toBeUndefined();
    // 非空收缩（撤销回退）照常放行
    await expect(saveChatSessionMessages(dir, id, [{ id: "m-1", role: "user", content: "写下一章" }] as unknown)).resolves.toBeUndefined();
    expect((await readChatSession(dir, id))?.messages).toHaveLength(1);
  });

  it("打开会话即结算：重载后不再有僵尸「正在…」步骤", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chat-settle-"));
    const id = (await readChatSessionIndex(dir)).activeSessionId;
    const session = await readChatSession(dir, id);
    await writeChatSession(dir, {
      ...session!,
      messages: [{
        id: "a-1", role: "assistant", content: "中断的一轮",
        toolSteps: [{ id: "s1", label: "定稿", toolName: "commit_apply", status: "running", startedAt: 1 }],
      }] as unknown as StoredMessage[],
    });
    const loaded = await loadChatSessionForDisplay(dir, id);
    const steps = (loaded!.messages[0] as unknown as { toolSteps: Record<string, unknown>[] }).toolSteps;
    expect(steps[0].status).toBe("partial");
    // 落盘持久：直接重读文件也已结算
    const reread = await readChatSession(dir, id);
    const rereadSteps = (reread!.messages[0] as unknown as { toolSteps: Record<string, unknown>[] }).toolSteps;
    expect(rereadSteps[0].status).toBe("partial");
  });
});
