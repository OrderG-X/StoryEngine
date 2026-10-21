import { describe, expect, it, vi } from "vitest";

vi.mock("../api/client.js", () => ({ fetchStateOverview: vi.fn(async () => ({})) }));
vi.mock("../drafts/draftSync.js", () => ({ refreshPaper: vi.fn(async () => undefined) }));
vi.mock("./applyOverview.js", () => ({ applyOverviewToWorkspace: vi.fn(), flowStatusForPaper: vi.fn(() => "idle") }));

import { useNavigationStore } from "../stores/navigationStore.js";
import { syncWorkspaceAfterRestore } from "./syncAfterRestore.js";

describe("撤销 / 恢复之后原地重读（P11）", () => {
  it("顶栏「设定本」上「刚定稿」的小点跟着消", async () => {
    useNavigationStore.setState({ projectPath: "/books/a", unseenChangesChapter: 2 });
    await syncWorkspaceAfterRestore("/books/a");
    expect(useNavigationStore.getState().unseenChangesChapter).toBeNull();
  });
});
