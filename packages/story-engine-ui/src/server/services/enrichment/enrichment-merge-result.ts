/**
 * 做厚并入引擎的结果三态（R2 停谎报）：
 *  - { merged: true }                 真并入 ≥1 条进 story/*.json。
 *  - { merged: false }                无对应 bible 文件 / bible 为空 / 无任何条目命中：属正常跳过
 *                                     （展示层已落盘），不是失败。
 *  - { merged: false, reason: "..." } 写盘 / 解析真异常：算失败，reason 必填、含「失败」。
 *
 * 工具层据此：ok 恒为 true（展示层落盘已成功、用户东西没丢），但 summary 按 merged 动态如实告知
 * 是否接进正文，并暴露结构化 mergedIntoEngine 供前端/工具判断。绝不再无条件 catch 后宣称成功。
 */
export type MergeResult = { readonly merged: boolean; readonly reason?: string };
