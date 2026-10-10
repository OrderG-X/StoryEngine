import { describe, expect, it } from "vitest";
import { isQualityLead } from "../lead-intent-tracking.js";

describe("lead 质量闸", () => {
  it("丢弃截断半句", () => { expect(isQualityLead("么东西发出轻微的响动", "么东西发出轻微的响动")).toBe(false); });
  it("丢弃否定/无意义", () => {
    expect(isQualityLead("没有异常", "看不出任何异常")).toBe(false);
    expect(isQualityLead("线索太碎", "这些线索太碎了")).toBe(false);
  });
  it("保留成句的真线索", () => { expect(isQualityLead("抽屉夹层藏着借条", "林远在抽屉最深处的夹层发现一张借条")).toBe(true); });
  // Codex 1-5 章真机：threads.json 出现「就把线索拆散了夹在这些没」——从句中截出的连词起头半句病句。
  it("丢弃连词/介词起头的半句病句（就把…夹在这些没）", () => {
    expect(isQualityLead("就把线索拆散了夹在这些没", "但他怕自己忘了，就把线索拆散了夹在这些没人看的旧书里。")).toBe(false);
  });
  it("连词拒判不误杀已重锚到名词起头的真线索", () => {
    expect(isQualityLead("后墙异常响动", "他听见后墙传来异常响动")).toBe(true);
    expect(isQualityLead("失踪真相的依仗", "这是查清失踪真相的依仗")).toBe(true);
  });
});

// Codex 5 章 E2E·P1：threads.json 出现垃圾标题「三条线索」（枚举 meta）和「线索闭环了」（收束 meta）——
// 都是谈论「线索」这套系统本身、没有具体故事名物锚点的总结句，被当真线索登记。
describe("lead 质量闸·拒元叙述/总结句标题（Codex 5 章 E2E）", () => {
  it("丢弃枚举 meta「三条线索」和收束 meta「线索闭环了」", () => {
    expect(isQualityLead("三条线索", "三条线索：新换的锁、蓝色棉线、缺失的地图一角。")).toBe(false);
    expect(isQualityLead("线索闭环了", "线索闭环了。")).toBe(false);
    expect(isQualityLead("这些线索", "这些线索都指向同一个人。")).toBe(false);
  });
  it("不误杀带具体名物/人物锚点的真线索（线索指向X 仍是好线索）", () => {
    expect(isQualityLead("账册暗号指向库房", "林远发现账册暗号指向库房。")).toBe(true);
    expect(isQualityLead("后墙异常响动", "他听见后墙传来异常响动")).toBe(true);
    expect(isQualityLead("失踪真相的依仗", "这是查清失踪真相的依仗")).toBe(true);
    expect(isQualityLead("线索指向赵叔", "所有线索指向赵叔。")).toBe(true);
  });
});
