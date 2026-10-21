# Changelog

## 0.2.0（2026-10-21）第一个公开版本

方向改成「**你来写，AI 管账**」，并把整个引擎重构了一遍。[下载](https://github.com/OrderG-X/StoryEngine/releases/tag/v0.2.0)

- **重构**：新的核心包 `story-core`；真相只有四样（每章账单、作者裁定、设定卡、正文），界面和 AI 读的都是从它们重算出来的投影；定稿、裁剪历史这类作者的事只能点按钮；旧引擎和命令行工具删除
- **编辑部**：核账员跟读全书核前后矛盾，记账员写每章账单（每条带原句、代码核实），章纲员拟章纲
- **导入已写的书**：txt 切章，AI 在后台逐章补账，没补完前如实挡住核账和定稿
- **设定本**：人物 / 地点 / 物件 / 规则卡片，点字就改；AI 只能补空栏、建新卡，碰作者写的要作者点头
- **书架和设置**：回收站、整书备份恢复、导出 txt / Word / epub、用量账、备用模型
- **能交给陌生人用**：没接 AI 时分两步引导；报错说清原因（密钥不对、欠费、限流、服务商故障、网络）；Mac 包自带精简 git，撤销不靠系统 git；联网搜索改用博查 / Tavily 正式接口（作者自填 key，不再抓网页）；中文菜单、只开一个窗口、日志文件；设置里的「关于」（版本、源代码、第三方软件许可）；应用图标
- 安装包：Apple 芯片 Mac（未经苹果公证，第一次打开要在「系统设置 → 隐私与安全性」里放行）、Windows 64 位（**还没在 Windows 真机上走查过**，有问题请到 Issues 反馈）

## 2026-08-12 长篇耐力修复批 + 联网检索

- **新增 `web_search` 工具**：写作查真实世界资料（免 key、只读、附来源、诚实失败、防提示注入）
- **会话历史治理**：冷热分层（热窗口 + 只增不删的冷归档 + 用户可见的归档标记）、
  窗口纪元对账（旧页面过期副本不再覆盖热窗）、防误清守卫（空列表不得覆盖非空历史，
  根治「加载瞬时失败→自动保存清空全部聊天记录」的数据丢失地雷）、JSON body 上限 1MB→32MB
- **写作意图门（generate_draft）**：入库后模型擅自续写被确定性拦截；否定按子句作用域判定
  （「只写这一章，不要写其他章」放行、「确认定稿，下一章不要写」拦截）
- **线索维护闭环**：入库摘要确定性提醒堆积（open+touched 达阈值）→ 用户点头 → 清理/语义归并
- **题材中立**：摘除引擎里早期测试书残留的悬疑关键词表（HOOK_KEYWORDS），
  伏笔/线索全面回归「模型声明 + 证据校验」通道
- **书架修复**：时间戳不再恒显「刚刚」、最近书排序不再反转、扫描不再回滚刚改名/刚打开的条目
- 其余：聊天 markdown 分隔线假列表项、反复出场未建卡角色确定性点名、
  重载后僵尸「正在定稿…」字幕结算、keepalive 64KiB 配额守卫等

## StoryEngine v1 Candidate

This repository captures the standalone StoryEngine backend v1 candidate state.

Frozen / accepted modules:

- Radio V1.1
- Reference Matching Calibration V1
- Intent Lifecycle Diagnostics V1.1
- Maintenance Reviewer Integration V1
- `mark_thread_done` confirm path

Disabled paths:

- `merge_threads` confirm
- `drop_thread` confirm
- automatic cleanup
- automatic expiry
- automatic `mark_thread_done`
- automatic `apply-review-plan --confirm`

Current recommended next phase:

- UI / Chapter Steering
- state overview panel
- chapter preview / commit panel
- manuscript review and readback audit
- prompt cache metrics / fingerprinting before prompt reordering
