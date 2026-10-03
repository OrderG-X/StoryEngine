<div align="center">

<img src=".github/assets/hero.svg" alt="StoryEngine — chat-driven AI long-form novel writing engine / 聊天驱动写长篇小说" width="760" />

<p>
  <a href="https://github.com/OrderG-X/StoryEngine/actions/workflows/ci.yml"><img src="https://github.com/OrderG-X/StoryEngine/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <img src="https://img.shields.io/badge/license-AGPL--3.0-8b5cf6" alt="License: AGPL-3.0" />
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2020-43853d?logo=node.js&logoColor=white" alt="Node >= 20" />
  <img src="https://img.shields.io/badge/pnpm-11-f69220?logo=pnpm&logoColor=white" alt="pnpm 11" />
  <img src="https://img.shields.io/badge/%E6%95%B0%E6%8D%AE-100%25%20%E6%9C%AC%E5%9C%B0-f59e0b" alt="数据 100% 本地" />
</p>

<p>
  <a href="README.md"><b>简体中文</b></a> ·
  <a href="README.en.md">English</a>
</p>

</div>

---

> 🚧 **持续更新中**：项目仍在快速迭代，功能会不断完善。使用中遇到任何问题、或想要新功能，欢迎到 [Issues](https://github.com/OrderG-X/StoryEngine/issues) 提过来，我们会认真看。

**聊天驱动写长篇小说。你对 AI 说话，AI 调工具读/写故事状态、生成草稿、审稿入库——所有状态变更都经过引擎的确定性校验，每步可预览、可撤销。**

*Chat-driven long-form novel writing: you direct, AI writes — deterministic state validation, preview & undo, 100% local.*

## 这是什么

不是「帮你写小说的 AI」，而是**听你指挥的 AI 编剧团队**：你当导演，AI 执笔、自查、记账。

- **对话驱动**：你动嘴，它写书。写哪、改成什么样，你全程看得见
- **长篇不崩**：写到第 200 章不失忆、不串设定——第 3 章埋的伏笔，第 30 章它还记得
- **反 AI 腔**：专门去 AI 味，治"一看就是 AI 写的"
- **联网查资料**：写作需要真实世界细节时直接说「搜一下 XX」，AI 联网检索并附来源——只当参考资料、绝不编造
- **纯本地**：你的书、草稿、设定全落在自己电脑上，数据你自己做主

核心安全边界：

- 草稿只写稿，不碰正式状态
- 提交前先预览改动，确认后才入库
- AI 审稿只是建议，改状态必须过引擎校验 + 人工确认

## 快速开始

依赖 Node.js `^20.20.0` / `^22.22.0` / `>=24.0.0` + pnpm 11。三步跑起来：

```bash
pnpm install   # 安装依赖（会自动构建核心引擎）
pnpm dev       # 启动写作工作台
```

然后浏览器打开终端里显示的地址（默认 `http://127.0.0.1:5173`）。

**配置模型（BYO-key，用你自己的 key）**：进入应用左侧「AI 设置」，添加服务商并填入 API Key
（支持任意 OpenAI 兼容接口：DeepSeek、GLM、Kimi、OpenAI 等），测试连接通过即可开始写作。
key 只保存在你本机（`~/.story-engine/`），绝不要把密钥提交进任何仓库。

> 命令行工具（`packages/story-engine-cli`）另可用环境变量 `STORY_ENGINE_LLM_API_KEY` 传 key。

## 项目结构

| 包 | 说明 |
|---|---|
| `packages/story-engine` | 核心写作状态引擎（草稿/提交/审稿/线索/钩子/目标追踪） |
| `packages/story-engine-cli` | 命令行：写稿、提交、审稿、维护、诊断 |
| `packages/story-engine-ui` | React 写作工作台 + 本地 HTTP/SSE 服务（聊天 agent 在这里） |
| `packages/story-engine-desktop` | Electron 桌面壳与打包流程 |

## 核心能力

- **快稿**：从结构化上下文生成章节草稿，不污染正式状态
- **提交预览 / 提交入库**：预览与落盘严格分离，改动可控
- **钩子池**：跟踪伏笔、异常、未解决信号
- **线索池**：短期线索与意图跟踪、去重、质量闸
- **目标池**：迷你弧 / 主线弧目标跟踪
- **连续性质检**：对近期事件、线索、目标做确定性一致性检查
- **审稿人**：AI 审稿建议 + 审稿计划生成 + 干跑报告
- **维护动作**：`mark_thread_done` 等小批量人工确认路径

## 当前禁用（暂不开放自动）

以下路径刻意禁用或视为不安全，不提供自动化：

- `merge_threads` 确认
- `drop_thread` 确认
- 自动清理 / 自动意图过期
- 自动 `mark_thread_done` / 自动 `apply-review-plan --confirm`

## 开发

```bash
pnpm test          # 全仓测试
pnpm typecheck     # 类型检查
pnpm build         # 构建
```

单独包：

```bash
pnpm --filter @actalk/story-engine test
pnpm --filter @actalk/story-engine typecheck
pnpm --filter @actalk/story-engine-cli test
pnpm --filter @actalk/story-engine-cli typecheck
```

GitHub CI 在 Node.js 22 + pnpm 11 上跑这三条工作区命令。

工作区与单包的 `pnpm test` 会为本次测试单独分配系统临时目录，结束或正常中断后只回收本次目录，
不扫描或删除其他任务的临时数据。需要保留失败夹具排障时，可显式设置 `STORY_ENGINE_KEEP_TEST_TMP=1`；
终端会打印保留路径。直接运行 `vitest` 会绕过此运行级回收，建议使用上述测试入口。

## 桌面端

默认桌面构建**不含**任何模型配置（`preset-model-config`），并会在打包后用探针验证产物里没有密钥。带模型预设的构建是明确危险的内部测试模式：需要全部三个预设文件 + 显式确认环境变量 `SE_ALLOW_SECRET_BUNDLE=I_UNDERSTAND_KEYS_ARE_EXTRACTABLE`，产物名带 `-with-model-preset` 后缀，输出按安全模式隔离在 `dist-electron/clean/` 与 `dist-electron/with-model-preset/`。

桌面构建目前是**未签名 / 内部测试产物**。代码签名、公证、公开分发尚未完成。

## 安全说明

- 绝不提交 `.env`、API key、输出 fixture 或生成的 zip 产物
- 绝不把带模型预设的桌面产物当干净/公开构建分发——内置密钥可被提取，内部测试后必须作废
- AI 提供商不得直接修改正式故事状态
- 维护动作必须保持预览优先 + 人工确认

## 许可证

AGPL-3.0。网络服务交互也触发开源义务——谁拿去做 SaaS 转卖，必须开放其全部修改源码。
