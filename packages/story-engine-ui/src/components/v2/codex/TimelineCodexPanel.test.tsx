import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import TimelineCodexPanel, { stripMainEventFromSummary } from "./TimelineCodexPanel.js";

afterEach(() => cleanup());

// ── fixture 数据 ─────────────────────────────────────────────────────────────
const L1_EVENTS = [
  { chapter: 12, summary: "在保管间找到贴着 P-07 标签的胶卷盒。", mainEvent: "发现编号 P-07 胶卷", location: "保管间" },
  { chapter: 11, summary: "货单封面印着 K-19。", mainEvent: "确认货单编号 K-19" },
  { chapter: 10, summary: "沈明拿到胶卷索引。", location: "档案室" },
];

const L2_EVENTS = [
  { chapter: 9, summary: "许鸢身份暴露，两人关系破裂。" },
  { chapter: 8, summary: "北塔保管间发现胶卷。" },
  { chapter: 7, summary: "沈明拿到胶卷索引。" },
  { chapter: 6, summary: "档案室交锋。" },
  { chapter: 5, summary: "走私档案浮现。" },
];

const L3_BLOCKS = [
  { fromChapter: 1, toChapter: 4, summary: "林渡发现走私档案，与许鸢在档案馆交锋。" },
  { fromChapter: 5, toChapter: 9, summary: "胶卷索引浮现，许鸢身份暴露。" },
];

describe("TimelineCodexPanel 空态", () => {
  it("timeline 全空时显示引导文、不渲染任何层", () => {
    render(<TimelineCodexPanel timeline={{ recentEvents: [], earlierSummary: [], macroSummary: [] }} />);
    expect(screen.getByText(/还没有时间线/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /近期/ })).not.toBeInTheDocument();
  });

  it("timeline 为 undefined（未加载）时也显示引导文", () => {
    render(<TimelineCodexPanel />);
    expect(screen.getByText(/还没有时间线/)).toBeInTheDocument();
  });
});

describe("TimelineCodexPanel L1 近期层", () => {
  it("渲染近期事件，按章号倒序（新在上）", () => {
    render(<TimelineCodexPanel timeline={{ recentEvents: L1_EVENTS, earlierSummary: [], macroSummary: [] }} />);
    // 三章都在
    expect(screen.getByText(/发现编号 P-07/)).toBeInTheDocument();
    expect(screen.getByText(/确认货单编号 K-19/)).toBeInTheDocument();
    expect(screen.getByText(/胶卷索引/)).toBeInTheDocument();
    // 倒序：第12章块在第11章块之前（按 asset-item 顺序）
    const items = screen.getAllByText(/第\d+章/);
    expect(items[0]).toHaveTextContent("第12章");
    expect(items[1]).toHaveTextContent("第11章");
    expect(items[2]).toHaveTextContent("第10章");
  });

  it("location 缺失时隐藏地点标记、不渲染空地点", () => {
    render(<TimelineCodexPanel timeline={{ recentEvents: L1_EVENTS, earlierSummary: [], macroSummary: [] }} />);
    const locs = screen.queryAllByTestId("loc");
    // 第12章和第10章有 location，第11章无 → 2 个地点标记
    expect(locs).toHaveLength(2);
  });

  it("mainEvent 存在时显示、缺失时不渲染空标记", () => {
    // L1_EVENTS 前两条有 mainEvent，第10章无 → 2 个 mainEvent 标记
    render(<TimelineCodexPanel timeline={{ recentEvents: L1_EVENTS, earlierSummary: [], macroSummary: [] }} />);
    expect(screen.getAllByTestId("mainEvent")).toHaveLength(2);
  });

  it("mainEvent 全缺时不渲染任何标题事件标记", () => {
    cleanup();
    const noMain = [{ chapter: 13, summary: "只有摘要，无标题事件。" }];
    render(<TimelineCodexPanel timeline={{ recentEvents: noMain, earlierSummary: [], macroSummary: [] }} />);
    expect(screen.queryAllByTestId("mainEvent")).toHaveLength(0);
    expect(screen.getByText(/只有摘要/)).toBeInTheDocument();
  });

  // 有声明时 mainEvent 与 summary 都是同一句干净摘要——面板不重复渲染同一句（否则一条章节里同一句话上下各一遍）。
  it("summary 与 mainEvent 相同时只渲染一次、不重复", () => {
    cleanup();
    const dup = [{ chapter: 14, summary: "叶青衡发现藏丹坑已空。", mainEvent: "叶青衡发现藏丹坑已空。" }];
    render(<TimelineCodexPanel timeline={{ recentEvents: dup, earlierSummary: [], macroSummary: [] }} />);
    // 该句只出现一次（在 mainEvent 加粗标记里），不再另起一个 summary span
    expect(screen.getAllByText(/叶青衡发现藏丹坑已空/)).toHaveLength(1);
    expect(screen.getByTestId("mainEvent")).toHaveTextContent("叶青衡发现藏丹坑已空。");
  });

  // summary 与 mainEvent 不同（如无声明、正则选句）时，两句都要展示，不误吞 summary。
  it("summary 与 mainEvent 不同时两句都渲染", () => {
    cleanup();
    const distinct = [{ chapter: 15, summary: "他在柜底摸出一枚编号 YJ-01 的玉简。", mainEvent: "发现师父留下的玉简" }];
    render(<TimelineCodexPanel timeline={{ recentEvents: distinct, earlierSummary: [], macroSummary: [] }} />);
    expect(screen.getByText(/发现师父留下的玉简/)).toBeInTheDocument();
    expect(screen.getByText(/编号 YJ-01/)).toBeInTheDocument();
  });

  // 真机走查（测试悬疑书 ch4）：timelineSummary=top-2 句拼接、首句=mainEvent，
  // 直接渲染 summary 会让 mainEvent 那句上下各一遍——summary 只留 mainEvent 之外的补充句。
  it("summary 以 mainEvent 句开头时只渲染补充句、mainEvent 不出现两遍", () => {
    cleanup();
    const overlapped = [{
      chapter: 4,
      summary: "白天他注意到刮痕，是整齐的几道。 船舱里隐约有声音，闷闷的。",
      mainEvent: "白天他注意到刮痕，是整齐的几道。",
    }];
    render(<TimelineCodexPanel timeline={{ recentEvents: overlapped, earlierSummary: [], macroSummary: [] }} />);
    expect(screen.getAllByText(/白天他注意到刮痕/)).toHaveLength(1);
    expect(screen.getByText(/船舱里隐约有声音/)).toBeInTheDocument();
  });
});

describe("stripMainEventFromSummary", () => {
  it("summary 含 mainEvent 子串：抠掉后只留补充句", () => {
    expect(stripMainEventFromSummary("A句。 B句。", "A句。")).toBe("B句。");
  });
  it("summary 与 mainEvent 完全相同：返回 undefined", () => {
    expect(stripMainEventFromSummary("同一句。", "同一句。")).toBeUndefined();
  });
  it("summary 不含 mainEvent：原样返回", () => {
    expect(stripMainEventFromSummary("别的句子。", "主事件")).toBe("别的句子。");
  });
  it("mainEvent 缺失：summary 原样返回", () => {
    expect(stripMainEventFromSummary("有摘要。", undefined)).toBe("有摘要。");
  });
  it("summary 缺失：返回 undefined", () => {
    expect(stripMainEventFromSummary(undefined, "主事件")).toBeUndefined();
  });
  it("mainEvent 被 truncate 截断带尾省略号：仍能按前缀抠掉", () => {
    expect(stripMainEventFromSummary("很长的主事件句子全文。 补充句。", "很长的主事件句子全文。…")).toBe("补充句。");
  });
  it("抠空后残留孤儿省略号：清掉返回 undefined", () => {
    expect(stripMainEventFromSummary("主事件…", "主事件…")).toBeUndefined();
  });
});

describe("TimelineCodexPanel 跨层去重（同一章不在两层重复出现）", () => {
  // 真机走查（测试悬疑书 4 章书）：recentEvents 窗口=5 而 L1 层窗=3，
  // 第 1 章同时落进「近期」与「中段」，用户看到同一章两遍。
  it("被 L2 覆盖的章从近期剔除", () => {
    const overlap = {
      recentEvents: [
        { chapter: 1, summary: "第一章的事。" },
        { chapter: 2, summary: "第二章的事。" },
        { chapter: 3, summary: "第三章的事。" },
        { chapter: 4, summary: "第四章的事。" },
      ],
      earlierSummary: [{ chapter: 1, summary: "第一章的事。" }],
      macroSummary: [],
    };
    render(<TimelineCodexPanel timeline={overlap} />);
    // 第1章只出现一次——在中段那一行，近期不再有第1章的条目
    expect(screen.getAllByText(/第一章的事/)).toHaveLength(1);
    expect(screen.getByText(/第1章 · 第一章的事/)).toBeInTheDocument();
    // 近期区的章头是独立 <b>第N章</b>：只剩 2/3/4 章
    const l1Heads = screen.getAllByText(/^第\d+章$/);
    expect(l1Heads.map((el) => el.textContent)).toEqual(["第4章", "第3章", "第2章"]);
  });

  it("被 L3 宏块覆盖的章从近期剔除", () => {
    cleanup();
    const overlap = {
      recentEvents: [
        { chapter: 3, summary: "第三章的事。" },
        { chapter: 20, summary: "第二十章的事。" },
      ],
      earlierSummary: [],
      macroSummary: [{ fromChapter: 1, toChapter: 5, summary: "开局五章脉络。" }],
    };
    render(<TimelineCodexPanel timeline={overlap} />);
    expect(screen.queryByText(/第三章的事/)).not.toBeInTheDocument();
    expect(screen.getByText(/第二十章的事/)).toBeInTheDocument();
    expect(screen.getByText(/开局五章脉络/)).toBeInTheDocument();
  });
});

describe("TimelineCodexPanel L2 中段层折叠", () => {
  it("L2 默认展开最近 3 条 + 显示『展开更早 2 章』按钮", () => {
    render(<TimelineCodexPanel timeline={{ recentEvents: [], earlierSummary: L2_EVENTS, macroSummary: [] }} />);
    expect(screen.getByText(/许鸢身份暴露/)).toBeInTheDocument();
    expect(screen.getByText(/北塔保管间/)).toBeInTheDocument();
    expect(screen.getByText(/沈明拿到胶卷索引/)).toBeInTheDocument();
    expect(screen.queryByText(/档案室交锋/)).not.toBeInTheDocument();
    expect(screen.queryByText(/走私档案浮现/)).not.toBeInTheDocument();
    expect(screen.getByText(/展开更早 2 章/)).toBeInTheDocument();
  });

  it("点击『展开更早 N 章』显示全部 L2，按钮变『收起』", () => {
    render(<TimelineCodexPanel timeline={{ recentEvents: [], earlierSummary: L2_EVENTS, macroSummary: [] }} />);
    fireEvent.click(screen.getByText(/展开更早 2 章/));
    expect(screen.getByText(/档案室交锋/)).toBeInTheDocument();
    expect(screen.getByText(/走私档案浮现/)).toBeInTheDocument();
    expect(screen.getByText(/收起/)).toBeInTheDocument();
  });

  it("再点『收起』恢复默认 3 条", () => {
    render(<TimelineCodexPanel timeline={{ recentEvents: [], earlierSummary: L2_EVENTS, macroSummary: [] }} />);
    fireEvent.click(screen.getByText(/展开更早 2 章/));
    fireEvent.click(screen.getByText(/收起/));
    expect(screen.queryByText(/档案室交锋/)).not.toBeInTheDocument();
  });

  it("L2 <= 3 条时不显示展开按钮", () => {
    const short = L2_EVENTS.slice(0, 2);
    render(<TimelineCodexPanel timeline={{ recentEvents: [], earlierSummary: short, macroSummary: [] }} />);
    expect(screen.queryByText(/展开更早/)).not.toBeInTheDocument();
  });
});

describe("TimelineCodexPanel L3 远期层", () => {
  it("宏观块全展开，显示第X-Y章 + summary", () => {
    render(<TimelineCodexPanel timeline={{ recentEvents: [], earlierSummary: [], macroSummary: L3_BLOCKS }} />);
    expect(screen.getByText(/走私档案/)).toBeInTheDocument();
    expect(screen.getByText(/胶卷索引浮现/)).toBeInTheDocument();
    expect(screen.getByText(/第1-4章/)).toBeInTheDocument();
    expect(screen.getByText(/第5-9章/)).toBeInTheDocument();
  });

  it("L3 按 toChapter 倒序（更新的块在上）", () => {
    render(<TimelineCodexPanel timeline={{ recentEvents: [], earlierSummary: [], macroSummary: L3_BLOCKS }} />);
    const blocks = screen.getAllByText(/胶卷索引浮现|走私档案/);
    expect(blocks[0]).toHaveTextContent(/胶卷索引浮现/);
    expect(blocks[1]).toHaveTextContent(/走私档案/);
  });
});

describe("TimelineCodexPanel 短书退化", () => {
  it("只有 L1（L2/L3 空）时只渲染 L1，不出现中段/远期标题", () => {
    render(<TimelineCodexPanel timeline={{ recentEvents: L1_EVENTS.slice(0, 1), earlierSummary: [], macroSummary: [] }} />);
    // L1 第12章渲染了（mainEvent + summary 都含 P-07）
    expect(screen.getAllByText(/P-07/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/^中段/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^远期/)).not.toBeInTheDocument();
  });
});
