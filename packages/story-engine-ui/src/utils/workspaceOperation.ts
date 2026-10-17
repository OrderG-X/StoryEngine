import type { WorkspaceOperationTarget } from "../type-defs/workspace.js";

export type WorkspaceOperationKind =
  | "agent-chat"
  | "generate-steering"
  | "generate-draft"
  | "quality-check"
  | "ai-review"
  | "revision-preview"
  | "revision-apply"
  | "selection-rewrite"
  | "reroll-candidates"
  | "apply-candidate"
  | "commit-preview"
  | "commit-apply"
  | "navigation-transition"
  | "session-transition"
  | "foundation-write"
  | "deai-fix-all"
  | "other-write";

export interface WorkspaceOperationToken extends WorkspaceOperationTarget {
  readonly kind: WorkspaceOperationKind;
}

export type WorkspaceOperationIdentity = Omit<WorkspaceOperationTarget, "operationId">;

let activeOperation: WorkspaceOperationToken | null = null;
let operationSequence = 0;
let activeOperationRetargeted = false;

/**
 * Atomically claims the single foreground-operation slot. A busy operation is
 * never pre-empted: callers must surface the refusal to the user.
 */
export function beginWorkspaceOperation(
  kind: WorkspaceOperationKind,
  target: WorkspaceOperationIdentity,
): WorkspaceOperationToken | null {
  if (activeOperation) return null;
  operationSequence += 1;
  activeOperation = {
    ...target,
    kind,
    operationId: `workspace-op-${operationSequence.toString(36)}`,
  };
  activeOperationRetargeted = false;
  return activeOperation;
}

export function isWorkspaceOperationCurrent(token: WorkspaceOperationTarget): boolean {
  return activeOperation !== null
    && activeOperation.operationId === token.operationId
    && activeOperation.projectPath === token.projectPath
    && activeOperation.chapter === token.chapter
    && activeOperation.sessionId === token.sessionId;
}

export function isWorkspaceOperationTargetCurrent(
  token: WorkspaceOperationTarget,
  current: WorkspaceOperationIdentity,
): boolean {
  return isWorkspaceOperationCurrent(token)
    && workspaceOperationTargetMatches(token, current);
}

/** Compare persisted candidate/preview ownership after its producing operation has finished. */
export function workspaceOperationTargetMatches(
  target: WorkspaceOperationTarget,
  current: WorkspaceOperationIdentity,
): boolean {
  return target.projectPath === current.projectPath
    && target.chapter === current.chapter
    && target.sessionId === current.sessionId;
}

/**
 * The agent may explicitly choose the next chapter. Adoption is owner-only and
 * can change only the chapter; project, session and operation id stay fixed.
 */
export function retargetWorkspaceOperation(
  token: WorkspaceOperationToken,
  target: { readonly chapter: number },
): WorkspaceOperationToken | null {
  if (
    activeOperationRetargeted
    || !isWorkspaceOperationCurrent(token)
    || !Number.isInteger(target.chapter)
    || target.chapter <= 0
  ) return null;
  activeOperation = { ...token, chapter: target.chapter };
  activeOperationRetargeted = true;
  return activeOperation;
}

export function finishWorkspaceOperation(token: WorkspaceOperationTarget): boolean {
  if (!isWorkspaceOperationCurrent(token)) return false;
  activeOperation = null;
  activeOperationRetargeted = false;
  return true;
}

export function isWorkspaceBusy(): boolean {
  return activeOperation !== null;
}

/** Tests must not leak module-singleton ownership into the next case. */
export function resetWorkspaceOperationForTests(): void {
  activeOperation = null;
  operationSequence = 0;
  activeOperationRetargeted = false;
}
