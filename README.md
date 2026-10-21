<div align="center">

<img src=".github/assets/hero.svg" alt="StoryEngine — 你来写，AI 管账的长篇小说写作软件" width="760" />

<p>
  <a href="https://github.com/OrderG-X/StoryEngine/actions/workflows/ci.yml"><img src="https://github.com/OrderG-X/StoryEngine/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/OrderG-X/StoryEngine/releases/latest"><img src="https://img.shields.io/github/v/release/OrderG-X/StoryEngine?label=%E4%B8%8B%E8%BD%BD" alt="下载" /></a>
  <img src="https://img.shields.io/badge/license-AGPL--3.0-8b5cf6" alt="License: AGPL-3.0" />
  <img src="https://img.shields.io/badge/%E6%95%B0%E6%8D%AE-100%25%20%E6%9C%AC%E5%9C%B0-f59e0b" alt="数据 100% 本地" />
</p>

<p>
  <a href="README.md"><b>简体中文</b></a> ·
  <a href="README.en.md">English</a>
</p>

</div>

---

> 🚧 **持续更新中**：遇到问题、想要新功能，欢迎到 [Issues](https://github.com/OrderG-X/StoryEngine/issues) 提，我们会认真看。

**写长篇小说的桌面软件：正文你来写，右边的 AI 帮你管账——记下每章发生了什么、核前后对不对得上、管好设定。想让它代笔也行。**

## 能做什么

- **逐章记账**：每章定稿时，AI 把出场人物、发生的事、线索、故事里的日子记成账，每条都带正文原句，核不上就如实说没记上
- **核前后矛盾**：写完一章让它核账，它跟读全书，指出这一章和前文对不上的地方，两边原句都摆出来
- **设定本**：人物、地点、物件、规则做成卡片，点字就改；AI 只能补空栏、建新卡，要动你写的得你点头
- **想让 AI 代笔也行**：想走法、出稿、按你的意思改、去 AI 味
- **每步都能撤销**：AI 每次改东西前自动存档；定稿只能你自己点按钮
- **导入已写的书**：txt 自动切章，AI 在后台逐章补账
- **联网查资料**（可选）：要真实世界的细节时让它搜，附来源，只当参考

## 下载安装（Mac）

1. 到 [Releases](https://github.com/OrderG-X/StoryEngine/releases/latest) 下载 `StoryEngine-版本号-arm64.dmg`（Apple 芯片的 Mac）
2. 打开 dmg，把 StoryEngine 拖进「应用程序」
3. **第一次打开会被系统拦下**（我们还没有苹果开发者签名）：
   - 双击 StoryEngine，弹窗里点「完成」
   - 打开「系统设置 → 隐私与安全性」，往下翻到说 StoryEngine 被阻止的那一行，点「仍要打开」，再输入开机密码确认
   - 之后就能正常打开了

   会用终端的话，也可以一条命令放行：

   ```bash
   xattr -dr com.apple.quarantine /Applications/StoryEngine.app
   ```

## 下载安装（Windows）

> ⚠️ **Windows 包还没在 Windows 真机上走查过**（Mac 版走查过）。装不上、打不开、哪里不对，请到 [Issues](https://github.com/OrderG-X/StoryEngine/issues) 说一声，附上「帮助 → 打开日志文件夹」里的 `main.log`，我们会尽快修。

1. 到 [Releases](https://github.com/OrderG-X/StoryEngine/releases/latest) 下载 `StoryEngine-版本号-x64-Setup.exe`，双击安装
2. 如果弹出「Windows 已保护你的电脑」（安装包还没有代码签名）：点「更多信息」→「仍要运行」

Intel 芯片的 Mac 暂时没有安装包，可以[从源码运行](#从源码运行)。

## 开始用

1. **接上 AI**：书架顶上会提示「AI 还没接上」，点「去接上」→ 选一家服务商（DeepSeek、通义千问、智谱 GLM、Kimi、豆包等，任何 OpenAI 兼容接口都行）→ 填你自己的 API Key → 测试连接 → 点一个模型
2. **开一本书**：新建一本，或者「导入已写的书」
3. **联网搜索**（可选）：设置 → 搜索，填[博查](https://open.bochaai.com)或 [Tavily](https://app.tavily.com) 的密钥

不接 AI 也能用：自己写、存稿、导出都不受影响。

## 你的数据

- 书、设定、聊天记录都存在你自己电脑上（书库在 `~/StoryEngine-NG`）
- 密钥只存在 `~/.story-engine/`，只有你的账户能读
- 用 AI 时，正文和设定会发给**你选的**模型服务商；联网搜索时，搜索词会发给**你选的**搜索服务商
- 除此之外不联网：没有账号、没有统计、不收集任何数据

## 从源码运行

需要 Node.js `^20.20.0` / `^22.22.0` / `>=24.0.0` 和 pnpm 11：

```bash
pnpm install   # 安装依赖（会自动构建核心包）
pnpm dev       # 启动写作台
```

然后用浏览器打开终端里显示的地址（默认 `http://127.0.0.1:5173`）。

## 开发

| 包 | 说明 |
|---|---|
| `packages/story-core` | 核心：真相（每章账单、作者裁定、设定卡、正文）、写命令（定稿、记裁定、存稿、导入）、投影；纯 TypeScript，不调模型 |
| `packages/story-engine-ui` | React 写作台 + 本地 HTTP/SSE 服务（对话 AI、编辑部、写稿流程） |
| `packages/story-engine-desktop` | Electron 桌面壳和打包（Mac 随包带精简 git，撤销不靠系统 git） |

```bash
pnpm test          # 全仓测试
pnpm typecheck     # 类型检查
pnpm build         # 构建
```

GitHub CI 在 Node.js 22 + pnpm 11 上跑这三条。测试会给每次运行单独分配临时目录、结束后只回收自己那份；要保留失败现场，设 `STORY_ENGINE_KEEP_TEST_TMP=1`。

打桌面包：`packages/story-engine-desktop/build-desktop.sh --mac`。默认包**不含**任何模型配置，打包后会用探针确认产物里没有密钥；带模型预设的内部测试包要显式确认 `SE_ALLOW_SECRET_BUNDLE=I_UNDERSTAND_KEYS_ARE_EXTRACTABLE`，产物名带 `-with-model-preset`，**绝不能公开分发**。

几条硬规矩：

- 绝不提交 `.env`、API Key 或生成的安装包
- AI 不能直接定稿或改作者写的东西：只出预览，作者点按钮才执行
- AI 说「记下了」的每一条都要带原句、由代码核实

## 许可证

[AGPL-3.0](LICENSE)。拿去改了提供网络服务，也要公开全部修改后的源码。用到的第三方软件许可在应用里「设置 → 关于 → 第三方软件许可」。
