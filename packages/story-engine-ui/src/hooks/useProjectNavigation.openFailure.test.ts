import { describe, expect, it } from "vitest";
import { describeOpenProjectFailure } from "./useProjectNavigation.js";

describe("describeOpenProjectFailure 打开书失败要说清楚", () => {
  const books = [{ title: "梧桐街九号", projectPath: "/p/a" }];
  it("找不到文件夹 → 说清楚并给出下一步", () => {
    const text = describeOpenProjectFailure("Request failed with status 500 项目目录不存在。", "/p/a", books);
    expect(text).toContain("找不到《梧桐街九号》的文件夹");
    expect(text).toContain("从书架移除");
  });
  it("其它错误去掉英文前缀；不认识的书叫「这本书」", () => {
    expect(describeOpenProjectFailure("Request failed with status 500 读取失败", "/p/b", books)).toBe("这本书没打开：读取失败");
  });
});
