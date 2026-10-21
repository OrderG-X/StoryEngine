import { afterEach, describe, expect, it, vi } from "vitest";
import { saveBlob } from "./shelfClient.js";

type PickerWindow = Window & { showSaveFilePicker?: unknown };

afterEach(() => {
  delete (window as PickerWindow).showSaveFilePicker;
  vi.restoreAllMocks();
});

function domError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

describe("saveBlob：存好、取消都如实回（真机试写：取消了照样说「导出了」）", () => {
  it("能弹「存到哪」：写进作者选的文件 → saved", async () => {
    const write = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const picker = vi.fn(async () => ({ createWritable: async () => ({ write, close }) }));
    (window as PickerWindow).showSaveFilePicker = picker;
    const blob = new Blob(["正文"]);
    expect(await saveBlob(blob, "修表铺.txt")).toBe("saved");
    expect(picker).toHaveBeenCalledWith({ suggestedName: "修表铺.txt" });
    expect(write).toHaveBeenCalledWith(blob);
    expect(close).toHaveBeenCalled();
  });

  it("作者点了取消 → canceled，不退回下载", async () => {
    (window as PickerWindow).showSaveFilePicker = vi.fn(async () => { throw domError("AbortError"); });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click");
    expect(await saveBlob(new Blob(["x"]), "a.txt")).toBe("canceled");
    expect(click).not.toHaveBeenCalled();
  });

  it("弹不出来（点了太久才弹）或浏览器不支持 → 退回下载链接，回 downloaded", async () => {
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    (window as PickerWindow).showSaveFilePicker = vi.fn(async () => { throw domError("SecurityError"); });
    expect(await saveBlob(new Blob(["x"]), "a.txt")).toBe("downloaded");
    delete (window as PickerWindow).showSaveFilePicker;
    expect(await saveBlob(new Blob(["x"]), "b.txt")).toBe("downloaded");
    expect(click).toHaveBeenCalledTimes(2);
  });

  it("写盘出错 → 如实抛「没存成」", async () => {
    (window as PickerWindow).showSaveFilePicker = vi.fn(async () => ({
      createWritable: async () => ({ write: async () => { throw domError("NoModificationAllowedError"); }, close: async () => undefined }),
    }));
    await expect(saveBlob(new Blob(["x"]), "a.txt")).rejects.toThrow("文件没存成");
  });
});
