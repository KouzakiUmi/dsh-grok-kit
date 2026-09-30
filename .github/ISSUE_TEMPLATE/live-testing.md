---
name: Live testing feedback
about: Share chat / search / Imagine results verified on a real subscription
title: "Live test: YYYY-MM-DD dsh vX.Y.Z"
---

Bilingual template. Fill what you tested; leave the rest as "untested". 双语模板：只填你实测过的项，其余留“未测”。

## Environment / 环境

- dsh-grok-kit version and installation source / 插件版本与安装来源: (e.g. 0.1.13 via npm; for GitHub installs, include the commit / 例如 npm 安装 0.1.13；GitHub 安装请附提交号)
- DeepSeek Harness version (`dsh --version`) / DSH 版本:
- Node.js version (`node --version`) / Node 版本:
- OS and version / 操作系统:
- Subscription tier, exact wording / 订阅档位（按官方原文）:
- Test date / 测试日期:

## Reproduction / 复现步骤

Minimal steps from a fresh `dsh web` session. 从新开的 `dsh web` 会话给出最小复现步骤。

## Results / 结果

Mark each as pass / fail / untested. 逐项标注通过 / 失败 / 未测。

- Chat / 聊天:
- Follow-up chat (reasoning continuation) / 连续对话（推理延续）:
- Tools (e.g. `grok_imagine`) / 工具调用:
- Search (main-turn or nested) / 搜索（主循环或嵌套）:
- Imagine / 图像生成:

## Errors / 报错

Paste error messages with the date, then redact before submitting: no tokens, no `auth.json` contents, no account email, no session ids, no private filesystem paths, no private conversation content. 粘贴报错时注明日期，并先脱敏：不含 token、`auth.json` 内容、账号邮箱、session id、私有路径与私密对话内容。

## Notes / 补充

- Search [existing issues](https://github.com/MaRi23333/dsh-grok-kit/issues) first; add results to a matching issue instead of opening a duplicate. 请先搜索已有 issue；有相同问题时把结果补充到原 issue，不要重复开帖。
- Do not renew a subscription just to test, and do not run destructive commands. 不要仅为测试续订，也不要执行危险命令。
