/**
 * 稿纸上「可能有问题」那几处划不划线（2026-10-23）：一章常报十几处「可能」，全划上点线，定稿后的正文也满篇虚线、没法读。
 * 默认只划「确定」的；作者在核账卡上点开「可能」那段，才把这一章的「可能」也划出来，收起就撤。
 * 单放一个文件：核账卡和稿纸划线都要用，放进任一边都会和另一边互相引用。
 */
import { create } from "zustand";

export const useMaybeMarks = create<{ readonly chapter: number | null; readonly show: (chapter: number | null) => void }>((set) => ({
  chapter: null,
  show: (chapter) => set({ chapter }),
}));
