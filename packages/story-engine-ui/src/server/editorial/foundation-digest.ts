/**
 * 设定本摘要（2026-10-14 编辑部 R7.3；重构 P9 改读设定卡）：把设定卡里能核的硬信息拼成一份「设定」交给核账员。
 *
 * 报告 3.3：爷爷「三年前过世」只写在人物卡里，核账不看设定本 → 第 3 章写「五年」漏报，
 * 第 6 章写「三年」反倒以第 3 章为准被报错。修法是把设定本作为一份对照材料进核账窗口（题材中立，
 * 不预设字段名，按项目里真实存的资料拼）；模型引的设定原文照样要经代码核对（settingQuoteLabel），
 * 抄不出的不算。纯读：不改正文、不写设定。
 */
import { quoteInText, readCardsOrLegacy, type Card, type SettingCardsFile } from "@actalk/story-core";
import { containsQuote, normalize } from "./continuity/check-chapter.js";

/** 一类设定（人物卡 / 地点 / 资产 / 世界规则）：label 进回执，text 是拼好的原文摘要（核对引文按它来）。 */
export interface SettingSection {
  readonly label: string;
  readonly text: string;
}

export interface FoundationDigest {
  readonly sections: readonly SettingSection[];
  /** 拼进核账窗口的整段文字（各节带小标题）。 */
  readonly text: string;
  /** 设定本太长被截断过：如实标出来，截掉的部分引文核对不上、自然不收。 */
  readonly truncated: boolean;
}

/** 设定摘要的预算：比一章笔记宽裕（设定是全书共用的硬信息），但不许把窗口撑爆。 */
export const FOUNDATION_DIGEST_MAX_CHARS = 8000;

const AI_MARK = "（AI 补的）";

/** 一张卡拼成一行：名字（主角 / 别名）打头，其余「栏名：内容」用分号隔；关系接在后面。只有名字，不带编号。 */
function cardLine(file: SettingCardsFile, card: Card): string {
  const head = `${card.name}${card.protagonist ? "（主角）" : ""}${card.aliases.length > 0 ? `（也叫：${card.aliases.join("、")}）` : ""}`;
  const names = new Map(file.cards.map((item) => [item.id, item.name] as const));
  const parts = [
    ...card.fields.map((field) => `${field.label}：${field.value}${field.by === "ai" ? AI_MARK : ""}`),
    ...file.relations
      .filter((relation) => relation.a === card.id || relation.b === card.id)
      .map((relation) => ({ other: names.get(relation.a === card.id ? relation.b : relation.a), relation }))
      .filter((item): item is { other: string; relation: SettingCardsFile["relations"][number] } => item.other !== undefined)
      .map(({ other, relation }) => `和${other}：${relation.label}${relation.by === "ai" ? AI_MARK : ""}`),
  ];
  return parts.length > 0 ? `${head}——${parts.join("；")}` : head;
}

/**
 * 读设定本拼摘要（重构 P9 改读设定卡）。设定本是空的（新建的书）→ undefined（核账照旧，不提示设定）；
 * 设定卡坏了由调用方按失败如实记。sections 按故事设定 → 人物 → 地点 → 物品 → 其他设定排，空的不进。
 * 设定卡上只有稳定的东西：会变的现状（东西在谁手里、人在哪）在账里，不进这里。
 */
export async function readFoundationDigest(projectDir: string): Promise<FoundationDigest | undefined> {
  const file = await readCardsOrLegacy(projectDir);
  const byKind = (kind: Card["kind"]): string[] => file.cards.filter((card) => card.kind === kind).map((card) => cardLine(file, card));
  const blocks: readonly { readonly label: string; readonly lines: readonly string[] }[] = [
    { label: "故事设定", lines: file.story.fields.map((field) => `${field.label}：${field.value}${field.by === "ai" ? AI_MARK : ""}`) },
    { label: "人物卡", lines: byKind("character") },
    { label: "地点", lines: byKind("place") },
    { label: "物品", lines: byKind("item") },
    { label: "其他设定", lines: byKind("lore") },
  ];
  const present = blocks.filter((block) => block.lines.length > 0);
  if (present.length === 0) return undefined;
  let truncated = false;
  const sections = present.map((block) => {
    const lines = [...block.lines];
    let text = `【${block.label}】\n${lines.join("\n")}`;
    while (text.length > FOUNDATION_DIGEST_MAX_CHARS && lines.length > 1) {
      lines.pop();
      truncated = true;
      text = `【${block.label}】\n${lines.join("\n")}`;
    }
    return { label: block.label, text };
  });
  return {
    sections,
    text: sections.map((section) => section.text).join("\n"),
    truncated,
  };
}

/** 拼进核账窗口的那段话：小标题 + 各节原文摘要（＋截断说明）。 */
export function foundationMessage(digest: FoundationDigest): string {
  return [
    "【设定本（作者定的硬设定：故事设定、人物、地点、物品、其他设定）】",
    "（东西在谁手里、人在哪这类会变的现状不在这里，以前文正文为准。标着「AI 补的」是 AI 补、作者还没认下的：和正文对不上时以正文为准，不算正文的错。）",
    digest.text,
    ...(digest.truncated ? ["（设定本太长，这里只给了前面一部分。）"] : []),
  ].join("\n");
}

/**
 * 一句「设定原文」真在设定本里吗：在 → 返回它所在那节的 label（故事设定 / 人物卡 / 地点 / 物品 / 其他设定）；不在 → undefined。
 * 模型抄设定常拿省略号接上人名和字段（「韩德顺……外貌：左腿有旧伤」）：按核心的 quoteInText 每段依次在同一节里找到也算。
 */
export function settingQuoteLabel(digest: FoundationDigest, quote: string): string | undefined {
  if (normalize(quote).length < 4) return undefined;
  for (const section of digest.sections) {
    if (containsQuote(normalize(section.text), quote) || quoteInText(quote, section.text)) return section.label;
  }
  return undefined;
}
