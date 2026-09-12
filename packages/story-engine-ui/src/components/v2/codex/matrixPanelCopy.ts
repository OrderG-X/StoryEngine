/**
 * P2-17：单角色矩阵标题/副标判定（纯函数）。
 */
export function matrixPanelCopy(characterCount: number): {
  readonly kicker: string;
  readonly titleLead: string;
  readonly titleEm: string;
  readonly sectionTitle: string;
  readonly hint: string | null;
} {
  if (characterCount <= 1) {
    return {
      kicker: "角色近况",
      titleLead: "角色",
      titleEm: "近况",
      sectionTitle: "角色近况",
      hint: "有第二个角色后显示角色关系",
    };
  }
  return {
    kicker: "角色关系",
    titleLead: "角色",
    titleEm: "关系",
    sectionTitle: "角色关系",
    hint: null,
  };
}
