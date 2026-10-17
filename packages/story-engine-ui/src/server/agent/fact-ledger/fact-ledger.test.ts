// @vitest-environment node
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendFacts,
  applyFactEdit,
  readFactLedger,
  validateNewCharacterNames,
} from "./fact-ledger.js";

const tmp = () => mkdtemp(join(tmpdir(), "fl-"));

describe("fact-ledger · newCharacters（停脏+告知 第一步）", () => {
  it("validateNewCharacterNames：留真名、丢畸形、排已知、去重", () => {
    const out = validateNewCharacterNames(
      ["林静", "林远", "", "这是一个很长的名字", "林 静", "李慧。", "周明", "周明"],
      new Set(["林远"]),
    );
    expect(out).toEqual(["林静", "周明"]);
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
