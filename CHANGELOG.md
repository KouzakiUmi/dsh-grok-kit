# 更新记录 / Changelog

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
- 维护状态说明：维护者无有效订阅的有限维护状态保持不变；在线聊天、搜索与 Imagine 行为仍需社区实测反馈。
- Maintenance notice: Limited maintenance remains in effect due to lack of an active subscription; live chat, search, and Imagine behavior continue to rely on community testing.

## 0.1.15（2026-10-04）

- 插件列表和详情页新增随 DeepSeek Harness 界面语言切换的中英文名称与简介。
- Added localized English and Chinese names and descriptions for the plugin list and detail page.
- 同步版本号、锁文件、User-Agent 和隔离安装探针。未修改 OAuth、聊天、搜索或 Imagine 行为；维护者仍缺少有效订阅，在线功能尚未复测。
- Synchronized the package, lockfile, User-Agent, and isolated-install probe versions. OAuth, chat, search, and Imagine behavior is unchanged; live features remain unverified without an active subscription.
