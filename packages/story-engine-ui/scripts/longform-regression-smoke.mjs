import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildStateOverview,
  createStoryProject,
  toSafeCharacterId,
} from "@actalk/story-engine";

const baseUrl = process.env.STORY_ENGINE_UI_URL ?? "http://127.0.0.1:5174";
const rootDir = await mkdtemp(join(tmpdir(), "story-engine-longform-regression-"));
const protagonistName = "林序";
const characterId = toSafeCharacterId(protagonistName);
const { projectDir } = await createStoryProject({
  rootDir,
  title: "海天魂钢回归测试",
  genre: "都市英灵 / 创业魂钢",
  premise: "普通毕业生林序在海天市旧城区创业孵化楼接触创业魂钢异常反应。",
  mainCharacterName: protagonistName,
});

await seedFoundation(projectDir);

const directions = [
  "毕业失败当天，林序在创业孵化楼2楼申请窗口第一次接触魂钢异常反应。",
  "林序从2楼申请窗口离开，去1楼大厅查询终端确认申请记录，但手机仍欠费，不能联网。",
  "林序准备离开孵化楼去旧城区公交站，途中半张申请表再次异常发热，不要让他打车去市中心。",
];
const registeredContext = buildRegisteredContext();
const chapters = [];
const initialOverview = await buildStateOverview({ projectDir, chapter: 1, maxTimelineEvents: 8 });

for (let index = 0; index < directions.length; index += 1) {
  const chapter = index + 1;
  const direction = directions[index];
  const steering = await post("/api/chapter-steering", {
    projectPath: projectDir,
    chapter,
    userDirection: direction,
    maxSuggestions: 3,
    pacing: "balanced",
    revealLevel: "low",
  });
  const draftGoal = steering?.draft?.generatedChapterGoalPreview || direction;
  const generated = await postStream("/api/draft/stream", {
    projectPath: projectDir,
    chapter,
    chapterGoal: draftGoal,
    maxOutputTokens: 2600,
  }, 180000);
  const draftContent = generated.draftContent
    || await readFile(join(projectDir, "drafts", "fast", `chapter-${String(chapter).padStart(4, "0")}.md`), "utf-8");
  const quality = await post("/api/draft/quality", { projectPath: projectDir, chapter });
  const preview = await post("/api/commit/preview", { projectPath: projectDir, chapter });
  let apply = null;
  let applyError = null;
  try {
    apply = await post("/api/commit/apply", { projectPath: projectDir, chapter, confirm: true });
  } catch (error) {
    applyError = String(error?.message ?? error);
  }
  const overview = await buildStateOverview({ projectDir, chapter, maxTimelineEvents: 8 });
  const commitPreview = summarizeCommitPreview(preview);
  const driftScan = scanDraft(draftContent, registeredContext);
  chapters.push({
    chapter,
    direction,
    steering: summarizeSteering(steering.draft),
    draftGoal,
    draftFirst500: firstChars(draftContent, 500),
    draftFirst800: firstChars(draftContent, 800),
    driftScan,
    regression: classifyRegressionSignals(driftScan, commitPreview, registeredContext),
    quality: summarizeQuality(quality.quality),
    commitPreview,
    apply: apply ? summarizeApply(apply) : null,
    applyError,
    overview: summarizeOverview(overview),
    formalChapterFirst300: apply?.chapterContent ? firstChars(apply.chapterContent, 300) : "",
  });
}

const finalOverview = await buildStateOverview({ projectDir, chapter: 3, maxTimelineEvents: 12 });
const result = {
  projectDir,
  rootDir,
  initialOverview: summarizeOverview(initialOverview),
  chapters,
  finalOverview: summarizeOverview(finalOverview),
  files: await readKeyFiles(projectDir),
  regressionSummary: aggregateRegression(chapters, finalOverview),
};

const resultPath = join(rootDir, "longform-regression-result.json");
await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf-8");
console.log(JSON.stringify({ projectDir, resultPath, regressionSummary: result.regressionSummary }, null, 2));

async function seedFoundation(targetProjectDir) {
  await Promise.all([
    writeJson(targetProjectDir, "story/bible.json", {
      version: "v0",
      projectLogline: "普通毕业生林序在海天市旧城区创业孵化楼接触创业魂钢异常反应，并从底层追查觉醒机会被垄断的真相。",
      premise: "创业魂钢决定城市阶层、资源分配和英灵能力，财团垄断觉醒机会。",
      genre: "都市英灵 / 创业魂钢",
      subgenres: ["都市英灵", "创业魂钢"],
      readerPromise: "普通人从资源不足和信息有限的起点，稳步识破城市规则。",
      longFormGoals: ["林序查清魂钢申请异常，争取真正进入觉醒体系的机会。"],
      centralConflicts: ["普通毕业生很难获得魂钢，财团垄断觉醒机会。"],
      coreMysteries: ["魂钢真实来源", "财团幕后操盘者", "主角潜力真实等级"],
      forbiddenChanges: ["不要让主角突然开挂", "不要提前揭开魂钢真实来源", "不要提前揭开财团幕后操盘者", "不要提前揭开主角潜力真实等级"],
      canonFacts: ["林序是22岁的普通毕业生。", "海天市旧城区创业孵化楼是开篇主要场景。"],
      openQuestions: [],
      protectedSecrets: ["魂钢真实来源", "财团幕后操盘者", "主角潜力真实等级"],
      setupAssets: {
        initialAssets: ["欠费手机", "公交卡", "旧笔记本电脑", "半张魂钢申请表"],
        keyItems: ["半张魂钢申请表"],
        resourceLimits: ["欠费手机不能正常联网", "没有车辆", "没有大额现金", "旧笔记本电脑不随身携带，除非明确返回住处或明确携带"],
      },
      firstChapterSetup: {
        goal: "毕业失败当天，林序在创业孵化楼2楼申请窗口第一次接触魂钢异常反应。",
        openingScene: "海天市旧城区创业孵化楼2楼申请窗口",
        hook: "半张魂钢申请表出现异常发热。",
        conflict: "林序申请失败，但检测设备对残缺申请表出现异常反应。",
      },
    }),
    writeJson(targetProjectDir, "story/writing-rules.json", {
      version: "v0",
      narrativePerspective: "第三人称有限视角，严格限制在林序可见、可听、可推理的信息内。",
      proseStyle: ["克制", "紧张", "细节扎实", "少解释，多动作和环境压力"],
      chapterLength: { targetWords: 1800 },
      pacing: "中等偏快，每章有明确推进但不解释设定全貌。",
      revealPolicy: "不提前揭开隐藏真相，只通过异常、阻力和后果制造悬念。",
      genreRequirements: ["普通人起步，不开挂", "城市阶层压力要具体落到窗口、终端、通行限制等细节上。"],
      suspenseRules: ["魂钢异常只表现为局部反应，不解释来源。"],
      payoffRules: [],
      reversalRules: [],
      readerExperienceRules: ["读者应感到林序被系统压住，但仍在冷静寻找缝隙。"],
      forbiddenContent: ["不要提前揭开魂钢真实来源", "不要提前揭开财团幕后操盘者", "不要提前揭开主角潜力真实等级"],
      doNotDo: ["不要让主角突然拥有高级英灵能力", "不要写成设定说明书", "不要把欠费手机写成正常联网。"],
    }),
    writeJson(targetProjectDir, "story/character-bible.json", {
      version: "v0",
      characters: [{
        id: characterId,
        name: protagonistName,
        role: "主角",
        age: "22岁",
        gender: "男",
        identity: "海天市普通毕业生",
        longTermDesire: "拿到一次公平的觉醒机会。",
        desire: "确认自己的魂钢申请为什么失败。",
        fear: "被城市系统永久判定为无用者。",
        weakness: "普通人起步，不开挂，信息有限，前期资源不足。",
        behaviorBoundaries: ["先观察再反问，不冲动硬闯。", "不会突然知道隐藏真相。", "不会突然获得高级能力。"],
        knowledgeKnown: ["创业魂钢会影响毕业后的资源分配。", "财团掌握主要申请渠道。", "自己的申请在毕业当天被判失败。"],
        knowledgeUnknown: ["魂钢真实来源", "财团幕后操盘者", "主角潜力真实等级"],
        speechStyle: "克制，先观察再反问；句子不长，但不是极端沉默。",
        speechSamples: ["我只问一个问题：规则写在哪儿？", "先排着，不代表我认了。"],
        currentPhysicalState: "毕业失败当天，疲惫但能行动。",
        currentMentalState: "紧张、克制、怀疑。",
        currentResourceState: "手机欠费，现金不足，没有车辆。",
        cannotDo: ["不能突然掌握魂钢真实来源。", "不能突然识破财团幕后操盘者。", "不能突然开车或拥有大额现金。"],
        canAiModify: false,
      }],
    }),
    writeJson(targetProjectDir, "story/world-bible.json", {
      version: "v0",
      rules: ["创业魂钢决定城市阶层、资源分配和英灵能力。"],
      resourceRules: ["普通毕业生必须通过申请窗口和检测流程获取资格。", "财团垄断高质量魂钢申请渠道。"],
      factions: [{ id: "f-corp", name: "财团", goal: "垄断觉醒机会和资源分配入口", resources: ["魂钢申请渠道", "检测设备", "资格终端"] }],
      powerOrSurvivalSystems: ["创业魂钢"],
      historyFacts: [],
      socialOrder: ["毕业生按魂钢适配度进入不同阶层。", "旧城区申请点只提供低优先级窗口。"],
      conflictSources: ["普通毕业生很难获得魂钢", "财团垄断觉醒机会"],
      hiddenTruths: ["魂钢真实来源", "财团幕后操盘者", "主角潜力真实等级"],
      protectedSecrets: ["魂钢真实来源", "财团幕后操盘者", "主角潜力真实等级"],
    }),
    writeJson(targetProjectDir, "story/location-bible.json", {
      version: "v0",
      locations: [{
        id: "loc-incubator",
        name: "海天市旧城区创业孵化楼",
        type: "初始地点",
        locationType: "城市建筑",
        parentLocation: "海天市旧城区",
        spatialStructure: {
          floors: ["1楼大厅", "2楼申请窗口", "3楼办公区"],
          rooms: ["1楼大厅查询终端区", "2楼毕业申请窗口", "3楼财团办公区"],
          entrances: ["旧城区正门"],
          exits: ["一楼大厅侧门", "楼梯间"],
        },
        currentKnownPosition: "2楼申请窗口",
        connectedLocations: ["旧城区公交站", "市中心"],
        travelRules: [
          { targetLocation: "1楼大厅", method: "stairs", durationMinutes: 1, constraint: "2楼申请窗口到1楼大厅通过楼梯，约1分钟。" },
          { targetLocation: "旧城区公交站", method: "walk", durationMinutes: 6, constraint: "从创业孵化楼到旧城区公交站步行约6分钟。" },
          { targetLocation: "市中心", method: "taxi", durationMinutes: 25, constraint: "现金不足时不能随便打车去市中心。" },
        ],
        knownFeatures: ["老旧办公楼", "魂钢申请窗口", "公共查询终端"],
        resources: ["1楼大厅公共查询终端", "2楼纸质申请窗口"],
        risks: ["魂钢检测设备可能被财团监控", "3楼办公区不对普通毕业生开放"],
        fixedFacts: ["2楼有申请窗口", "1楼有大厅和查询终端", "3楼是办公区"],
      }],
    }),
    writeJson(targetProjectDir, "story/assets.json", {
      version: "v0",
      assets: [
        { id: "asset-phone", name: "欠费手机", type: "keyItem", ownerCharacterId: characterId, ownerName: protagonistName, carriedByCharacterId: characterId, status: "locked", conditionNote: "欠费三天，不能正常联网。", isPlotCritical: true, canAiModify: false, rules: ["欠费手机不能突然正常联网。"] },
        { id: "asset-bus-card", name: "公交卡", type: "money", ownerCharacterId: characterId, ownerName: protagonistName, carriedByCharacterId: characterId, status: "available", conditionNote: "余额不明，可用于公交。", canAiModify: false },
        { id: "asset-laptop", name: "旧笔记本电脑", type: "item", ownerCharacterId: characterId, ownerName: protagonistName, currentLocationName: "林序合租房书桌", status: "available", conditionNote: "不随身携带，除非明确返回住处或明确携带。", canAiModify: false, rules: ["旧笔记本电脑不应凭空随身出现。"] },
        { id: "asset-half-form", name: "半张魂钢申请表", type: "document", ownerCharacterId: characterId, ownerName: protagonistName, carriedByCharacterId: characterId, status: "damaged", conditionNote: "只有左半张，缺少右侧编号栏。", isPlotCritical: true, canAiModify: false, rules: ["半张魂钢申请表不能凭空变成完整申请表。"] },
      ],
      containers: [],
    }),
    writeJson(targetProjectDir, `characters/${characterId}/profile.json`, {
      id: characterId,
      name: protagonistName,
      identity: "海天市普通毕业生",
      age: "22岁",
      gender: "男",
      appearance: { build: "偏瘦", demeanor: "克制，疲惫但清醒" },
    }),
    writeJson(targetProjectDir, `characters/${characterId}/core.json`, {
      characterId,
      personality: ["克制", "先观察再反问", "不轻信窗口说法"],
      speechStyle: "克制，先观察再反问。",
      taboos: ["不能突然开挂", "不能提前知道隐藏真相"],
    }),
    writeJson(targetProjectDir, `characters/${characterId}/state.json`, {
      characterId,
      emotion: "紧张、克制、怀疑",
      goal: "确认魂钢申请为什么失败",
      currentLocation: "海天市旧城区创业孵化楼2楼申请窗口",
      currentPhysicalState: "疲惫但能行动",
      currentMentalState: "紧张、克制、怀疑",
      currentResourceState: "手机欠费，现金不足，没有车辆",
    }),
    writeJson(targetProjectDir, "world/core.json", {
      genre: "都市英灵 / 创业魂钢",
      premise: "创业魂钢决定城市阶层、资源分配和英灵能力，财团垄断觉醒机会。",
      rules: ["创业魂钢决定城市阶层、资源分配和英灵能力。"],
      mainConflict: "普通毕业生很难获得魂钢，财团垄断觉醒机会。",
    }),
    writeJson(targetProjectDir, "world/state.json", {
      currentPhase: "开篇",
      activeConflicts: ["普通毕业生很难获得魂钢，财团垄断觉醒机会。"],
      activeHooks: ["半张魂钢申请表异常发热"],
      knownSecrets: [],
      hiddenTruths: ["魂钢真实来源", "财团幕后操盘者", "主角潜力真实等级"],
    }),
  ]);
}

function buildRegisteredContext() {
  return {
    floors: ["1楼", "一楼", "1楼大厅", "2楼", "二楼", "2楼申请窗口", "3楼", "三楼", "3楼办公区"],
    unregisteredFloorPatterns: [/4楼|四楼|四层楼/u, /5楼|五楼|五层楼/u, /六楼|6楼|六层楼/u],
    locations: ["海天市旧城区创业孵化楼", "海天市旧城区", "旧城区公交站", "市中心", "1楼大厅", "2楼申请窗口", "3楼办公区", "楼梯间"],
    travelTargets: ["1楼大厅", "旧城区公交站", "市中心"],
    assets: ["欠费手机", "公交卡", "旧笔记本电脑", "半张魂钢申请表"],
    protectedSecrets: ["魂钢真实来源", "财团幕后操盘者", "主角潜力真实等级"],
  };
}

async function postStream(path, body, timeoutMs = 180000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      const raw = await response.text().catch(() => "");
      throw new Error(`${path} failed: ${response.status} ${raw.slice(0, 300)}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventName = "message";
    let dataLines = [];
    let donePayload = null;
    const flush = () => {
      if (!dataLines.length) return;
      const raw = dataLines.join("\n");
      dataLines = [];
      let parsed;
      try { parsed = JSON.parse(raw); } catch { parsed = raw; }
      if (eventName === "done") donePayload = parsed;
      if (eventName === "error") throw new Error(parsed?.error || String(parsed));
      eventName = "message";
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line === "") flush();
        else if (line.startsWith("event:")) eventName = line.slice("event:".length).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trim());
      }
    }
    flush();
    if (!donePayload) throw new Error(`${path} ended without done event`);
    return donePayload;
  } finally {
    clearTimeout(timer);
  }
}

async function post(path, body, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = { ok: false, error: text }; }
    if (!response.ok || !payload.ok) {
      throw new Error(`${path} failed: ${response.status} ${payload.error || text.slice(0, 300)}`);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function writeJson(targetProjectDir, relativePath, value) {
  await writeFile(join(targetProjectDir, relativePath), `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function readKeyFiles(targetProjectDir) {
  const rels = ["story/assets.json", "story/location-bible.json", "story/character-bible.json", "story/bible.json", "world/state.json", "timeline/events.json"];
  const out = {};
  for (const rel of rels) {
    out[rel] = JSON.parse(await readFile(join(targetProjectDir, rel), "utf-8"));
  }
  return out;
}

function stripMarkdown(text) {
  return text.replace(/^#{1,6} .+$/gmu, "").trim();
}

function firstChars(text, count) {
  return text.replace(/\r\n/g, "\n").slice(0, count);
}

function summarizeQuality(quality) {
  return { passed: quality?.passed, issues: quality?.issues ?? [] };
}

function summarizeSteering(draft) {
  return {
    preview: draft?.generatedChapterGoalPreview,
    suggestions: (draft?.suggestions ?? []).map((suggestion) => ({
      type: suggestion.type,
      title: suggestion.title,
      action: suggestion.recommendedAction,
      reason: suggestion.reason,
    })),
    foundationContext: draft?.foundationContext,
  };
}

function summarizeCommitPreview(preview) {
  const report = preview.commitPlan;
  const plan = report?.commitPlan;
  return {
    passed: report?.passed,
    issues: report?.issues ?? [],
    highRiskIssueCount: report?.highRiskIssueCount,
    requiresExplicitOverride: report?.requiresExplicitOverride,
    blockingReasons: report?.blockingReasons,
    assetChanges: report?.assetChanges,
    locationChanges: report?.locationChanges,
    draftQuality: summarizeQuality(preview.draftQuality),
    semanticQuality: summarizeQuality(preview.semanticQuality),
    semanticSummary: report?.semanticSummary,
    timelineEvent: plan?.timelineEvent,
    characterUpdates: plan?.characterUpdates,
    worldUpdate: plan?.worldUpdate,
    hookUpdates: plan?.hookUpdates,
    threadUpdates: plan?.threadUpdates,
    arcGoalUpdates: plan?.arcGoalUpdates,
  };
}

function summarizeApply(apply) {
  return {
    report: apply.report,
    chapterTitle: apply.chapterTitle,
    chapterContentFirst300: firstChars(apply.chapterContent ?? "", 300),
    overview: summarizeOverview(apply.overview),
  };
}

function summarizeOverview(overview) {
  return {
    project: overview.project,
    storyStatus: overview.storyStatus,
    protagonist: overview.protagonist,
    currentLocation: overview.currentLocation,
    locationDetailSummary: overview.locationDetailSummary,
    assetSummary: overview.assetSummary,
    characterDetailSummary: overview.characterDetailSummary,
    timeline: overview.timeline,
    hooks: overview.hooks,
    threads: overview.threads,
    arcGoals: overview.arcGoals,
    risks: overview.risks,
    foundationCompleteness: overview.foundationCompleteness,
  };
}

function scanDraft(text, context) {
  const body = stripMarkdown(text);
  const ageMentions = [...body.matchAll(/(\d{1,3})岁/g)].map((match) => match[1]);
  const unregisteredFloors = context.unregisteredFloorPatterns
    .map((pattern) => matchingSentence(body, pattern))
    .filter(Boolean);
  const assetSignals = [
    ["money", /(?:\d+(?:\.\d+)?元|\d+(?:\.\d+)?块钱?|[一二三四五六七八九十百千万]+块[一二三四五六七八九十]?毛|现金|钱包|余额)/u],
    ["food_or_water", /压缩饼干|矿泉水|午餐肉|罐头|食物|饮用水/u],
    ["phone_online", /欠费手机.{0,24}(?:联网|上网|连上|刷新|通话|打电话)|(?:林序|他|自己).{0,16}手机.{0,24}(?:联网|上网|连上|刷新|通话|打电话)/u],
    ["half_form_full", /(?:半张|残缺|缺失|撕掉|破损).{0,16}申请表.{0,16}(?:变成|恢复|补成|拼成|成了).{0,8}完整|完整(?:的)?(?:魂钢)?申请表(?:拿到|到手|出现|补好|补齐)/u],
    ["vehicle_or_taxi", /(?:林序|他|自己).{0,20}(?:开车|骑上|骑着|开着|发动|拿出车钥匙|坐上出租|上了出租|打车去|叫了车|拦了车|打了一辆|网约车)|(?:打车去|坐上出租|上了出租|打了一辆)/u],
  ].map(([type, pattern]) => ({ type, evidence: matchingSentence(body, pattern) })).filter((item) => item.evidence);
  const locationSignals = ["便利店", "老邮局", "公共电话", "药店", "地下车库", "财团联合检测中心"]
    .map((name) => ({ name, evidence: matchingSentence(body, new RegExp(name, "u")) }))
    .filter((item) => item.evidence)
    .filter((item) => !context.locations.some((known) => known.includes(item.name) || item.name.includes(known)));
  return {
    registeredFloorsMentioned: context.floors.filter((floor) => body.includes(floor)),
    unregisteredFloors,
    registeredTravelTargetsMentioned: context.travelTargets.filter((location) => body.includes(location)),
    assetSignals,
    locationSignals,
    hiddenTruthLeak: context.protectedSecrets.filter((term) => body.includes(term)),
    ageMentions,
    ageDrift: ageMentions.some((age) => age !== "22"),
    genericCharacterStatePollution: /engaged|use the new advantage|unknown advantage|active protagonist/iu.test(body),
  };
}

function classifyRegressionSignals(driftScan, commitPreview, context) {
  const spatialWarnings = [
    ...(commitPreview.locationChanges?.spatialViolationWarnings ?? []),
    ...(commitPreview.quality?.issues ?? []),
  ];
  const previewAssetNames = flattenCandidateNames(commitPreview.assetChanges);
  const previewLocationNames = flattenCandidateNames(commitPreview.locationChanges);
  const detectedAssetSignals = driftScan.assetSignals.filter((signal) => candidateMatchesSignal(previewAssetNames, signal));
  const uncontrolledAssetSignals = driftScan.assetSignals.filter((signal) => !candidateMatchesSignal(previewAssetNames, signal));
  const detectedLocationSignals = driftScan.locationSignals.filter((signal) => candidateMatchesName(previewLocationNames, signal.name));
  const uncontrolledLocationSignals = driftScan.locationSignals.filter((signal) => !candidateMatchesName(previewLocationNames, signal.name) && !context.locations.includes(signal.name));
  return {
    uncontrolledFloorDrift: driftScan.unregisteredFloors.length > 0 && spatialWarnings.length === 0,
    detectedSpatialWarning: spatialWarnings.length > 0,
    detectedAssetCandidate: detectedAssetSignals.length > 0,
    uncontrolledAssetDrift: uncontrolledAssetSignals.length > 0,
    detectedLocationCandidate: detectedLocationSignals.length > 0,
    uncontrolledLocationDrift: uncontrolledLocationSignals.length > 0,
    detectedAssetSignals,
    uncontrolledAssetSignals,
    detectedLocationSignals,
    uncontrolledLocationSignals,
  };
}

function aggregateRegression(chapters, finalOverview) {
  const finalText = JSON.stringify(finalOverview);
  const previewText = JSON.stringify(chapters.map((chapter) => chapter.commitPreview));
  const overviewText = JSON.stringify(chapters.map((chapter) => chapter.overview));
  return {
    uncontrolledFloorDrift: chapters.some((chapter) => chapter.regression.uncontrolledFloorDrift),
    detectedSpatialWarning: chapters.some((chapter) => chapter.regression.detectedSpatialWarning),
    detectedAssetCandidate: chapters.some((chapter) => chapter.regression.detectedAssetCandidate),
    uncontrolledAssetDrift: chapters.some((chapter) => chapter.regression.uncontrolledAssetDrift),
    detectedLocationCandidate: chapters.some((chapter) => chapter.regression.detectedLocationCandidate),
    uncontrolledLocationDrift: chapters.some((chapter) => chapter.regression.uncontrolledLocationDrift),
    genrePollution: /survival_72h|supply_route|活过前三天|找到稳定水源|获取基础食物|药店|地下车库|水源|便利店找食物/u.test(`${finalText}\n${previewText}\n${overviewText}`),
    hiddenTruthLeak: chapters.some((chapter) => chapter.driftScan.hiddenTruthLeak.length > 0),
    characterStatePollution: /engaged|use the new advantage|unknown advantage|active protagonist/iu.test(`${finalText}\n${previewText}\n${overviewText}`),
    ageOrSpeechDrift: chapters.some((chapter) => chapter.driftScan.ageDrift),
    commitFailures: chapters.filter((chapter) => chapter.applyError).map((chapter) => ({ chapter: chapter.chapter, error: chapter.applyError })),
  };
}

function flattenCandidateNames(group) {
  if (!group) return [];
  return Object.values(group)
    .flat()
    .filter(Boolean)
    .flatMap((candidate) => [candidate.name, candidate.evidence].filter(Boolean));
}

function candidateMatchesSignal(candidates, signal) {
  return candidates.some((candidate) => {
    if (signal.type === "money") return /现金|余额|钱|元|块|毛/u.test(candidate);
    if (signal.type === "food_or_water") return /压缩饼干|矿泉水|午餐肉|罐头|食物|饮用水/u.test(candidate);
    if (signal.type === "phone_online") return /手机|联网/u.test(candidate);
    if (signal.type === "half_form_full") return /申请表|完整/u.test(candidate);
    if (signal.type === "vehicle_or_taxi") return /交通工具|打车|出租|车辆|车/u.test(candidate);
    return false;
  });
}

function candidateMatchesName(candidates, name) {
  return candidates.some((candidate) => candidate.includes(name));
}

function matchingSentence(body, pattern) {
  return splitSentences(body).find((sentence) => pattern.test(sentence));
}

function splitSentences(body) {
  return body
    .replace(/\r\n/g, "\n")
    .split(/(?<=[。！？!?；;])|\n+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}
