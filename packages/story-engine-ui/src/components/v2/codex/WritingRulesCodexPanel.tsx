import { useEffect, useState, type ReactNode } from "react";
import { fetchWritingRulesEnrichment, type WritingRulesEnrichmentData } from "../../../api/writingRulesEnrichmentClient.js";
import PanelEnrichButton from "./PanelEnrichButton.js";
import { uiText } from "../v2Utils.js";
import { renderRichText } from "./chatRenderShared.js";
import {
  partitionAntiAiPrefixedRules,
  splitLongRuleValueForDisplay,
  stripAntiAiPrefix,
} from "../../../shared/sparse-panel-honesty.js";
import { semanticDedupRules } from "../../../shared/rule-semantic-dedup.js";

/**
 * WritingRulesCodexPanel — 写作规则面板（codex 设计的数据驱动版，厚版全 section）。
 * 视觉照 GLM 设计稿 codex.html #p-rules（样式在 codex.css，.codex-app 作用域）：
 *   .page-head + .stats / .h2 标题 / .spec 合同网格 / .feat 风格指纹条 / .ban-box 红线 / .anti-table 反 AI 规则表。
 *
 * 范式照 WorldbuildingCodexPanel：codex 的每个 section 版式都写出来，有数据则显、暂无则该 section 整块降级隐藏，绝不造假。
 *
 * props：
 *  - items（必填，= sidebar.writingRules，readonly string[]，每条形如「标签：内容」或纯一行禁止项）——
 *    与现有 WritingRulesPanel 完全一致，接进外壳处不变。
 *  - fingerprints / antiRules（可选）——codex 比引擎厚、引擎暂未生成的结构化字段，预留 readonly optional props，
 *    等后续做厚 generate 出量化指纹与反 AI 规则后传入即自动铺开对应 section；不传则该 section 降级隐藏。
 *
 * 数据处理逻辑（labeledValues/pick/splitRuleList/...）镜像现有 WritingRulesPanel.tsx——
 * 该文件只默认导出组件、未导出这些函数，且不可修改任何现有文件，故在此本地镜像同一套逻辑，
 * 并复用其同款 uiText（../v2Utils.js）做术语规范化，保证两版展示同源。
 */

/** 风格指纹条（可量化的本书可识别度，0–100）。引擎暂未生成，做厚后从规则引擎填入。 */
export type StyleFingerprint = {
  readonly label: string;
  /** 0–100 的强度值。 */
  readonly value: number;
};

/** 反 AI 规则（审稿检查项）。引擎暂未生成结构化版本，做厚后填入。 */
export type AntiAiRule = {
  readonly name: string;
  readonly desc: string;
  /** 规则类型：forbidden 禁用 / risk 风险 / encourage 鼓励。 */
  readonly type: "forbidden" | "risk" | "encourage";
  /** 严重度：high / medium / low。 */
  readonly severity: "high" | "medium" | "low";
};

export default function WritingRulesCodexPanel({
  items,
  projectPath,
  fingerprints,
  antiRules,
  customNotes,
  onSendMessage,
}: {
  readonly items: readonly string[];
  /**
   * 项目路径：传了就按 WorldbuildingCodexPanel 的模式拉 .story-engine-ui/writing-rules-enrichment.json，
   * 用做厚结果填两个可选厚字段（显式 props 仍优先；fixture 预览不传 projectPath，故预览不受影响）。
   */
  readonly projectPath?: string | null;
  readonly onSendMessage?: (message: string) => void;
  readonly fingerprints?: readonly StyleFingerprint[];
  readonly antiRules?: readonly AntiAiRule[];
  /** 用户自定义的全局写作规矩（自由 Markdown，破例⑧）；单独传、不混进 items（避免污染 splitRuleList）。 */
  readonly customNotes?: string | null;
}) {
  const [fetched, setFetched] = useState<WritingRulesEnrichmentData | null>(null);
  useEffect(() => {
    let alive = true;
    if (!projectPath) {
      setFetched(null);
      return;
    }
    void fetchWritingRulesEnrichment(projectPath).then((e) => {
      if (alive) setFetched(e);
    });
    return () => {
      alive = false;
    };
  }, [projectPath]);

  // 显式 props 优先；否则用 fetch 到的做厚结果（projectPath 为空 / 还没做过厚 → fetched 为 null，全降级）。
  const effFingerprints = fingerprints ?? fetched?.fingerprints;
  const effAntiRules = antiRules ?? fetched?.antiRules;

  const data = labeledValues(items);
  const forbiddenRaw = splitRuleList(pick(data, "禁止事项"));
  const forbiddenPartition = partitionAntiAiPrefixedRules(forbiddenRaw);
  const forbiddenItems = forbiddenPartition.kept;

  const narrative: readonly Field[] = [
    { label: "视角", value: pick(data, "叙事视角") },
    { label: "人称", value: pick(data, "人称") },
    { label: "视角限制", value: pick(data, "视角限制"), full: true },
  ];
  const keywords = splitRuleList(pick(data, "文风关键词") ?? pick(data, "文风"));
  // 诚实标签：adapter 现写「读者体验规则」；兼容旧书「描写重点」。长字段占整行。
  const readerExpRaw = pick(data, "读者体验规则") ?? pick(data, "描写重点");
  const readerPartition = partitionAntiAiPrefixedRules(splitRuleList(readerExpRaw));
  const languageStyleRaw = pick(data, "语言风格");
  const languagePartition = partitionAntiAiPrefixedRules(splitRuleList(languageStyleRaw));
  const language: readonly Field[] = [
    {
      label: "语言风格",
      value: languagePartition.kept.length > 0 ? languagePartition.kept.join("；") : undefined,
      serif: true,
      full: true,
    },
    {
      label: "读者体验规则",
      value: readerPartition.kept.length > 0 ? readerPartition.kept.join("；") : undefined,
      full: true,
    },
  ];
  const rhythm: readonly Field[] = [
    { label: "整体节奏", value: pick(data, "节奏") },
    { label: "目标字数", value: pick(data, "目标字数") },
    { label: "段落节奏", value: pick(data, "段落节奏"), full: true },
  ];
  const reveal: readonly Field[] = [
    { label: "揭示策略", value: pick(data, "揭示策略") ?? pick(data, "信息揭示") },
    { label: "伏笔处理", value: pick(data, "伏笔处理") },
  ];

  const fp = (effFingerprints ?? []).filter((f) => has(f.label) && Number.isFinite(f.value));
  // 老书：语言风格/描写重点/禁止事项里的「反AI·」条目归入反 AI 区展示，不改盘上数据。
  // 若 enrichment 表已有同名规则，不再重复塞（否则 7 条 enrichment + 7 条 diverted = 14）。
  const existingAnti = (effAntiRules ?? []).filter((r) => has(r.name) || has(r.desc));
  const existingNames = new Set(existingAnti.map((r) => r.name.trim()));
  const divertedAnti = [
    ...forbiddenPartition.antiAi,
    ...readerPartition.antiAi,
    ...languagePartition.antiAi,
  ]
    .map((line, i) => antiRuleFromPrefixedLine(line, i))
    .filter((r) => !existingNames.has(r.name.trim()));
  const antiMerged = [...existingAnti, ...divertedAnti];
  const antiKeys = antiMerged.map((r) => (r.desc?.trim() ? `${r.name}：${r.desc}` : r.name));
  const anti = semanticDedupRules(antiKeys).map((line) => {
    const from = antiMerged.find((r) => {
      const key = r.desc?.trim() ? `${r.name}：${r.desc}` : r.name;
      return key === line;
    });
    return from ?? {
      name: line.split(/[：:]/u, 1)[0] ?? line,
      desc: "",
      type: "risk" as const,
      severity: "medium" as const,
    };
  });
  const customNotesText = typeof customNotes === "string" ? customNotes.trim() : "";

  // codex 的全部 section 版式都列出，空数据者各自 node === null → 降级隐藏。
  const sections: readonly { readonly title: string; readonly cnt?: string; readonly node: ReactNode }[] = [
    { title: "叙事方式", node: <SpecGrid fields={narrative} /> },
    {
      title: "语言风格",
      node: keywords.length > 0 || hasConfigured(language) ? (
        <div className="spec">
          {keywords.length > 0 ? (
            <div className="cell full">
              <h5>关键词</h5>
              <div className="val">
                {keywords.map((kw) => <span key={kw} className="kwd">{kw}</span>)}
              </div>
            </div>
          ) : null}
          {language.filter((f) => isConfigured(f.value)).map((f) => <SpecCell key={f.label} field={f} />)}
        </div>
      ) : null,
    },
    { title: "节奏与篇幅", node: <SpecGrid fields={rhythm} /> },
    {
      title: "文风特点",
      cnt: "本书可识别度",
      node: fp.length > 0 ? (
        <div className="feat" style={{ marginBottom: 6 }}>
          {fp.map((f) => {
            const pct = Math.max(0, Math.min(100, Math.round(f.value)));
            return (
              <div key={f.label} className="feat-row">
                <span className="fl">{uiText(f.label)}</span>
                <span className="ftrack"><span className="ffill" style={{ width: `${pct}%` }} /></span>
                <span className="fv">{pct}</span>
              </div>
            );
          })}
        </div>
      ) : null,
    },
    { title: "信息安排", node: <SpecGrid fields={reveal} /> },
  ];
  const visible = sections.filter((s) => s.node !== null);

  if (visible.length === 0 && forbiddenItems.length === 0 && anti.length === 0 && !customNotesText) {
    return (
      <div className="read-inner">
        <div className="catrail-foot" style={{ marginTop: 40 }}>
          <b>还没有写作规则</b>　去右边对 AI 说「帮我整理本书写法」，AI 会把适合这本书的写作规则整理在这里。
        </div>
      </div>
    );
  }

  const stats: readonly { readonly n: number; readonly label: string }[] = [
    ...(visible.length > 0 ? [{ n: visible.length, label: "文风项" }] : []),
    ...(anti.length > 0 ? [{ n: anti.length, label: "避免机器腔" }] : []),
  ];

  return (
    <section className="panel on" id="p-rules">
      <div className="page-head">
        <div>
          <div className="kicker">本书文风</div>
          <h1>写作规则</h1>
          <PanelEnrichButton onSendMessage={onSendMessage} intent="帮我补全本书的写作规则和文风特点" label="✦ 补全写作规则" />
          <p className="lead-sub">这里写清楚这本书该怎么讲、怎么写，以及一定不要写什么。AI 写作和内容审阅时都会遵守。</p>
        </div>
        {stats.length > 0 ? (
          <div className="stats">
            {stats.map((s) => (
              <div key={s.label} className="stat"><b>{s.n}</b><small>{s.label}</small></div>
            ))}
          </div>
        ) : null}
      </div>

      {visible.map((s, i) => (
        <div key={s.title}>
          <H2 no={String(i + 1).padStart(2, "0")} title={s.title} cnt={s.cnt} />
          {s.node}
        </div>
      ))}

      {forbiddenItems.length > 0 ? (
        <div className="ban-box">
          <h5>⊘ 一定不要写</h5>
          <ul>
            {forbiddenItems.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
      ) : null}

      {customNotesText ? (
        <>
          <H2 no={String(visible.length + 1).padStart(2, "0")} title="我的补充" cnt="作者自定·每章必遵守" />
          <div className="custom-notes-md">{renderMarkdownNotes(customNotesText)}</div>
        </>
      ) : null}

      {anti.length > 0 ? (
        <>
          <H2 no={String(visible.length + 1).padStart(2, "0")} title="避免机器腔" cnt="内容审阅检查项" />
          <div className="anti-table">
            <div className="arow ahead"><span>规则名</span><span>描述</span><span>类型</span><span>严重度</span></div>
            {anti.map((r, i) => (
              <div key={`${r.name}-${i}`} className="arow">
                <span className="aname">{uiText(r.name)}</span>
                <span className="adesc">{uiText(r.desc)}</span>
                <span className="adesc"><span className={`tag ${TYPE_TAG[r.type]}`}>{r.type}</span></span>
                <span className="asev"><span className={`tag ${SEVERITY_TAG[r.severity]}`}>{r.severity}</span></span>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

const TYPE_TAG: Record<AntiAiRule["type"], string> = {
  forbidden: "danger",
  risk: "warn",
  encourage: "ok",
};
const SEVERITY_TAG: Record<AntiAiRule["severity"], string> = {
  high: "warn",
  medium: "gold",
  low: "ok",
};

type Field = { readonly label: string; readonly value?: string; readonly full?: boolean; readonly serif?: boolean };

function H2({ no, title, cnt }: { readonly no: string; readonly title: string; readonly cnt?: string }) {
  return (
    <div className="h2">
      <span className="bar" /><span className="no">{no}</span><h2>{title}</h2><span className="tail" />
      {cnt ? <span className="cnt">{cnt}</span> : null}
    </div>
  );
}

function SpecGrid({ fields }: { readonly fields: readonly Field[] }) {
  const configured = fields.filter((f) => isConfigured(f.value));
  if (configured.length === 0) return null;
  return (
    <div className="spec">
      {configured.map((f) => <SpecCell key={f.label} field={f} />)}
    </div>
  );
}

function SpecCell({ field }: { readonly field: Field }) {
  const items = splitLongRuleValueForDisplay(field.value);
  return (
    <div className={field.full ? "cell full" : "cell"}>
      <h5>{field.label}</h5>
      <div className={field.serif ? "val serif" : "val"}>
        {items.length > 1 ? (
          <ul className="rule-list">
            {items.map((item) => <li key={item}>{uiText(item)}</li>)}
          </ul>
        ) : (
          uiText(field.value)
        )}
      </div>
    </div>
  );
}

/** 把「反AI·名：描述」还原成 AntiAiRule，供老书展示归位。 */
function antiRuleFromPrefixedLine(line: string, index: number): AntiAiRule {
  const body = stripAntiAiPrefix(line);
  const sep = body.indexOf("：") >= 0 ? body.indexOf("：") : body.indexOf(":");
  const name = sep > 0 ? body.slice(0, sep).trim() : (body.slice(0, 24) || `反AI规则${index + 1}`);
  const desc = sep > 0 ? body.slice(sep + 1).trim() : body;
  return {
    name,
    desc,
    type: /禁|禁止|不要|勿/u.test(name + desc) ? "forbidden" : /鼓励|多用|应写/u.test(name + desc) ? "encourage" : "risk",
    severity: /禁|禁止/u.test(name + desc) ? "high" : "medium",
  };
}

function hasConfigured(fields: readonly Field[]): boolean {
  return fields.some((f) => isConfigured(f.value));
}

function has(s?: string): s is string {
  return typeof s === "string" && s.trim().length > 0;
}

// ── 以下数据处理逻辑镜像现有 WritingRulesPanel.tsx，保证两版同源 ──

function labeledValues(items: readonly string[]): ReadonlyMap<string, string> {
  const entries = items.map((item) => {
    const cleaned = uiText(item);
    const separator = cleaned.indexOf("：");
    if (separator < 0) return undefined;
    return [cleaned.slice(0, separator).trim(), cleaned.slice(separator + 1).trim()] as const;
  }).filter((entry): entry is readonly [string, string] => Boolean(entry));
  return new Map(entries);
}

function pick(values: ReadonlyMap<string, string>, label: string): string | undefined {
  return values.get(label);
}

function splitRuleList(value: string | undefined): readonly string[] {
  if (!isConfigured(value)) return [];
  return [...new Set(uiText(value).split(/[；;\n]/u).map((item) => item.trim()).filter(Boolean))];
}

function isConfigured(value: string | undefined): boolean {
  const cleaned = value?.trim();
  return Boolean(cleaned && !/^尚未配置/.test(cleaned) && cleaned !== "待配置" && cleaned !== "暂无数据");
}

/**
 * 轻量 Markdown 渲染（无新依赖）：标题(#)/无序列表(- *)/空行/段落，行内 **bold** 复用 renderRichText。
 * customNotes 是用户随手写的自由 Markdown，够用即可；复杂语法不强求。
 */
function renderMarkdownNotes(text: string): ReactNode {
  const lines = text.split(/\r?\n/u);
  const out: ReactNode[] = [];
  let listBuf: string[] = [];
  const flushList = (key: string): void => {
    if (listBuf.length === 0) return;
    const items = listBuf;
    listBuf = [];
    out.push(<ul key={key}>{items.map((it, i) => <li key={i}>{renderRichText(it)}</li>)}</ul>);
  };
  lines.forEach((raw, idx) => {
    const line = raw.trimEnd();
    const heading = /^(#{1,6})\s+(.*)$/u.exec(line);
    const bullet = /^[-*]\s+(.*)$/u.exec(line);
    if (heading) {
      flushList(`ul-${idx}`);
      out.push(<div key={idx} className="cn-h"><b>{renderRichText(heading[2])}</b></div>);
    } else if (bullet) {
      listBuf.push(bullet[1]);
    } else if (line.trim() === "") {
      flushList(`ul-${idx}`);
    } else {
      flushList(`ul-${idx}`);
      out.push(<p key={idx}>{renderRichText(line)}</p>);
    }
  });
  flushList("ul-end");
  return out;
}
