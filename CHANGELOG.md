# 更新记录 / Changelog

## 未发布 / Unreleased

- 设置按账号、模型、搜索与对话、媒体与任务、网络分页；公共状态与导航固定在顶部，分页保存和重置不影响其他页草稿。
- Settings now separate Account, Models, Search & chat, Media & tasks, and Network with sticky shared status/navigation and page-scoped option saves/resets.
- 账号页读取官方共享订阅额度，复用 OAuth 与代理；成功结果按账号缓存 60 秒，不估算未报告的额度或余额。
- Account reads official shared subscription quota using existing OAuth/proxy, with a 60-second account-scoped successful-result cache and no fabricated usage or balances.
- 保留视频默认关闭、账号隔离与不自动重复提交的计费边界；此前复审修复已覆盖凭据等待截止、查询能力状态及未知状态脱敏。
- Video remains opt-in, account-isolated and never automatically resubmitted; review fixes cover credential deadlines, poll capability states and sanitized unknown status diagnostics.

## 0.2.2（2026-10-12）

- 修复暗色模式下登录主按钮文字不清晰的问题，文字颜色跟随宿主主题。
- Fixed unreadable text on the primary sign-in button in dark mode; its text color now follows the host theme.
- 修复“全部显示”将模型列表收窄为一个模型的问题；现在显示所有可聊天模型，重启后仍保留这一选择。图片和搜索专用模型继续从聊天选择器过滤。
- Fixed “Show all” narrowing the model list to a single model; all chat models are now shown, and the selection survives restarts. Image and search-only models remain excluded from the chat picker.
- 已保存的单模型选择不会自动改变；遇到列表被收窄时，可在设置页点击“全部显示”。宿主支持范围不变。
- Existing single-model selections are not changed automatically; click “Show all” in Settings if your list was narrowed. Host support is unchanged.

## 0.2.1（2026-10-11）

- 聊天流显式跟踪终止事件：正常结束或重试结束后不再尝试补发错误；缺少终止事件的异常流仍会以错误结束。
- Chat streams now track terminal events explicitly: completed responses and retries no longer attempt to append an extra error, while streams missing a terminal event still end with an error.
- 图片编辑失败卡片显示“图片编辑失败”，与图片生成失败区分，并同步读屏标签。
- Failed image edits now show “图片编辑失败”, distinct from generation failures, with a matching accessibility label.
- 再次编辑时统一去除图片来源的首尾空白，确保长度判断和发送给 Agent 的来源一致。
- Source-image references are trimmed before re-editing so length checks and the references sent to the agent remain consistent.
- 缓存会话图片卡片的数据订阅源，减少重复获取；清理不影响现有行为的冗余分支。
- Session image cards cache their subscription source to avoid repeated lookups; redundant branches were removed without changing their existing behavior.
- 更新项目简介和安装说明；宿主支持范围与 0.2.0 相同。
- Updated the project description and installation notes; host support is unchanged from 0.2.0.

## 0.2.0（2026-10-10）

- 宿主环境升级：冻结支持 DeepSeek Harness `0.2.0-rc.2` 与 `@earendil-works/pi-ai@0.87.1`（Node 22/24）；正式停止对旧 0.1 宿主线的兼容支持。
- Host environment upgrade: Pinned support to DeepSeek Harness `0.2.0-rc.2` and `@earendil-works/pi-ai@0.87.1` (Node 22/24); dropped compatibility with the legacy 0.1 host line.
- 图生图工具：新增 `grok_imagine_edit` 工具（POST `/v1/images/edits`），复用主 OAuth session。支持本地文件路径（按宿主环境权限有界读取）、会话附件完整引用、data URI 与远程 URL，单次请求最多支持 5 张输入图片。
- Image-to-image editing: Added the `grok_imagine_edit` tool (POST `/v1/images/edits`), reusing the main OAuth session. Supports local filesystem paths (bounded by host environment permissions), full session attachment references, data URIs, and remote URLs, accepting up to 5 source images per request.
- 会话图片交互卡片：`grok_imagine` 与 `grok_imagine_edit` 结果均直接渲染在会话图片卡片中，展示提示词、输入来源与结果图，并提供下载与再次生成/编辑入口；两工具输出统一保存至 DSH 附件库并保留归一化 metadata，两工具的 `save_path` 均不再直接写盘。
- Session image interaction cards: Both `grok_imagine` and `grok_imagine_edit` results render directly inside session image cards showing prompt, input sources, and output images, with download and re-generate/re-edit actions. Tool outputs are saved to the DSH attachment library preserving normalized metadata; direct disk writing via `save_path` is no longer supported for either tool.
- 配置项扩充：新增 `editTool`（默认开启）、`editModel`（默认跟随线上目录自动选择）、`editMaxSourceImages`（默认 5）和 `editMaxImageBytes`（默认 20 MiB）。
- New configuration options: Added `editTool` (default true), `editModel` (default auto-catalog), `editMaxSourceImages` (default 5), and `editMaxImageBytes` (default 20 MiB).
- 搜索与契约适配：主循环网页与 X 融合搜索默认保持关闭（可在设置页开启），对齐 DSH 0.2.0-rc.2 宿主环境下的 context 处理与流式契约。
- Search and protocol alignment: Web and X fused search remains off by default (opt-in via Settings); aligned context contracts and streaming behavior with DSH 0.2.0-rc.2.
- 稳定性修复：登录/登出等待进行中的操作，刷新等待者可独立取消；完善异常流终结、错误脱敏和已保存空代理的关闭行为。
- Stability fixes: Sign-in and sign-out wait for pending operations, refresh waiters can cancel independently, and terminal stream errors, diagnostic redaction, and saved empty-proxy overrides are handled more reliably.
- 锁回收机制对齐：遵循官方 `@deepseek-ai/dsh-atomic-write@0.2.0-rc.2` 机制，在同机且同一 PID 命名空间下通过 claim 文件与二次存活性校验自动回收已退出进程遗留的写锁；活进程锁与无法验证的锁保持等待超时，不支持跨机器或跨容器挂载共用凭据锁目录。
- Lock recovery alignment: Aligned with the official `@deepseek-ai/dsh-atomic-write@0.2.0-rc.2` contract to automatically recover leftover writer locks from exited processes on the same host and PID namespace via claim files and double-checked liveness probes; active and unverified locks continue to wait and time out, and cross-host or cross-container shared storage directories are unsupported.

## 0.1.15（2026-10-04）

- 插件列表和详情页新增随 DeepSeek Harness 界面语言切换的中英文名称与简介。
- Added localized English and Chinese names and descriptions for the plugin list and detail page.
- 同步版本号、锁文件、User-Agent 和隔离安装探针。未修改 OAuth、聊天、搜索或 Imagine 行为。
- Synchronized the package, lockfile, User-Agent, and isolated-install probe versions. OAuth, chat, search, and Imagine behavior is unchanged.
