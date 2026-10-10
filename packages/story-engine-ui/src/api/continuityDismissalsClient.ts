/**
 * 核账卡「不是问题」/「撤回」：记下或删掉一条（POST /api/continuity-dismissals）。
 * 只是作者对查错结果的批注，下次核同一章不再报；不改正文、不改账本。失败返回 false（卡上如实提示没记住）。
 */
export interface ContinuityDismissalInput {
  readonly chapter: number;
  readonly quote: string;
  readonly earlierQuote: string;
  readonly reason?: string;
}

export async function saveContinuityDismissal(
  projectPath: string,
  item: ContinuityDismissalInput,
  undo = false,
): Promise<boolean> {
  try {
    const res = await fetch("/api/continuity-dismissals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectPath, ...item, ...(undo ? { undo: true } : {}) }),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}
