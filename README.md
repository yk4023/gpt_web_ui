# Codex Claude Gateway

把符合条件的 ChatGPT/Codex 套餐推理能力通过本地 Anthropic Messages API 提供给 Claude Code 等应用：使用一个账号完成授权和调用，无需为这些符合条件的请求另买 OpenAI API 额度。项目提供模型别名、本地 API Key、每日请求和 token 限额、并发限制及使用记录；服务将客户端请求转换为 OpenAI Responses API 请求。

> 这是社区项目，与 OpenAI、Anthropic 无隶属关系。

## 先了解接入边界

- **它不读取、控制或复用 Codex 桌面窗口中的对话与登录态。** Codex 桌面窗口没有公开的 Anthropic Messages 服务器接口。本项目通过 OpenAI 官方 Responses API 完成推理。
- 可在管理页完成独立的 **Sign in with ChatGPT** 授权。授权成功且账号、模型和请求符合条件时，本地应用可共用该账号的 ChatGPT 套餐用量，无需另行提供 OpenAI API Key；这不会生成额外额度。也可在启动前设置独立的 `OPENAI_API_KEY`；这时按 OpenAI API 计费，并优先使用该密钥。
- 管理页会计算每枚网关密钥的今日剩余请求和 Token；这只是**网关自行设置的用量限制**。当前授权没有可读取 ChatGPT/Codex 账号真实剩余额度的接口，页面提供 [ChatGPT 官方用量入口](https://chatgpt.com/settings/usage)。每日 token 限额在响应完成后累计，边界处可能多消耗一次请求。
- “使用趋势”图表可切换每日（近 14 日）、每周（近 12 周）、每月（近 12 月），分别查看请求数或输入与输出 Token 合计。历史汇总保存在本机 `.data/state.json`，保留约 400 天；从旧版本升级时只能继承当天密钥累计总数，无法还原此前被清理的请求记录。统计按 `GATEWAY_TIMEZONE`（默认 `Asia/Shanghai`）划分日期。
- Claude Code 官方文档允许配置 Anthropic Messages 网关，但不保证通过网关使用非 Claude 模型。这个转换器覆盖常用文本、图片输入、工具调用与流式事件；Claude 专有能力未全部实现。请先用小任务验证自己的 Claude Code 版本。

## 运行环境

Node.js 24.5+ 或 22.21+。项目只使用 Node 标准库，不需要安装 npm 依赖。

在 PowerShell 中：

```powershell
git clone https://github.com/yk4023/gpt_web_ui.git
cd gpt_web_ui
npm start
```

默认管理页与 Base URL：`http://127.0.0.1:8765`。服务只监听本机回环地址。首次启动会生成 `.data/admin-token`；在 PowerShell 中运行以下命令，复制令牌并在管理页登录：

```powershell
Get-Content '.data/admin-token'
```

然后在管理页依次：

1. 点击“使用 ChatGPT 登录”，在 OpenAI 官方页面选择账号并授权使用 ChatGPT 方案。授权完成后返回管理页。也可以跳过此步，改用下面的 API Key 模式。
2. 点击“查询可用模型”，在“模型映射”中添加任意多行客户端别名与上游模型 ID，并保存。默认映射只是初始示例，不能保证账号有此模型。
3. 创建网关调用密钥，设置每日请求、每日 token 和并发上限。密钥只显示一次。
4. 在“接入 Claude Code”选择主模型、Haiku/Sonnet/Opus 默认模型和子代理模型，填入刚创建的密钥。复制 `env JSON` 到 Claude Code 的 `settings.json`，或切换为 PowerShell 格式并在同一终端运行 `claude`。

API Key 上游模式：在启动网关的终端先设置 `OPENAI_API_KEY`，然后运行 `npm start`。不要把上游密钥填入 Claude Code；Claude Code 只使用网关生成的 `cg_...` 密钥。

```powershell
$env:OPENAI_API_KEY = '<你的 OpenAI API Key>'
npm start
```

本机需要通过代理访问上游时，可复制 [`config/network.example.json`](config/network.example.json) 到 `.data/network.json` 并修改地址，或在启动前设置 `GATEWAY_PROXY_URL`（环境变量优先）。代理只接受本机 HTTP/HTTPS 地址；授权、模型查询和推理请求都会使用它，本地管理页和 Claude Code 到网关的连接仍走回环地址。请只在符合 OpenAI 服务地区与网络政策的环境中使用。

```powershell
New-Item -ItemType Directory -Force .data | Out-Null
Copy-Item config/network.example.json .data/network.json
```

Claude Code `settings.json` 示例（管理页按所选模型自动生成）：

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "<管理页生成的 cg_... 密钥>",
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

`codex-luna` 必须先在模型映射中保存；`983616` 是可编辑的客户端配置值，不能扩大上游模型的实际上下文容量。如果 `settings.json` 已有其他配置，请将生成的 `env` 字段合并到现有 JSON 对象中。

也可以选择 PowerShell 格式：

```powershell
$env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:8765'
$env:ANTHROPIC_AUTH_TOKEN = '<管理页生成的 cg_... 密钥>'
$env:ANTHROPIC_MODEL = 'codex-sol'
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL = 'codex-sol'
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = 'codex-sol'
$env:ANTHROPIC_DEFAULT_OPUS_MODEL = 'codex-sol'
$env:CLAUDE_CODE_SUBAGENT_MODEL = 'codex-sol'
claude
```

## 接口与数据

| 接口 | 用途 |
| --- | --- |
| `POST /v1/messages` | Anthropic Messages 文本、图片输入、函数工具及 SSE 响应 |
| `POST /v1/messages/count_tokens` | 本地字符估算；不代表上游精确计费 |
| `GET /v1/models` | 当前网关密钥允许的模型别名 |
| `GET /health` | 运行状态 |
| `/admin/api/*` | 管理页调用，需 `X-Admin-Token` |

管理页可创建与吊销密钥、修改模型映射、查看日志和切换已授权的 ChatGPT 账号。密钥只保存 SHA-256 摘要；管理员令牌、用量数据、OAuth 凭据保存在 `.data/`，该目录已加入 `.gitignore`。不要公开 `.data/`，也不要把本地端口直接暴露到公网。

## 授权失败排查

如果回调页显示 `HTTP 403 (unsupported_country_region_territory)`，OpenAI 拒绝了当前网络出口地区的令牌请求。这是上游地区限制，重新使用同一个回调链接或授权码不会解决；请核对 [OpenAI API 支持地区](https://developers.openai.com/api/docs/supported-countries) 和实际网络出口。其他错误请保留页面显示的错误码和 request ID 排查，不要分享回调 URL 中的一次性授权码。

## 测试

```powershell
npm test
node scripts/claude-smoke.mjs
```

测试使用本地模拟上游，覆盖 Messages 转换、工具调用流式事件、配额、管理员创建密钥、OAuth 令牌校验与刷新。第二条命令还会调用本机已安装的 Claude Code CLI，检查一次读取文件的工具调用与结果回传；不使用 OpenAI/ChatGPT 额度。真实账号推理仍需完成登录后验证。

提交改进前请阅读[贡献指南](CONTRIBUTING.md)。

## 设计依据

- [OpenAI：Sign in with ChatGPT 快速入门](https://developers.openai.com/siwc/quickstart)
- [OpenAI：本地应用的注册与登录](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [OpenAI：模型与 Responses API 推理要求](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [OpenAI：预览阶段限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Claude Code：网关兼容格式](https://code.claude.com/docs/en/llm-gateway-protocol)

## 许可证

[MIT](LICENSE)
