import { Extension } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/**
 * 选区改写会改的那一整句：只画一层底纹，不动作者的选区。
 *
 * 以前（10-08）为了让作者看到「会改整句」，直接把编辑器选区扩到整句——作者选两个字想打字替换，
 * 一打字整句没了（换题材长篇实跑 2026-10-27）。现在选区原样留着，整句只用这层底纹标出来；
 * 文档一变（打字、替换）就撤掉。
 */
type SnapRange = { readonly from: number; readonly to: number } | null;

export const SNAP_PREVIEW_KEY = new PluginKey<SnapRange>("snapPreview");

export const SnapPreview = Extension.create({
  name: "snapPreview",
  addProseMirrorPlugins() {
    return [
      new Plugin<SnapRange>({
        key: SNAP_PREVIEW_KEY,
        state: {
          init: () => null,
          apply(tr, value) {
            const meta = tr.getMeta(SNAP_PREVIEW_KEY) as SnapRange | undefined;
            if (meta !== undefined) return meta;
            return tr.docChanged ? null : value;
          },
        },
        props: {
          decorations(state) {
            const range = SNAP_PREVIEW_KEY.getState(state);
            if (!range || range.to <= range.from) return DecorationSet.empty;
            return DecorationSet.create(state.doc, [Decoration.inline(range.from, range.to, { class: "se-v2-snap-preview" })]);
          },
        },
      }),
    ];
  },
});

/** 标出（或撤掉）改写会改的那一整句；和现在的一样就不发事务。 */
export function setSnapPreview(editor: Editor, range: SnapRange): void {
  const current = SNAP_PREVIEW_KEY.getState(editor.state) ?? null;
  if (current?.from === range?.from && current?.to === range?.to) return;
  editor.view.dispatch(editor.state.tr.setMeta(SNAP_PREVIEW_KEY, range));
}
