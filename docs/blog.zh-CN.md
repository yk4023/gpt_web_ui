# 开源一个本地 AI 网关：让 Claude Code 接入 OpenAI 模型，还能管理密钥、额度和用量

> 项目地址：[Codex Claude Gateway · GitHub](https://github.com/yk4023/gpt_web_ui)
> 关键词：Claude Code、OpenAI、Anthropic Messages、本地网关、模型映射

## 前言：多个 AI 客户端，配置却越来越乱

用 Claude Code 或其他兼容 Anthropic Messages 的工具时，你可能遇到过这些问题：每个客户端都要单独填上游凭据；不同模型的名称难以统一；想给某个应用限制调用量，却缺少一个集中管理的地方；出问题后，也很难快速看清请求去了哪里。

我把这些需求做成了一个可以在本机运行的开源项目：**Codex Claude Gateway**。它提供 Web 管理界面，把客户端的 Anthropic Messages 请求转换为 OpenAI Responses API 请求。客户端只需填写一个本地 Base URL 和网关密钥。

如果这个项目对你有帮助，欢迎到 [GitHub 仓库点个 Star ⭐](https://github.com/yk4023/gpt_web_ui)。Star 是我继续完善协议兼容和管理界面的动力。

## 它能做什么？

| 能力 | 实际用途 |
| --- | --- |
| 多模型映射 | 给不同上游模型设置客户端别名，主模型、Haiku、Sonnet、Opus 和子代理可分别选择 |
| 本地 API Key | 为不同应用生成独立密钥，支持吊销和重新启用 |
| 网关限额 | 为密钥设置每日请求数、Token 数和并发上限 |
| 使用趋势 | 按日、周、月查看本地请求数与 Token 消耗图表 |
| 配置生成 | 一键生成 Claude Code 的 `env` JSON 或 PowerShell 配置 |
| 上游连接 | 支持独立的 Sign in with ChatGPT 授权，或使用自己的 OpenAI API Key |

所有管理数据保存在本机。服务默认只监听 `127.0.0.1:8765`，不需要额外安装 npm 依赖。

## 三步跑起来

**第一步：启动网关。** 准备 Node.js 24.5+ 或 22.21+，然后在 PowerShell 中运行：

```powershell
git clone https://github.com/yk4023/gpt_web_ui.git
cd gpt_web_ui
npm start
```

打开 `http://127.0.0.1:8765`。首次启动会在 `.data/admin-token` 生成管理员令牌，读取后登录管理页：

```powershell
Get-Content .data/admin-token
```

**第二步：连接上游并配置模型。** 在页面点击“使用 ChatGPT 登录”，完成独立授权；也可以在启动前设置 `OPENAI_API_KEY`。接着查询当前账号可用模型，为客户端别名添加模型映射。例如把 `codex-luna` 映射到账号实际可用的模型 ID。初始映射只是示例，请以查询结果为准。

**第三步：生成调用密钥和客户端配置。** 创建一枚 `cg_...` 网关密钥，在“接入 Claude Code”选择各档位模型，复制页面生成的 `env JSON` 到 Claude Code 的 `settings.json`；也可以切换为 PowerShell 格式，在同一个终端启动 `claude`。

配置的核心结构如下，密钥和模型名请以你自己的管理页为准：

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "<你的网关密钥>",
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8765",
    "ANTHROPIC_MODEL": "codex-luna",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "codex-luna",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "codex-luna",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "codex-luna",
    "CLAUDE_CODE_SUBAGENT_MODEL": "codex-luna",
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS": "983616"
  }
}
```

如果已有 `settings.json`，请把生成的 `env` 字段合并进去。上下文数值可以编辑，但它不会增加上游模型的真实容量。

## 使用趋势到底统计了什么？

管理页可切换**近 14 日、12 周、12 月**，查看请求数或输入与输出 Token 消耗。每日汇总保存在本地，即使最近请求列表只保留 100 条，后续周、月图表仍可持续统计。

这里有个重要区别：**图表和“剩余额度”只统计经过本地网关的请求及你设置的网关限额，不是 ChatGPT 账号的官方余额。** 当前授权无法读取账号真实剩余额度，管理页提供了 ChatGPT 官方用量页入口。从旧版本升级时可接续当天已有总数，但之前未保存的历史无法补齐。

## 使用前的几个提醒

1. 这是社区项目，**不会读取或控制 Codex 桌面窗口**；上游推理使用独立授权或 OpenAI API Key。
2. Claude Code 对非 Claude 模型网关没有官方兼容承诺。项目覆盖常用文本、图片输入、工具调用和流式事件，但未实现全部 Claude 专有能力。建议先用一个小任务验证自己的客户端版本。
3. 网关密钥、管理员令牌和授权回调链接都不要贴到 Issue、截图或公开仓库；`.data/` 目录也不要上传。服务不要直接暴露到公网。
4. 使用自己的 OpenAI API Key 时，调用按 OpenAI API 计费；使用 ChatGPT 授权时，模型权限与额度仍由上游决定。需要本机代理时，仓库中有配置示例，但代理不会改变服务地区要求。

## 写在最后

这个项目还在持续完善。代码、完整安装说明、测试方法和已知限制都放在 [GitHub 项目主页](https://github.com/yk4023/gpt_web_ui)。如果你想试用，欢迎 **Star ⭐ + Fork**；遇到兼容问题，也欢迎提交 Issue，附上去除密钥和个人信息后的复现步骤。

**项目地址：https://github.com/yk4023/gpt_web_ui**
