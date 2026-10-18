/**
 * r5-longform-fixture.mjs —— R5「长篇 token 收敛验证」用的 **程序化合成 180 章 fixture** 生成器。
 *
 * 目的：给 buildWriterContext（引擎 context-gateway.ts）造一本「填满到 180 章」的假书，
 * 让主 agent 随后在 180 章尺度下采样 token、判断 rankContext 裁剪后是否收敛。
 * **不烧 GLM、不 commit、纯文件 I/O + buildWriterContext 自检。**
 *
 * 用法（主流程）：
 *   node scripts/r5-longform-fixture.mjs            # 建到 ~/StoryEngine-NG-r5/story-engine/r5fix + seed + 自检
 *
 * 题材中立：用都市/通用题材，绝不抄 longform-smoke 的末日/林序财团硬编码词。
 * 角色/地点名自起中性的（避免触发引擎残留的题材 warning 干扰）。
 *
 * 老引擎函数（createStoryProject/buildWriterContext/toSafeCharacterId）已搬进 src/server/book、src/server/writing，经 r3-ts-hooks 动态 import。
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

register("./r3-ts-hooks.mjs", import.meta.url);

const { createStoryProject, toSafeCharacterId } = await import("../src/server/book/project-store.ts");
const { buildWriterContext } = await import("../src/server/writing/context-gateway.ts");

// ---------------------------------------------------------------------------
// 中性题材资料（都市生活 / 创业团队，无系统无金手指、无末日、非林序财团）
// ---------------------------------------------------------------------------

const PROTAGONIST_NAME = "沈知澜";

/** 主角 + 5 配角（id/name/role 齐全；配角带做厚 + 关系账本）。 */
const CAST = [
  {
    id: "char-shen-zhilan",
    name: PROTAGONIST_NAME,
    role: "主角",
    isProtagonist: true,
    age: "27岁",
    gender: "女",
    identity: "城南创意工作室创始人",
    desire: "把濒临散伙的小团队带成一家立得住的设计公司。",
    weakness: "凡事自己扛，不擅长把压力分出去，常常熬到深夜。",
    speechStyle: "语速偏快、就事论事，遇到分歧先复述对方观点再表态。",
    speechSamples: ["先把问题摆桌面上，再决定谁来扛。", "这事我盯，但别让我一个人扛。"],
    behaviorBoundaries: ["不会当众否定队友，私下才提意见。", "不轻易承诺自己兑现不了的工期。"],
    knowledgeKnown: ["工作室账上只够撑三个月。", "城南租约年底到期。"],
    knowledgeUnknown: ["合伙人私下接洽的那家投资方底细。", "老客户突然撤单的真实原因。"],
    cannotDo: ["不会突然拿到一大笔不明来源的资金。", "不会无视团队反对独断拍板。"],
    extraFields: {
      内核人格: "把责任感当本能，越是要散越要顶上去。",
      叙事岗位: "全书行动轴心，所有线索的汇聚点与决策人。",
      成长方向: "学会信任与放权，从独自硬扛走向真正带队。",
      口头禅: "摆桌面上说。",
    },
  },
  {
    id: "char-lu-mingzhou",
    name: "陆鸣州",
    role: "联合创始人 / 技术合伙人",
    age: "30岁",
    gender: "男",
    relationshipToProtagonist: "创业最早的合伙人，亦友亦对手，常在方向上与主角拉扯。",
    trustLevel: "high",
    relationshipDynamics: [
      "情感债：三年前主角拉他离职一起创业，他欠这份信任。",
      "关系红线：可以争吵，但绝不在客户面前互相拆台。",
      "潜在裂痕：他私下接洽投资方未提前告知主角。",
    ],
    extraFields: {
      内核人格: "理性到近乎冷的工程脑，认数据不认情面。",
      叙事岗位: "主角的镜子与最大变量，推动「信任 vs 现实」主冲突。",
      关系底色: "并肩多年的战友，分歧越大越说明在乎。",
    },
  },
  {
    id: "char-qiao-wei",
    name: "乔薇",
    role: "运营负责人",
    age: "26岁",
    gender: "女",
    relationshipToProtagonist: "主角一手带出来的后辈，最坚定的支持者，也最怕主角累垮。",
    trustLevel: "high",
    relationshipDynamics: [
      "情感债：主角在她最低谷时给了第一份正式工作。",
      "关系红线：再忙也要替主角守住底线，不让她被人占便宜。",
    ],
    extraFields: {
      内核人格: "外柔内韧，擅长把混乱的人情捋顺。",
      叙事岗位: "团队黏合剂，承接主角的情绪与团队的暗流。",
    },
  },
  {
    id: "char-fang-cheng",
    name: "方程",
    role: "老客户 / 关键甲方",
    age: "41岁",
    gender: "男",
    relationshipToProtagonist: "工作室最大金主，欣赏主角又习惯压价，关系微妙。",
    trustLevel: "medium",
    relationshipDynamics: [
      "利益绑定：他的订单占工作室一半流水，撤单即重伤。",
      "关系红线：欣赏归欣赏，谈钱绝不手软。",
    ],
    extraFields: {
      内核人格: "精明老练，把人情都折算进成本。",
      叙事岗位: "外部压力源，用商业现实不断逼主角做取舍。",
    },
  },
  {
    id: "char-jiang-su",
    name: "江夙",
    role: "投资人 / 神秘来客",
    age: "35岁",
    gender: "男",
    relationshipToProtagonist: "半路出现的投资方代表，态度暧昧，意图不明。",
    trustLevel: "low",
    relationshipDynamics: [
      "潜在威胁：他和合伙人的私下接洽绕过了主角。",
      "关系红线：在看清他真实意图前，主角不会签任何字。",
    ],
    extraFields: {
      内核人格: "进退有度、滴水不漏，永远比对方多算一步。",
      叙事岗位: "悬念担当，他的真实目的是中盘最大谜面。",
    },
  },
  {
    id: "char-wen-xi",
    name: "温晞",
    role: "新晋设计师 / 团队新人",
    age: "23岁",
    gender: "女",
    relationshipToProtagonist: "刚入职的应届生，把主角当榜样，带来新鲜视角也带来麻烦。",
    trustLevel: "medium",
    relationshipDynamics: [
      "情感债：主角顶着合伙人反对把她招了进来。",
      "关系红线：再喜欢她的灵气，也不能让新人坏了交付质量。",
    ],
    extraFields: {
      内核人格: "天真锋利，敢想敢闯但不知深浅。",
      叙事岗位: "变量与催化剂，用新人视角戳破团队的旧习惯。",
    },
  },
];

const PROTAGONIST = CAST[0];
const SUPPORTING = CAST.slice(1);

/** 5-8 个地点（含 spatialStructure）。 */
const LOCATIONS = [
  {
    id: "loc-chengnan-studio",
    name: "城南创意工作室",
    type: "主场景",
    locationType: "办公空间",
    parentLocation: "城南旧厂区",
    spatialStructure: {
      floors: ["一层共享区", "二层设计间", "夹层小会议室"],
      rooms: ["开放工位区", "样品打印间", "茶水角", "玻璃会议室"],
      entrances: ["旧厂区铁门", "侧巷小门"],
      exits: ["货梯通道", "天台楼梯"],
    },
    connectedLocations: ["江畔咖啡馆", "城南旧厂区", "环线写字楼"],
    travelRules: [
      { targetLocation: "江畔咖啡馆", method: "walk", durationMinutes: 8, constraint: "出侧巷小门沿江步行约8分钟。" },
      { targetLocation: "环线写字楼", method: "taxi", durationMinutes: 22, constraint: "去甲方需打车约22分钟。" },
    ],
    knownFeatures: ["老厂房改造的挑高空间", "整面的样品墙", "公用的大打印机"],
    resources: ["共享设备", "样品打印机", "茶水角"],
    risks: ["租约年底到期", "夹层会议室隔音差，谈事容易被听见"],
    fixedFacts: ["一层是共享区", "二层是设计间", "夹层只有一间小会议室"],
    extraFields: { 空间气质: "旧厂房的粗粝感配上设计师的讲究，处处是矛盾的体面。" },
  },
  {
    id: "loc-river-cafe",
    name: "江畔咖啡馆",
    type: "常用场景",
    locationType: "商业空间",
    spatialStructure: { rooms: ["临窗卡座", "吧台", "半开放包间"], entrances: ["临江正门"], exits: ["后巷门"] },
    connectedLocations: ["城南创意工作室"],
    travelRules: [{ targetLocation: "城南创意工作室", method: "walk", durationMinutes: 8 }],
    knownFeatures: ["落地窗正对江面", "老板娘记得熟客口味"],
    resources: ["安静的谈事角落", "稳定的无线网"],
    risks: ["熟人多，谈机密容易被撞见"],
    fixedFacts: ["临窗卡座是主角谈事的固定位"],
  },
  {
    id: "loc-ring-tower",
    name: "环线写字楼",
    type: "甲方场景",
    locationType: "商务楼宇",
    spatialStructure: { floors: ["大堂", "18层方程办公室", "顶层会客厅"], entrances: ["旋转门"], exits: ["地库电梯"] },
    connectedLocations: ["城南创意工作室"],
    knownFeatures: ["需访客登记", "18层是甲方常驻楼层"],
    resources: ["正式会议室", "投影设备"],
    risks: ["甲方主场，节奏被对方掌控"],
    fixedFacts: ["方程办公室在18层"],
  },
  {
    id: "loc-old-factory",
    name: "城南旧厂区",
    type: "外围场景",
    locationType: "城区片区",
    spatialStructure: { rooms: ["闲置仓库", "中央空场", "门卫室"], entrances: ["主铁门"], exits: ["北侧缺口"] },
    connectedLocations: ["城南创意工作室"],
    knownFeatures: ["半数厂房闲置", "夜里只有零星路灯"],
    resources: ["可临时借用的空场地"],
    risks: ["夜间偏僻", "传闻要整片改造拆迁"],
    fixedFacts: ["工作室所在楼栋属于旧厂区"],
  },
  {
    id: "loc-night-market",
    name: "城东夜市",
    type: "生活场景",
    locationType: "街区",
    spatialStructure: { rooms: ["大排档区", "手作摊位街", "江堤步道"], entrances: ["夜市牌坊"], exits: ["地铁口"] },
    knownFeatures: ["团队加班后常来的放风地", "摊主大多认识这帮设计师"],
    resources: ["便宜管饱的夜宵", "放松谈心的氛围"],
    risks: ["人声嘈杂，正事谈不深"],
    fixedFacts: ["团队庆功/泄气都默认来这里"],
  },
  {
    id: "loc-her-apartment",
    name: "主角的临江公寓",
    type: "私人场景",
    locationType: "住所",
    spatialStructure: { rooms: ["开放厨房", "靠窗工作台", "卧室"], entrances: ["公寓门"], exits: ["消防通道"] },
    knownFeatures: ["靠窗工作台堆满草图", "深夜亮着的唯一一盏灯"],
    resources: ["独处思考的空间"],
    risks: ["把工作带回家，几乎不真正休息"],
    fixedFacts: ["工作台正对江面"],
  },
];

// ---------------------------------------------------------------------------
// 程序化「累积」内容片段（题材中立、随章数递增）
// ---------------------------------------------------------------------------

const CHAR_NAMES = CAST.map((c) => c.name);
const LOC_NAMES = LOCATIONS.map((l) => l.name);

/** 题材中立的递进动作模板：第 N 章主角推进了某条线。 */
const ACTION_TEMPLATES = [
  "为保住下一笔订单临时改了方案",
  "和合伙人就方向分歧摊了一次牌",
  "顶着压力守住了交付质量的底线",
  "替团队挡下了一次甲方的压价",
  "在加班的深夜重新理清了优先级",
  "试着把一部分担子分给了队友",
  "撞见了一条不该这么早知道的消息",
  "为新人的失误兜了底也立了规矩",
  "在咖啡馆敲定了一个折中方案",
  "因投资方的暧昧态度犹豫了一整夜",
];

function pick(list, i) {
  return list[i % list.length];
}

function pad4(n) {
  return String(n).padStart(4, "0");
}

// ---------------------------------------------------------------------------
// 各文件构造器
// ---------------------------------------------------------------------------

function buildTimelineEvents(chapters) {
  const events = [];
  for (let chapter = 1; chapter <= chapters; chapter += 1) {
    const loc = pick(LOC_NAMES, chapter);
    const altLoc = pick(LOC_NAMES, chapter + 2);
    // 每章在场角色：主角 + 轮换两个配角（让 mentionedCharacterNames 多样）。
    const c1 = pick(SUPPORTING, chapter).name;
    const c2 = pick(SUPPORTING, chapter + 1).name;
    const action = pick(ACTION_TEMPLATES, chapter);
    events.push({
      id: `evt-${pad4(chapter)}`,
      chapter,
      summary: `第${chapter}章：${PROTAGONIST_NAME}${action}，与${c1}的关系往前推了一步。`,
      participants: [PROTAGONIST_NAME, c1, c2],
      effects: {
        // semanticSummary 是 buildStoryContinuityContext 读的关键结构（mainEvent/conflict/discovery/nextLead/locations/mentionedCharacterNames）。
        semanticSummary: {
          mainEvent: `${PROTAGONIST_NAME}${action}。`,
          conflict: `${c1}与${PROTAGONIST_NAME}在该如何取舍上各执一端。`,
          discovery: `关于${c2}的一个新细节浮出水面。`,
          nextLead: `下一步需要确认${altLoc}那边的进展，并安抚${c2}。`,
          locations: [loc, altLoc],
          mentionedCharacterNames: [PROTAGONIST_NAME, c1, c2],
        },
        // 题材中立的机械状态变化，模拟 commit 累积的 effects 体量。
        stateDelta: { chapter, phase: chapter <= 60 ? "起步" : chapter <= 120 ? "扩张" : "整合" },
      },
    });
  }
  return events;
}

function buildFactLedger(chapters) {
  const facts = [];
  let seq = 0;
  for (let chapter = 1; chapter <= chapters; chapter += 1) {
    // 每章 2-4 条（按章号确定性地在 2..4 之间循环）。
    const count = 2 + (chapter % 3);
    for (let k = 0; k < count; k += 1) {
      seq += 1;
      const id = `fact-${pad4(seq)}`;
      const name = pick(CHAR_NAMES, chapter + k);
      const loc = pick(LOC_NAMES, chapter + k);
      // 约 30% 带有效区间：模拟「该事实在某章被取代」。每隔约 3 条挑一条标 supersededBy。
      const withInterval = seq % 3 === 0;
      const base = {
        id,
        chapter,
        text:
          k === 0
            ? `第${chapter}章确立：${name}在${loc}做出的承诺仍然有效（编号${seq}，金额约${(chapter % 9) + 1}万）。`
            : `第${chapter}章记录：${name}与${PROTAGONIST_NAME}就${loc}的安排达成了一项约定（编号${seq}）。`,
        source: k === 0 ? "manual" : "auto",
      };
      if (withInterval) {
        const supersededAt = Math.min(chapters + 1, chapter + 5 + (seq % 7));
        facts.push({
          ...base,
          effectiveFromChapter: chapter,
          supersededByChapter: supersededAt,
          supersededByFactId: `fact-superseder-${pad4(seq)}`,
        });
      } else {
        facts.push(base);
      }
    }
  }
  return { version: "v0", facts };
}

function buildHookPool(chapters) {
  const hooks = [];
  const total = 60;
  for (let i = 1; i <= total; i += 1) {
    const firstSeen = Math.max(1, Math.round((i / total) * chapters) - 3);
    const lastTouched = Math.min(chapters, firstSeen + 2 + (i % 9));
    // 状态分布：让 seeded/active 占多数（buildHookTrackingContext + selectHooks 才有料），少量 resolved/inactive。
    const status =
      i % 7 === 0 ? "resolved" : i % 5 === 0 ? "inactive" : i % 2 === 0 ? "active" : "seeded";
    const c1 = pick(CHAR_NAMES, i);
    const loc = pick(LOC_NAMES, i);
    hooks.push({
      id: `hook-${pad4(i)}`,
      title: `伏笔${i}：${c1}在${loc}留下的未解之事`,
      description: `第${firstSeen}章埋下的一条线索，牵涉${c1}，尚未在正文中收束。`,
      status,
      relatedCharacters: [c1, pick(CHAR_NAMES, i + 1)],
      relatedLocations: [loc],
      firstSeenChapter: firstSeen,
      lastTouchedChapter: lastTouched,
      evidence: [`第${firstSeen}章：${c1}的异常反应`, `第${lastTouched}章：${loc}再次出现相关迹象`],
      nextActionHint: `可在临近章节让${c1}就此摊牌或自然带过。`,
    });
  }
  return { hooks };
}

function buildThreadPool(chapters) {
  const threads = [];
  const total = 40;
  for (let i = 1; i <= total; i += 1) {
    const firstSeen = Math.max(1, Math.round((i / total) * chapters) - 2);
    const lastTouched = Math.min(chapters, firstSeen + 1 + (i % 8));
    const type = i % 2 === 0 ? "lead" : "intent";
    // 状态：多数 open/touched（活跃线索/意图才进 buildStoryThreadsContext），少量 done/stale。
    const status = i % 9 === 0 ? "done" : i % 6 === 0 ? "stale" : i % 2 === 0 ? "open" : "touched";
    const c1 = pick(CHAR_NAMES, i + 1);
    const loc = pick(LOC_NAMES, i);
    threads.push({
      id: `thread-${pad4(i)}`,
      type,
      title:
        type === "lead"
          ? `线索${i}：${loc}那边悬而未决的进展`
          : `意图${i}：${PROTAGONIST_NAME}想就${c1}的事做个了断`,
      status,
      firstSeenChapter: firstSeen,
      lastTouchedChapter: lastTouched,
      evidence: [`第${firstSeen}章：线索浮现`, `第${lastTouched}章：${c1}处有了新动静`],
      nextActionHint: `下一章可推进${loc}方向，必要时与${c1}对峙。`,
      relatedCharacters: [c1, PROTAGONIST_NAME],
      relatedLocations: [loc],
    });
  }
  return { threads };
}

function buildArcGoalPool(chapters) {
  const goals = [];
  const total = 20;
  const scopes = ["chapter", "mini_arc", "main_arc"];
  for (let i = 1; i <= total; i += 1) {
    const firstSeen = Math.max(1, Math.round((i / total) * chapters) - 4);
    const lastTouched = Math.min(chapters, firstSeen + 3 + (i % 10));
    const status = i % 8 === 0 ? "completed" : i % 5 === 0 ? "stale" : i % 2 === 0 ? "active" : "touched";
    const scope = pick(scopes, i);
    const c1 = pick(CHAR_NAMES, i);
    const loc = pick(LOC_NAMES, i + 1);
    goals.push({
      id: `arc-${pad4(i)}`,
      title: `小卷目标${i}：稳住${loc}局面并理清与${c1}的关系`,
      status,
      scope,
      firstSeenChapter: firstSeen,
      lastTouchedChapter: lastTouched,
      targetChapters: 8 + (i % 6),
      evidence: [`第${firstSeen}章：目标确立`, `第${lastTouched}章：阶段性推进`],
      relatedHooks: [`hook-${pad4(((i * 3) % 60) + 1)}`],
      relatedThreads: [`thread-${pad4(((i * 2) % 40) + 1)}`],
      relatedCharacters: [c1, PROTAGONIST_NAME],
      relatedLocations: [loc],
      nextActionHint: `让本卷在${loc}方向收一个小阶段，但别一次解决全部矛盾。`,
    });
  }
  return { goals };
}

function buildChapterMarkdown(chapter) {
  const loc = pick(LOC_NAMES, chapter);
  const altLoc = pick(LOC_NAMES, chapter + 3);
  const c1 = pick(SUPPORTING, chapter).name;
  const c2 = pick(SUPPORTING, chapter + 2).name;
  const action = pick(ACTION_TEMPLATES, chapter);
  // 每章 300-500 字模板，含角色名 + 地点名（供 continuity/pronoun 检查读前文）；题材中立。
  const para1 =
    `${PROTAGONIST_NAME}推开${loc}的门时，天色已经压了下来。她没急着开灯，` +
    `先在脑子里把今天要解决的几件事过了一遍。${c1}比约定的时间早到了，正靠在窗边等她。` +
    `两个人都没先开口，气氛里有种心照不宣的紧绷——这一章，${PROTAGONIST_NAME}${action}，` +
    `而${c1}显然有不同的看法。`;
  const para2 =
    `争执并不激烈，却句句落在要害上。${PROTAGONIST_NAME}习惯先复述对方的立场，再把自己的顾虑摆到桌面上。` +
    `她知道${c1}不是在为难自己，可一旦让步，${altLoc}那边刚谈拢的安排就可能全盘推翻。` +
    `她想起远在${altLoc}的${c2}还等着回话，心里那根弦又紧了几分。`;
  const para3 =
    `谈到最后，两个人各退了半步。${PROTAGONIST_NAME}答应重新评估方案，${c1}也松口给出几天缓冲。` +
    `送走${c1}后，${PROTAGONIST_NAME}独自留在${loc}，把灯只开了一盏。` +
    `她清楚这只是又一个被勉强压住的夜晚，真正的难题还在后面——但至少，今晚先把这一步走稳了。`;
  return `# 第${chapter}章\n\n${para1}\n\n${para2}\n\n${para3}\n`;
}

// ---------------------------------------------------------------------------
// seedLongformFixture：在已 createStoryProject 的目录上程序化写满 180 章
// ---------------------------------------------------------------------------

async function writeJson(projectDir, relativePath, value) {
  const full = join(projectDir, relativePath);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

export async function seedLongformFixture(projectDir, { chapters = 180 } = {}) {
  const protagonistId = toSafeCharacterId(PROTAGONIST.name);

  // 1) character-bible：主角 + 5 配角（做厚 extraFields + relationshipDynamics + 关系字段）。
  const characterBible = {
    version: "v0",
    characters: CAST.map((c) => ({
      id: c.id,
      name: c.name,
      role: c.role,
      ...(c.age ? { age: c.age } : {}),
      ...(c.gender ? { gender: c.gender } : {}),
      ...(c.identity ? { identity: c.identity } : {}),
      ...(c.desire ? { desire: c.desire } : {}),
      ...(c.weakness ? { weakness: c.weakness } : {}),
      ...(c.speechStyle ? { speechStyle: c.speechStyle } : {}),
      ...(c.speechSamples ? { speechSamples: c.speechSamples } : {}),
      ...(c.behaviorBoundaries ? { behaviorBoundaries: c.behaviorBoundaries } : {}),
      ...(c.knowledgeKnown ? { knowledgeKnown: c.knowledgeKnown } : {}),
      ...(c.knowledgeUnknown ? { knowledgeUnknown: c.knowledgeUnknown } : {}),
      ...(c.cannotDo ? { cannotDo: c.cannotDo } : {}),
      ...(c.relationshipToProtagonist ? { relationshipToProtagonist: c.relationshipToProtagonist } : {}),
      ...(c.relationshipDynamics ? { relationshipDynamics: c.relationshipDynamics } : {}),
      ...(c.trustLevel ? { trustLevel: c.trustLevel } : {}),
      extraFields: c.extraFields ?? {},
      canAiModify: false,
    })),
  };

  // 2) 主角 characters/<id>/* 三件套（profile/core/state）—— 用主角 id 与 bible 对齐。
  const profile = {
    id: protagonistId,
    name: PROTAGONIST.name,
    identity: "protagonist",
    age: PROTAGONIST.age,
    gender: PROTAGONIST.gender,
    appearance: {},
    tags: ["main-character"],
    extraFields: PROTAGONIST.extraFields,
  };
  const core = {
    characterId: protagonistId,
    personality: ["责任感强", "先复述再表态", "凡事自己扛"],
    speechStyle: PROTAGONIST.speechStyle,
    taboos: PROTAGONIST.cannotDo,
    desire: PROTAGONIST.desire,
    fear: "团队在自己手里散掉。",
    contradiction: "想放权又放不下心。",
  };
  const state = {
    characterId: protagonistId,
    emotion: "紧绷但克制",
    goal: PROTAGONIST.desire,
    currentLocationName: LOCATIONS[0].name,
    currentPhysicalState: "长期熬夜，靠咖啡顶着",
    currentMentalState: "疲惫但清醒，警惕投资方的动作",
    currentResourceState: "账上只够撑三个月",
    relationshipToUser: "本人",
    currentArc: "整合",
    lastUpdatedChapter: chapters,
  };

  // 3) world-bible（规则/势力/冲突源）。
  const worldBible = {
    version: "v0",
    rules: ["小工作室靠口碑和交付质量立足，没有任何捷径或外挂。", "重大方向需合伙人达成一致才能拍板。"],
    factions: [
      { id: "fac-studio", name: "城南创意工作室", goal: "在不依附大资本的前提下活下去并立住口碑", resources: ["核心设计团队", "老客户订单", "改造厂房空间"] },
      { id: "fac-client", name: "方程的甲方公司", goal: "用最低成本拿到最高质量的设计产出", resources: ["稳定的大额订单", "行业资源", "议价主动权"] },
      { id: "fac-investor", name: "江夙背后的投资方", goal: "低价拿下有潜力的小团队并掌握控制权", resources: ["资金", "并购经验", "对合伙人的私下接触"] },
    ],
    powerOrSurvivalSystems: ["现金流与交付节奏决定团队生死。"],
    historyFacts: ["工作室由主角与陆鸣州三年前合伙创立。", "曾凭一个夜市改造项目打出名声。"],
    socialOrder: ["甲方掌握议价主动权，乙方靠交付质量博空间。"],
    conflictSources: [
      "现金流只够撑三个月，租约又年底到期。",
      "合伙人私下接洽投资方，绕过了主角。",
      "最大金主习惯压价，撤单即重伤。",
    ],
    hiddenFacts: ["投资方真实意图是控股而非注资。", "老客户撤单另有隐情。"],
    protectedSecrets: ["投资方的真实并购意图", "合伙人私下接洽的具体条件"],
  };

  // 4) location-bible。
  const locationBible = { version: "v0", locations: LOCATIONS };

  // 5) writing-rules（反 AI 流水线、中性）。
  const writingRules = {
    version: "v0",
    narrativePerspective: "第三人称有限视角，严格限制在主角可见可感的信息内。",
    proseStyle: ["克制", "生活质感", "少解释多动作", "把压力落到具体的人和事上"],
    chapterLength: { targetWords: 1800 },
    pacing: "中等，每章有明确推进但不把矛盾一次解决。",
    revealPolicy: "不提前揭开隐藏意图，只通过态度、阻力和后果制造悬念。",
    genreRequirements: ["普通人创业，无系统无金手指。", "压力要具体落到订单、租约、人情等细节上。"],
    suspenseRules: ["投资方的真实意图只通过暧昧态度暗示，不直接点破。"],
    payoffRules: ["埋下的伏笔要在合理章节自然收束。"],
    reversalRules: [],
    readerExperienceRules: ["读者应感到主角被现实压住，但仍在冷静找缝隙。"],
    forbiddenContent: ["不要提前揭开投资方真实并购意图", "不要提前揭开老客户撤单隐情"],
    doNotDo: ["不要让主角突然拿到不明资金", "不要写成设定说明书", "不要让团队无缘由地一夜和解"],
    antiAiPatterns: ["避免万能转折", "避免角色情绪空转", "避免用'命运''注定'之类的空泛大词收尾"],
  };

  // 6) bible（longFormGoals/centralConflicts 等）。
  const bible = {
    version: "v0",
    projectLogline:
      "27岁的沈知澜守着一间快散伙的城南创意工作室，要在现金流见底、合伙人离心、投资方暧昧逼近的三个月里，把团队带成一家立得住的公司。",
    premise: "现代都市真实世界，无系统无金手指；核心看点是小团队在现实压力下的取舍与人心拉扯。",
    genre: "都市职场 / 创业群像",
    subgenres: ["都市", "职场群像"],
    readerPromise: "看一个不肯认输的人，如何在钱、人、情之间一步步走稳。",
    longFormGoals: [
      "沈知澜不依附外部资本，靠团队自身把工作室带过生死线。",
      "在与合伙人、甲方、投资方的拉扯中，校准信任与放权。",
    ],
    centralConflicts: [
      "现金流只够撑三个月，租约年底到期。",
      "想靠团队自己，与投资方递来的'捷径'之间的张力。",
      "凡事自己扛的习惯，与必须学会放权之间的矛盾。",
    ],
    coreMysteries: ["投资方的真实并购意图", "老客户突然撤单的真实原因"],
    forbiddenChanges: [
      "不要让主角突然拿到不明来源的大笔资金。",
      "不要凭空出现系统/金手指/超自然。",
      "正式事实只能通过确认提交更新。",
    ],
    canonFacts: [
      "沈知澜27岁，城南创意工作室创始人。",
      "工作室由沈知澜与陆鸣州三年前合伙创立。",
      "工作室账上只够撑三个月，城南租约年底到期。",
    ],
    openQuestions: [],
    protectedSecrets: ["投资方的真实并购意图", "合伙人私下接洽的具体条件"],
    setupAssets: {
      initialAssets: ["改造厂房的工作室", "一支六人核心团队", "几家老客户订单"],
      keyItems: ["方程公司的主力订单合同", "城南厂房租约"],
      resourceLimits: ["账上现金只够三个月", "租约年底到期", "团队人手有限，不能无限接单"],
    },
    firstChapterSetup: {
      goal: "现金流见底的那个月，沈知澜在城南创意工作室直面合伙人离心与投资方的暧昧逼近。",
      openingScene: "城南创意工作室二层设计间",
      hook: "合伙人陆鸣州私下接洽了投资方，绕过了主角。",
      conflict: "想靠团队自己，却被现金流和投资方的'捷径'同时逼到墙角。",
    },
  };

  // 7) world/core、world/state（与既有目录结构对齐）。
  const worldCore = {
    genre: bible.genre,
    premise: bible.premise,
    rules: worldBible.rules,
    mainConflict: bible.centralConflicts[0],
  };
  const worldState = {
    currentPhase: "整合",
    activeConflicts: bible.centralConflicts,
    activeHooks: [bible.firstChapterSetup.hook],
    knownSecrets: [],
    lastUpdatedChapter: chapters,
  };
  const storyCore = {
    readerPromise: bible.readerPromise,
    tone: "克制写实",
    targetEmotion: "揪心又想往下看",
    pacingStyle: "状态驱动的长篇连载推进",
  };

  // 8) 累积池子 + timeline + fact-ledger。
  const timelineEvents = buildTimelineEvents(chapters);
  const factLedger = buildFactLedger(chapters);
  const hookPool = buildHookPool(chapters);
  const threadPool = buildThreadPool(chapters);
  const arcGoalPool = buildArcGoalPool(chapters);

  // story-calendar：schema 只是单个 { currentStoryDay, currentTimeOfDay }（非 180 条数组）。
  // 推进到与章数对应的故事日，模拟长篇日历状态。
  const calendar = { currentStoryDay: chapters, currentTimeOfDay: "night" };

  // 9) 写盘。
  await Promise.all([
    writeJson(projectDir, "story/bible.json", bible),
    writeJson(projectDir, "story/world-bible.json", worldBible),
    writeJson(projectDir, "story/character-bible.json", characterBible),
    writeJson(projectDir, "story/location-bible.json", locationBible),
    writeJson(projectDir, "story/writing-rules.json", writingRules),
    writeJson(projectDir, "story/core.json", storyCore),
    writeJson(projectDir, "story/hooks.json", hookPool),
    writeJson(projectDir, "story/threads.json", threadPool),
    writeJson(projectDir, "story/arc-goals.json", arcGoalPool),
    writeJson(projectDir, "story/fact-ledger.json", factLedger),
    writeJson(projectDir, "world/core.json", worldCore),
    writeJson(projectDir, "world/state.json", worldState),
    writeJson(projectDir, "timeline/events.json", timelineEvents),
    writeJson(projectDir, "time/calendar.json", calendar),
    writeJson(projectDir, `characters/${protagonistId}/profile.json`, profile),
    writeJson(projectDir, `characters/${protagonistId}/core.json`, core),
    writeJson(projectDir, `characters/${protagonistId}/state.json`, state),
  ]);

  // 10) 180 个章节 md（含角色名 + 地点名）。
  await mkdir(join(projectDir, "chapters"), { recursive: true });
  await Promise.all(
    Array.from({ length: chapters }, (_, i) => i + 1).map((chapter) =>
      writeFile(join(projectDir, "chapters", `${pad4(chapter)}.md`), buildChapterMarkdown(chapter), "utf-8"),
    ),
  );

  return { protagonistId, protagonistName: PROTAGONIST.name, chapters };
}

// ---------------------------------------------------------------------------
// 主流程 + 自检（无 GLM）
// ---------------------------------------------------------------------------

async function main() {
  const chapters = 180;
  const rootDir = join(homedir(), "StoryEngine-NG-r5");
  // 固定项目 id（r5fix）→ 每次重跑先清掉旧的，避免 createStoryProject 自动加 -2 后缀。
  const projectId = "r5fix";
  const projectDir = join(rootDir, "story-engine", projectId);
  await rm(projectDir, { recursive: true, force: true }).catch(() => undefined);

  const created = await createStoryProject({
    rootDir,
    title: projectId,
    genre: "都市职场 / 创业群像",
    premise: "27岁的沈知澜要在三个月内把一间快散伙的城南创意工作室带过生死线。",
    mainCharacterName: PROTAGONIST_NAME,
  });
  // createStoryProject 用 title→safeId，确认落在 r5fix（题中性、无空格）。
  const seeded = await seedLongformFixture(created.projectDir, { chapters });

  console.log("=== R5 longform fixture seeded ===");
  console.log(JSON.stringify({ projectDir: created.projectDir, ...seeded }, null, 2));

  // ---- 自检：chapter ∈ {10, 180} 跑 buildWriterContext，逐 section 打 tokenEstimate ----
  const samples = {};
  for (const chapter of [10, 180]) {
    const envelope = await buildWriterContext({
      projectDir: created.projectDir,
      chapter,
      chapterGoal: "继续推进",
      maxTimelineEvents: 8,
    });
    const sectionTokens = {};
    for (const s of envelope.sections) sectionTokens[s.name] = s.tokenEstimate;

    const wcp = envelope.sections.find((s) => s.name === "writing_context_pack")?.content;
    const supportingCastLen = Array.isArray(wcp?.supportingCast) ? wcp.supportingCast.length : 0;
    const establishedFactsLen = Array.isArray(wcp?.continuityFocus?.establishedFacts)
      ? wcp.continuityFocus.establishedFacts.length
      : 0;

    samples[chapter] = {
      totalTokenEstimate: envelope.trace.totalTokenEstimate,
      stableTokenEstimate: envelope.trace.stableTokenEstimate,
      dynamicTokenEstimate: envelope.trace.dynamicTokenEstimate,
      sectionTokens,
      supportingCastLen,
      establishedFactsLen,
      selectedCharacters: envelope.trace.selectedCharacters,
    };
  }

  console.log("\n=== Self-check: buildWriterContext per-section tokenEstimate ===");
  console.log(JSON.stringify(samples, null, 2));

  // ---- 断言：关键 dynamic 段非 0；supportingCast > 0；total(180) > total(10) ----
  const dynamicMustBeNonZero = [
    "timeline_events",
    "hook_pool",
    "hook_tracking",
    "story_threads",
    "arc_goals",
    "story_calendar",
    "writing_context_pack",
    "story_continuity",
  ];
  const problems = [];
  for (const chapter of [10, 180]) {
    const st = samples[chapter].sectionTokens;
    for (const name of dynamicMustBeNonZero) {
      if (!st[name] || st[name] === 0) problems.push(`chapter ${chapter}: section "${name}" tokenEstimate is 0`);
    }
    if (samples[chapter].supportingCastLen <= 0) problems.push(`chapter ${chapter}: supportingCast length is 0`);
    if (samples[chapter].establishedFactsLen <= 0) problems.push(`chapter ${chapter}: establishedFacts length is 0`);
  }
  if (samples[180].totalTokenEstimate <= samples[10].totalTokenEstimate) {
    problems.push(
      `total token did not grow: chapter10=${samples[10].totalTokenEstimate}, chapter180=${samples[180].totalTokenEstimate}`,
    );
  }

  console.log("\n=== Self-check verdict ===");
  if (problems.length === 0) {
    console.log("PASS ✓ — all required dynamic sections non-zero, supportingCast>0, establishedFacts>0, token grows 10→180.");
    console.log(
      JSON.stringify(
        {
          supportingCast: { c10: samples[10].supportingCastLen, c180: samples[180].supportingCastLen },
          establishedFacts: { c10: samples[10].establishedFactsLen, c180: samples[180].establishedFactsLen },
          totalToken: { c10: samples[10].totalTokenEstimate, c180: samples[180].totalTokenEstimate },
        },
        null,
        2,
      ),
    );
  } else {
    console.log("FAIL ✗ — self-check problems:");
    for (const p of problems) console.log(`  - ${p}`);
    process.exitCode = 1;
  }
}

// 守卫：用 pathToFileURL 规范化（项目路径含空格「New project」，import.meta.url 会把空格编码成 %20，
// 旧字符串拼接 file://+argv 永不相等 → main 不执行）。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
