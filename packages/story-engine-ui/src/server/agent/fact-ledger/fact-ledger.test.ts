// @vitest-environment node
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  appendFacts,
  applyFactEdit,
  buildFactExtractionMessages,
  extractAndAppendFacts,
  parseFactExtraction,
  readFactLedger,
  validateNewCharacterNames,
} from "./fact-ledger.js";

const tmp = () => mkdtemp(join(tmpdir(), "fl-"));

describe("fact-ledger 抽取/解析", () => {
  it("buildFactExtractionMessages：含禁臆造/只抽正文真有/JSON-only，user 带正文", () => {
    const m = buildFactExtractionMessages("第七章正文……");
    expect(m[0].content).toContain("禁");
    expect(m[0].content).toMatch(/承诺|交易|金额/);
    expect(m[0].content).toContain("空数组");
    expect(m[1].content).toContain("第七章正文");
  });
  it("parseFactExtraction：抠 JSON、空 facts 合法、非 JSON 抛", () => {
    expect(parseFactExtraction('好的：{"facts":[{"text":"收3块、私下"}]}').facts).toEqual(["收3块、私下"]);
    expect(parseFactExtraction('{"facts":[]}').facts).toEqual([]);
    expect(() => parseFactExtraction("不是JSON")).toThrow();
  });
});

describe("fact-ledger · newCharacters（停脏+告知 第一步）", () => {
  it("parseFactExtraction：解析出 facts 与 newCharacters 两段", () => {
    const out = parseFactExtraction(
      '{"facts":[{"text":"林远转了3亿到离岸账户"}],"newCharacters":[{"name":"林静"}]}',
    );
    expect(out.facts).toEqual(["林远转了3亿到离岸账户"]);
    expect(out.newCharacters).toEqual(["林静"]);
  });

  it("parseFactExtraction：旧格式（无 newCharacters）向后兼容 → 空", () => {
    const out = parseFactExtraction('{"facts":[{"text":"约定私下交割"}]}');
    expect(out.facts).toEqual(["约定私下交割"]);
    expect(out.newCharacters).toEqual([]);
  });

  it("buildFactExtractionMessages：已知角色名喂进 prompt", () => {
    const [, user] = buildFactExtractionMessages("正文……", ["林远", "李慧"]);
    expect(user.content).toContain("林远");
    expect(user.content).toContain("李慧");
  });

  it("validateNewCharacterNames：留真名、丢畸形、排已知、去重", () => {
    const out = validateNewCharacterNames(
      ["林静", "林远", "", "这是一个很长的名字", "林 静", "李慧。", "周明", "周明"],
      new Set(["林远"]),
    );
    expect(out).toEqual(["林静", "周明"]);
  });

  it("extractAndAppendFacts：返回校验后的 newCharacters（排已知）", async () => {
    const dir = await tmp();
    const out = await extractAndAppendFacts({
      projectDir: dir,
      chapter: 1,
      draftText: "林远见了林静。",
      knownNames: ["林远"],
      callModel: async () => '{"facts":[],"newCharacters":[{"name":"林静"},{"name":"林远"}]}',
    });
    expect(out.ok).toBe(true);
    expect(out.newCharacters).toEqual(["林静"]);
  });

  it("extractAndAppendFacts：模型失败 → ok:false、newCharacters 空、不编造", async () => {
    const dir = await tmp();
    const out = await extractAndAppendFacts({
      projectDir: dir,
      chapter: 1,
      draftText: "正文……",
      callModel: async () => {
        throw new Error("boom");
      },
    });
    expect(out.ok).toBe(false);
    expect(out.newCharacters).toEqual([]);
  });
});

describe("fact-ledger 读写", () => {
  it("appendFacts：写盘 + 去重 + 分配 id + 缺文件自建", async () => {
    const dir = await tmp();
    expect(await appendFacts(dir, 7, ["收3块、私下", "收3块、私下"], "auto")).toBe(1); // 同章内去重
    expect(await appendFacts(dir, 7, ["收3块、私下"], "auto")).toBe(0);                 // 已存在不重复
    const led = await readFactLedger(dir);
    expect(led.facts).toHaveLength(1);
    expect(led.facts[0]).toMatchObject({ chapter: 7, text: "收3块、私下", source: "auto" });
    expect(led.facts[0].id).toMatch(/^fact-7-/);
  });
  it("applyFactEdit：add/update/remove", async () => {
    const dir = await tmp();
    await appendFacts(dir, 1, ["旧事实"], "auto");
    const id = (await readFactLedger(dir)).facts[0].id;
    await applyFactEdit(dir, "update", { id, text: "改后的事实" });
    expect((await readFactLedger(dir)).facts[0].text).toBe("改后的事实");
    await applyFactEdit(dir, "add", { chapter: 2, text: "新增事实" });
    expect((await readFactLedger(dir)).facts).toHaveLength(2);
    await applyFactEdit(dir, "remove", { id });
    const left = await readFactLedger(dir);
    expect(left.facts).toHaveLength(1);
    expect(left.facts[0].text).toBe("新增事实");
  });

  // 模型无关·canonical：id 带前后空白（网关常给尾换行）仍命中，不误报「没找到」。
  it("applyFactEdit：id 带空白也能 update/remove（trim 归一）", async () => {
    const dir = await tmp();
    await appendFacts(dir, 1, ["旧事实"], "auto");
    const id = (await readFactLedger(dir)).facts[0].id;
    const upd = await applyFactEdit(dir, "update", { id: `  ${id}  `, text: "空白id也改到了" });
    expect(upd.ok).toBe(true);
    expect((await readFactLedger(dir)).facts[0].text).toBe("空白id也改到了");
    const rem = await applyFactEdit(dir, "remove", { id: `\t${id}\n` });
    expect(rem.ok).toBe(true);
    expect((await readFactLedger(dir)).facts).toHaveLength(0);
  });

  it("applyFactEdit supersede：登记取代（标 supersededByChapter，不删、可带取代链）", async () => {
    const dir = await tmp();
    await appendFacts(dir, 7, ["资金冻结不能动"], "auto");
    const id = (await readFactLedger(dir)).facts[0].id;
    const res = await applyFactEdit(dir, "supersede", { id, chapter: 42, supersededByFactId: "fact-42-0" });
    expect(res.ok).toBe(true);
    const after = (await readFactLedger(dir)).facts[0];
    expect(after.supersededByChapter).toBe(42);
    expect(after.supersededByFactId).toBe("fact-42-0");
    expect(after.text).toBe("资金冻结不能动"); // 不删、原文保留
  });

  it("applyFactEdit supersede：缺 id/targetText 或缺章号 → ok:false 如实报", async () => {
    const dir = await tmp();
    await appendFacts(dir, 7, ["某事"], "auto");
    const id = (await readFactLedger(dir)).facts[0].id;
    expect((await applyFactEdit(dir, "supersede", { chapter: 9 })).ok).toBe(false); // 缺定位
    expect((await applyFactEdit(dir, "supersede", { id })).ok).toBe(false); // 缺章号
    expect((await applyFactEdit(dir, "supersede", { id: "nope", chapter: 9 })).ok).toBe(false); // id 不存在
  });

  it("applyFactEdit supersede by targetText：按描述找到那条并标取代（agent 不用知道 id）", async () => {
    const dir = await tmp();
    await appendFacts(dir, 7, ["林远的资金被冻结、暂时不能动用"], "auto");
    const res = await applyFactEdit(dir, "supersede", { targetText: "资金被冻结", chapter: 42 });
    expect(res.ok).toBe(true);
    const after = (await readFactLedger(dir)).facts.find((f) => f.text.includes("资金被冻结"));
    expect(after?.supersededByChapter).toBe(42);
  });

  it("applyFactEdit supersede by targetText：没匹配 / 多条匹配 → ok:false，不蒙混", async () => {
    const dir = await tmp();
    await appendFacts(dir, 7, ["林远资金被冻结", "林楚资金被冻结"], "auto");
    expect((await applyFactEdit(dir, "supersede", { targetText: "完全不沾边的描述", chapter: 9 })).ok).toBe(false); // 0 匹配
    const multi = await applyFactEdit(dir, "supersede", { targetText: "资金被冻结", chapter: 9 });
    expect(multi.ok).toBe(false); // 多条匹配 → 不猜
    expect(multi.summary).toContain("多条");
  });
});

describe("extractAndAppendFacts 编排", () => {
  it("有稿 → 调模型抽取 → 写盘 + 摘要带条数", async () => {
    const dir = await tmp();
    const callModel = vi.fn(async () => JSON.stringify({ facts: [{ text: "收3块、私下" }] }));
    const r = await extractAndAppendFacts({ projectDir: dir, chapter: 7, draftText: "正文", callModel });
    expect(r).toMatchObject({ ok: true, added: 1 });
    expect(r.summary).toContain("1 条");
    expect((await readFactLedger(dir)).facts).toHaveLength(1);
  });
  it("空稿 → 不抽、不报错", async () => {
    const dir = await tmp();
    const callModel = vi.fn();
    const r = await extractAndAppendFacts({ projectDir: dir, chapter: 1, draftText: "   ", callModel });
    expect(r).toMatchObject({ ok: true, added: 0 });
    expect(callModel).not.toHaveBeenCalled();
  });
  it("模型/解析失败 → 自动重试一次；仍失败非致命：ok:false + 如实说明，不抛", async () => {
    const dir = await tmp();
    const callModel = vi.fn(async () => "模型挂了不是JSON");
    const r = await extractAndAppendFacts({ projectDir: dir, chapter: 1, draftText: "正文", callModel });
    expect(callModel).toHaveBeenCalledTimes(2);
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("已自动重试一次");
    expect(r.summary).not.toContain("可让我重抽"); // 没有能重抽的工具，不许这么许诺
  });
  it("第一次失败、重试成功 → 照常写盘", async () => {
    const dir = await tmp();
    const callModel = vi.fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(JSON.stringify({ facts: [{ text: "南门菜场十年前就拆了" }] }));
    const r = await extractAndAppendFacts({ projectDir: dir, chapter: 4, draftText: "正文", callModel });
    expect(r).toMatchObject({ ok: true, added: 1 });
  });
});

describe("parseFactExtraction 宽进（模型无关）", () => {
  // 2026-10-08 十章验收第 8 章：旧 strict schema 下模型多给一个键，整章一条事实都没记上。
  it("条目多给键 / 顶层多给键 → 照收，多余的丢掉", () => {
    const out = parseFactExtraction(JSON.stringify({
      facts: [{ text: "登记表上地址是南门槐树巷十七号", chapter: 4, importance: "high" }],
      newCharacters: [{ name: "沈秀英", role: "配角" }],
      note: "多余的顶层键",
    }));
    expect(out.facts).toEqual(["登记表上地址是南门槐树巷十七号"]);
    expect(out.newCharacters).toEqual(["沈秀英"]);
  });
  it("条目给成纯字符串也收；坏条目逐条丢，不连坐整章", () => {
    const out = parseFactExtraction(JSON.stringify({ facts: ["座钟已修好送回周婶", 42, { text: "" }, { text: "车胎已补好" }] }));
    expect(out.facts).toEqual(["座钟已修好送回周婶", "车胎已补好"]);
  });
});

describe("事实编号", () => {
  it("删过条目后再加不撞号", async () => {
    const dir = await tmp();
    await appendFacts(dir, 3, ["甲", "乙", "丙"], "auto");
    expect((await applyFactEdit(dir, "remove", { id: "fact-3-0" })).ok).toBe(true);
    await appendFacts(dir, 3, ["丁"], "auto");
    const ids = (await readFactLedger(dir)).facts.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("fact-3-3");
  });
});

describe("书已删除", () => {
  it("书目录不在了 → 写账本报错，不凭空重建书目录", async () => {
    const dir = join(await tmp(), "gone");
    await expect(appendFacts(dir, 2, ["甲"], "auto")).rejects.toThrow();
    await expect(readFile(join(dir, "story", "fact-ledger.json"), "utf-8")).rejects.toThrow();
  });
});

describe("fact-ledger 数据完整性（Codex P1·2/3）", () => {
  it("修 P1·2：账本损坏(坏 JSON) → applyFactEdit ok:false，且坏文件不被覆盖", async () => {
    const dir = await tmp();
    const bad = "{ 这不是合法 JSON";
    await mkdir(join(dir, "story"), { recursive: true });
    await writeFile(join(dir, "story", "fact-ledger.json"), bad, "utf-8");
    const r = await applyFactEdit(dir, "add", { text: "林远拿到一张被冻结的银行卡", chapter: 1 });
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/损坏/);
    // 坏文件原样保留，没被覆盖成只有新事实的账本（绝不静默丢数据）
    expect(await readFile(join(dir, "story", "fact-ledger.json"), "utf-8")).toBe(bad);
  });

  it("修 P1·3：add 省略 chapter → ok:false（不再默认写第 0 章 fact-0-*）", async () => {
    const dir = await tmp();
    const r = await applyFactEdit(dir, "add", { text: "某条硬事实" });
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/第几章/);
    const { facts } = await readFactLedger(dir);
    expect(facts.some((f) => f.id.startsWith("fact-0-"))).toBe(false);
  });

  it("修 P1·3：add 带正整数 chapter → 正常 ok:true、id 用该章", async () => {
    const dir = await tmp();
    const r = await applyFactEdit(dir, "add", { text: "林远第3章拿到黑卡", chapter: 3 });
    expect(r.ok).toBe(true);
    const { facts } = await readFactLedger(dir);
    expect(facts.some((f) => f.id.startsWith("fact-3-"))).toBe(true);
  });
});
