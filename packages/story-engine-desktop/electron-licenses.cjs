// electron-builder afterExtract 钩子（P11）：Mac 版出包时 electron-builder 会删掉 Electron 自带的
// LICENSE / LICENSES.chromium.html（app-builder-lib electronMac.js），这里趁删之前抄进应用包
// Contents/Resources，第三方许可清单里说的「随应用分发」才是真的。
// Windows 版 electron-builder 自己留着（安装目录里的 LICENSE.electron.txt），不管。
const { existsSync } = require("node:fs");
const { copyFile } = require("node:fs/promises");
const path = require("node:path");

exports.default = async function copyElectronLicenses(context) {
  if (context.electronPlatformName !== "darwin") return;
  const resources = path.join(context.appOutDir, "Electron.app", "Contents", "Resources");
  for (const [from, to] of [["LICENSE", "LICENSE.electron.txt"], ["LICENSES.chromium.html", "LICENSES.chromium.html"]]) {
    const source = path.join(context.appOutDir, from);
    if (!existsSync(source)) throw new Error(`Electron 解包里没有许可文件：${from}`);
    await copyFile(source, path.join(resources, to));
  }
};
