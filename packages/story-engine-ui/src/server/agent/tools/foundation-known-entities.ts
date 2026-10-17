import type { StateOverview } from "@actalk/story-engine";
import type { FoundationKnownEntities } from "../../lib/project-io.js";

/**
 * 从 StateOverview 抽取已落盘实体的名字→id 清单，喂给解析器回填 targetId（修1）。
 * characterMatrix / assetSummary / locationDetailSummary 比 report.byCategory 全，但受 overview 展示上限
 * （MAX_ITEMS=12，见 state-overview.ts）约束：超出前 12 条的实体不在此清单内，其回填会查不到 → 走诚实 skip。
 */
export function buildFoundationKnownEntities(overview: StateOverview): FoundationKnownEntities {
  return {
    characters: (overview.characterMatrix?.characters ?? [])
      .filter((item) => item.id && item.name)
      .map((item) => ({ id: item.id, name: item.name })),
    locations: (overview.locationDetailSummary?.locations ?? [])
      .filter((item) => item.id && item.name)
      .map((item) => ({ id: item.id, name: item.name })),
    assets: (overview.assetSummary?.assetItems ?? [])
      .filter((item) => item.id && item.name)
      .map((item) => ({ id: item.id, name: item.name })),
  };
}
