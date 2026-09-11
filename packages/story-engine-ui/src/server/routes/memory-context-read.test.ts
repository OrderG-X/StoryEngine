import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { makeHomeTempDir, testRunRoot } from "../lib/home-test-tmp.js";
import type { Middleware } from "../lib/project-io.js";
import { registerMemoryContextReadRoutes } from "./memory-context-read.js";

const packageRoot = process.cwd();

describe("Memory Context Runtime read-only route", () => {
  let projectDir: string | undefined;
  let externalDir: string | undefined;
  const extraCleanupPaths: string[] = [];

  afterEach(async () => {
    while (extraCleanupPaths.length > 0) {
      const cleanupPath = extraCleanupPaths.pop();
      if (cleanupPath) {
        await rm(cleanupPath, { recursive: true, force: true });
      }
    }
    if (projectDir) {
      await rm(projectDir, { recursive: true, force: true });
      projectDir = undefined;
    }
    if (externalDir) {
      await rm(externalDir, { recursive: true, force: true });
      externalDir = undefined;
    }
  });

  it("returns ready display-safe read-only output for legal memory/project.json", async () => {
    projectDir = await createProject();
    await writeProjectFile(
      projectDir,
      "memory/project.json",
      JSON.stringify([{ id: "rule-1", type: "project_rule", text: "Keep continuity notes visible." }]),
    );

    const response = await callMemoryContextReadRoute({
      projectPath: projectDir,
      memoryTargetPath: "memory/project.json",
      requestId: "route-happy-path",
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload).toMatchObject({
      ok: true,
      status: "ready",
      normalizedPath: "memory/project.json",
      readOnly: true,
      canWrite: false,
      canInjectAutomatically: false,
      didReadFile: true,
      didWriteMemory: false,
      didInjectAutomatically: false,
      requestId: "route-happy-path",
      safety: {
        noStateJsonWrite: true,
        noMemoryWrite: true,
        noMarkdownWrite: true,
        noFormalCommit: true,
        noPromptInjection: true,
        noConfirmApplyEffect: true,
      },
    });
    expect(response.payload.viewModel).toEqual(expect.objectContaining({ readOnly: true, canWrite: false }));
    expect(JSON.stringify(response.payload)).not.toContain("sourcePath");
    expect(JSON.stringify(response.payload)).not.toContain(projectDir);
  });

  it("returns warning for malformed JSON without uncontrolled throw", async () => {
    projectDir = await createProject();
    await writeProjectFile(projectDir, "memory/bad.json", "{not json");

    const response = await callMemoryContextReadRoute({
      projectPath: projectDir,
      memoryTargetPath: "memory/bad.json",
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload.status).toBe("warning");
    expect(response.payload.warnings).toEqual(expect.arrayContaining([expect.stringContaining("parse failed warning")]));
    expect(response.payload).toMatchObject({
      readOnly: true,
      canWrite: false,
      canInjectAutomatically: false,
      didWriteMemory: false,
      didInjectAutomatically: false,
    });
  });

  it("returns controlled output for empty memory file", async () => {
    projectDir = await createProject();
    await writeProjectFile(projectDir, "memory/empty.txt", "");

    const response = await callMemoryContextReadRoute({
      projectPath: projectDir,
      memoryTargetPath: "memory/empty.txt",
    });

    expect(response.statusCode).toBe(200);
    expect(["ready", "warning"]).toContain(response.payload.status);
    expect(response.payload.viewModel).toEqual(expect.objectContaining({ readOnly: true, canWrite: false }));
  });

  it("returns blocked output for oversized memory file", async () => {
    projectDir = await createProject();
    await writeProjectFile(projectDir, "memory/large.txt", "x".repeat(128));

    const response = await callMemoryContextReadRoute({
      projectPath: projectDir,
      memoryTargetPath: "memory/large.txt",
      limits: { maxFileBytes: 32 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload.status).toBe("blocked");
    expect(response.payload.blockingReasons).toEqual(expect.arrayContaining([expect.stringContaining("oversized")]));
    expect(response.payload.didWriteMemory).toBe(false);
    expect(response.payload.didInjectAutomatically).toBe(false);
  });

  it.each([
    "../memory/project.json",
    "memory/.secret.json",
    ".story-engine-tx/workspace-patches/x",
    "story/state/hooks.json",
    "snapshot-manifest.json",
  ])("blocks unsafe memory target %s", async (memoryTargetPath) => {
    projectDir = await createProject();
    await writeProjectFile(projectDir, "memory/project.json", "[]");

    const response = await callMemoryContextReadRoute({
      projectPath: projectDir,
      memoryTargetPath,
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload.status).toBe("blocked");
    expect(response.payload.viewModel).toBeNull();
    expect(response.payload.blockingReasons).toEqual(expect.arrayContaining([expect.any(String)]));
    expect(response.payload.didReadFile).toBe(false);
    expect(response.payload.didWriteMemory).toBe(false);
  });

  it("blocks symlink projectRoot before project validation can follow it to an external project", async () => {
    externalDir = await createProjectIn(tmpdir(), "memory-context-external-story-");
    await writeProjectFile(
      externalDir,
      "memory/project.json",
      JSON.stringify([{ id: "external", text: "EXTERNAL_SHOULD_NOT_READ" }]),
    );
    await mkdir(testRunRoot(), { recursive: true });
    const symlinkRoot = join(testRunRoot(), `memory-context-read-symlink-external-${Date.now()}`);
    extraCleanupPaths.push(symlinkRoot);
    await symlink(externalDir, symlinkRoot, "dir");

    const response = await callMemoryContextReadRoute({
      projectPath: symlinkRoot,
      memoryTargetPath: "memory/project.json",
    });

    expect(response.statusCode).toBe(400);
    expect(response.payload.status).toBe("blocked");
    expect(response.payload.didReadFile).toBe(false);
    expect(response.payload.blockingReasons).toEqual(expect.arrayContaining([expect.stringContaining("symlink")]));
    expect(JSON.stringify(response.payload)).not.toContain("EXTERNAL_SHOULD_NOT_READ");
  });

  it("blocks symlink projectRoot even when it points at a valid home project", async () => {
    projectDir = await createProject();
    await writeProjectFile(projectDir, "memory/project.json", "[]");
    await mkdir(testRunRoot(), { recursive: true });
    const symlinkRoot = join(testRunRoot(), `memory-context-read-symlink-valid-${Date.now()}`);
    extraCleanupPaths.push(symlinkRoot);
    await symlink(projectDir, symlinkRoot, "dir");

    const response = await callMemoryContextReadRoute({
      projectPath: symlinkRoot,
      memoryTargetPath: "memory/project.json",
    });

    expect(response.statusCode).toBe(400);
    expect(response.payload.status).toBe("blocked");
    expect(response.payload.didReadFile).toBe(false);
    expect(response.payload.blockingReasons).toEqual(expect.arrayContaining([expect.stringContaining("symlink")]));
  });

  it("blocks absolute memoryTargetPath values at the route boundary", async () => {
    projectDir = await createProject();
    await writeProjectFile(projectDir, "memory/project.json", "[]");

    for (const memoryTargetPath of [
      join(projectDir, "memory", "project.json"),
      "/tmp/outside-memory.json",
      "C:\\projects\\story\\memory\\project.json",
      "\\\\server\\share\\memory\\project.json",
    ]) {
      const response = await callMemoryContextReadRoute({
        projectPath: projectDir,
        memoryTargetPath,
      });

      expect(response.statusCode).toBe(400);
      expect(response.payload.status).toBe("blocked");
      expect(response.payload.viewModel).toBeNull();
      expect(response.payload.didReadFile).toBe(false);
      expect(response.payload.blockingReasons).toEqual(expect.arrayContaining([expect.stringContaining("absolute")]));
    }
  });

  it("does not handle prefix-matched route paths", async () => {
    projectDir = await createProject();
    await writeProjectFile(projectDir, "memory/project.json", "[]");

    const response = await callMemoryContextReadRoute(
      {
        projectPath: projectDir,
        memoryTargetPath: "memory/project.json",
      },
      { url: "/api/memory/context/read-extra" },
    );

    expect(response.nextCalled).toBe(true);
    expect(response.payload).toBeUndefined();
  });

  it("returns controlled 400 output for malformed JSON request body", async () => {
    const response = await callMemoryContextReadRoute(undefined, { rawBody: "{not json" });

    expect(response.statusCode).toBe(400);
    expect(response.payload?.status).toBe("failed");
    expect(response.payload?.warnings).toEqual(expect.arrayContaining([expect.stringContaining("malformed JSON body")]));
    expect(response.payload?.didReadFile).toBe(false);
    expect(response.payload?.didWriteMemory).toBe(false);
    expect(response.payload?.didInjectAutomatically).toBe(false);
  });

  it("blocks invalid and outside project paths through project guard", async () => {
    const invalid = await callMemoryContextReadRoute({
      projectPath: "/tmp/not-under-home",
      memoryTargetPath: "memory/project.json",
    });

    expect(invalid.statusCode).toBe(400);
    expect(invalid.payload.status).toBe("blocked");
    expect(invalid.payload.blockingReasons).toEqual(expect.arrayContaining([expect.stringContaining("project path")]));

    projectDir = await createProject();
    externalDir = await makeHomeTempDir("memory-context-outside-project-");
    await writeProjectFile(externalDir, "memory/project.json", "[]");
    const outside = await callMemoryContextReadRoute({
      projectPath: projectDir,
      memoryTargetPath: join(externalDir, "memory", "project.json"),
    });

    expect(outside.statusCode).toBe(400);
    expect(outside.payload.status).toBe("blocked");
    expect(outside.payload.didReadFile).toBe(false);
  });

  it("blocks non StoryEngine project when project validation fails", async () => {
    externalDir = await makeHomeTempDir("memory-context-not-project-");
    await mkdir(join(externalDir, "memory"), { recursive: true });
    await writeFile(join(externalDir, "memory", "project.json"), "[]", "utf-8");

    const response = await callMemoryContextReadRoute({
      projectPath: externalDir,
      memoryTargetPath: "memory/project.json",
    });

    expect(response.statusCode).toBe(400);
    expect(response.payload.status).toBe("blocked");
    expect(response.payload.blockingReasons).toEqual(expect.arrayContaining([expect.stringContaining("StoryEngine")]));
    expect(response.payload.didReadFile).toBe(false);
  });

  it("ignores forbidden request fields and returns display-safe runtime output", async () => {
    projectDir = await createProject();
    await writeProjectFile(projectDir, "memory/project.json", "[]");

    const response = await callMemoryContextReadRoute({
      projectPath: projectDir,
      memoryTargetPath: "memory/project.json",
      testHooks: { afterFinalGuardBeforeOpen: "must not pass" },
      sourcePath: "/tmp/secret-memory.json",
      normalizedPath: "story/state/hooks.json",
      apply: true,
      confirm: true,
      write: true,
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload.status).toBe("ready");
    expect(response.payload.normalizedPath).toBe("memory/project.json");
    expect(JSON.stringify(response.payload)).not.toContain("sourcePath");
    expect(JSON.stringify(response.payload)).not.toContain("/tmp/secret-memory.json");
    expect(response.payload.didWriteMemory).toBe(false);
    expect(response.payload.didInjectAutomatically).toBe(false);
    await expect(readFile(join(projectDir, "memory", "project.json"), "utf-8")).resolves.toBe("[]");
  });

  it("returns controlled output for missing target", async () => {
    projectDir = await createProject();

    const response = await callMemoryContextReadRoute({
      projectPath: projectDir,
      memoryTargetPath: "memory/missing.json",
    });

    expect(response.statusCode).toBe(200);
    expect(["warning", "blocked", "failed"]).toContain(response.payload.status);
    expect([...response.payload.warnings as string[], ...response.payload.blockingReasons as string[]].length).toBeGreaterThan(0);
    expect(response.payload.didWriteMemory).toBe(false);
    expect(response.payload.didInjectAutomatically).toBe(false);
  });

  it("keeps route source free of write, UI, and apply boundaries", async () => {
    const routeSource = await readFile(resolve(packageRoot, "src/server/routes/memory-context-read.ts"), "utf-8");

    expect(routeSource).toContain("loadMemoryContextRuntimeAdapter");
    expect(routeSource).not.toContain("readFile");
    expect(routeSource).not.toContain("open(");
    expect(routeSource).not.toContain("writeFile");
    expect(routeSource).not.toContain("applyWorkspacePatch");
    expect(routeSource).not.toContain("CommitEngine");
    expect(routeSource).not.toContain("commitFastDraft");
    expect(routeSource).not.toContain("applyCommit");
    expect(routeSource).not.toContain("components/v2");
    expect(routeSource).not.toContain("afterText");
    expect(routeSource).not.toContain("patch preview");
    expect(routeSource).not.toContain("prompt");
    expect(routeSource).not.toContain("Agent auto apply");
    expect(routeSource).not.toContain("rollback");
  });
});

async function callMemoryContextReadRoute(body: unknown, options: {
  readonly url?: string;
  readonly rawBody?: string;
} = {}): Promise<{
  readonly statusCode: number;
  readonly payload: Record<string, unknown>;
  readonly nextCalled: boolean;
}> {
  const handlers: Middleware[] = [];
  registerMemoryContextReadRoutes({ use: (handler) => handlers.push(handler) });
  const handler = handlers[0];
  if (!handler) throw new Error("route not registered");

  const req = Readable.from([options.rawBody ?? JSON.stringify(body)]) as IncomingMessage;
  req.url = options.url ?? "/api/memory/context/read";
  req.method = "POST";

  const chunks: Buffer[] = [];
  const res = {
    statusCode: 200,
    setHeader: () => undefined,
    end: (chunk: string) => {
      chunks.push(Buffer.from(chunk));
      return {} as ServerResponse;
    },
  } as unknown as ServerResponse;

  let nextCalled = false;
  await handler(req, res, () => {
    nextCalled = true;
  });
  const rawPayload = Buffer.concat(chunks).toString("utf-8");
  return {
    statusCode: res.statusCode,
    payload: rawPayload ? JSON.parse(rawPayload) as Record<string, unknown> : undefined as unknown as Record<string, unknown>,
    nextCalled,
  };
}

async function createProject(): Promise<string> {
  const runRoot = testRunRoot();
  await mkdir(runRoot, { recursive: true });
  return createProjectIn(runRoot, "memory-context-read-route-");
}

async function createProjectIn(parentDir: string, prefix: string): Promise<string> {
  const root = await mkdtemp(join(parentDir, prefix));
  await Promise.all([
    mkdir(join(root, "story"), { recursive: true }),
    mkdir(join(root, "timeline"), { recursive: true }),
    mkdir(join(root, "world"), { recursive: true }),
    mkdir(join(root, "characters"), { recursive: true }),
  ]);
  await writeFile(join(root, "project.json"), JSON.stringify({ title: "Memory Context Route Test" }), "utf-8");
  return root;
}

async function writeProjectFile(projectRoot: string, relativePath: string, text: string): Promise<void> {
  const absolutePath = join(projectRoot, relativePath);
  await mkdir(join(absolutePath, ".."), { recursive: true });
  await writeFile(absolutePath, text, "utf-8");
}
