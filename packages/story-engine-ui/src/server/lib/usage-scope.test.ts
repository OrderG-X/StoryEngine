// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

import { guardProjectPath } from "./project-io.js";
import { currentUsageBook, runInUsageScope } from "./usage-scope.js";

describe("用量记在哪本书名下（P10）", () => {
  it("请求范围里过了项目路径闸，之后（含后台排的活）都认这本书；两个请求互不串", async () => {
    const book = (name: string) => join(homedir(), "StoryEngine-NG", "story-engine", name);
    const seen: (string | undefined)[] = [];
    const request = (name: string) => new Promise<void>((resolve) => {
      runInUsageScope(() => {
        // 像 connect 一样：安全闸之后的中间件同步接着跑，路由里先 await 读 body 再过闸。
        void (async () => {
          await new Promise((wait) => setTimeout(wait, 5));
          guardProjectPath({} as ServerResponse, book(name));
          await new Promise((wait) => setTimeout(wait, 5));
          seen.push(currentUsageBook());
          setTimeout(() => { seen.push(currentUsageBook()); resolve(); }, 10); // 请求之后的后台活
        })();
      });
    });
    await Promise.all([request("a"), request("b")]);
    expect(seen.sort()).toEqual([book("a"), book("a"), book("b"), book("b")]);
    expect(currentUsageBook()).toBeUndefined();
  });
});
